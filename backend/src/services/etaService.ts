import type { MbtaClient } from "../mbta/client";
import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaPrediction } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import type { BlendedDeparture, BlendOptions } from "./etaBlender";
import { fetchBlendedDepartures } from "./etaBlender";

const toMillis = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const interpolateTimeBetween = (
  start: { sequence: number; time: number },
  end: { sequence: number; time: number },
  sequence: number,
): number => {
  if (end.sequence === start.sequence) return start.time;
  const ratio = (sequence - start.sequence) / (end.sequence - start.sequence);
  return start.time + (end.time - start.time) * ratio;
};

const cloneDeparture = (departure: BlendedDeparture): BlendedDeparture => ({
  ...departure,
});

const computeMinutesDiff = (from: number, to: number | null): number | null => {
  if (to == null) return null;
  return Math.round((to - from) / 60000);
};

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const deriveStatusFromPrediction = (prediction: MbtaPrediction): BlendedDeparture["status"] => {
  const raw = prediction.attributes.status?.toLowerCase() ?? "";
  if (raw.includes("delay")) return "delayed";
  if (raw.includes("cancel")) return "cancelled";
  if (raw.includes("skip")) return "skipped";
  if (raw.includes("no service")) return "no_service";
  if (raw.includes("hold")) return "delayed";
  return "on_time";
};

export const interpolateDepartures = (departures: BlendedDeparture[]): BlendedDeparture[] => {
  const enriched = departures.map(cloneDeparture);
  const known = enriched
    .map((departure, index) => ({
      index,
      sequence: departure.stopSequence,
      time: toMillis(departure.finalTime),
    }))
    .filter(
      (entry): entry is { index: number; sequence: number; time: number } =>
        entry.sequence != null && entry.time != null,
    );

  enriched.forEach((departure, idx) => {
    if (departure.finalTime || departure.stopSequence == null) {
      return;
    }
    const sequence = departure.stopSequence;
    const prev = [...known].reverse().find((entry) => entry.index < idx && entry.sequence < sequence);
    const next = known.find((entry) => entry.index > idx && entry.sequence > sequence);
    if (prev && next) {
      const interpolated = interpolateTimeBetween(prev, next, sequence);
      departure.finalTime = new Date(interpolated).toISOString();
      departure.etaSource = "blended";
    } else if (departure.scheduledTime) {
      departure.finalTime = departure.scheduledTime;
    }
  });

  return enriched;
};

export interface StopEtaSnapshot {
  stopId: string;
  generatedAt: string;
  departures: BlendedDeparture[];
}

interface CachedSnapshotOptions {
  now?: Date;
  maxLookaheadMinutes?: number;
  minLookaheadMinutes?: number;
  maxResults?: number;
  stopName?: string;
}

const mapPredictionToDeparture = (
  stopId: string,
  prediction: MbtaPrediction,
  nowMs: number,
  options: CachedSnapshotOptions,
): BlendedDeparture | null => {
  const finalTs = parseTimestamp(
    prediction.attributes.departure_time ?? prediction.attributes.arrival_time ?? null,
  );
  const routeId = extractFirstRelationshipId(prediction.relationships?.route) ?? null;
  const tripId = extractFirstRelationshipId(prediction.relationships?.trip) ?? null;

  const row: BlendedDeparture = {
    stopId,
    routeId,
    directionId: (prediction.attributes.direction_id ?? null) as 0 | 1 | null,
    tripId,
    stopSequence: prediction.attributes.stop_sequence ?? null,
    scheduledTime: null,
    predictedTime: prediction.attributes.departure_time ?? prediction.attributes.arrival_time ?? null,
    finalTime: finalTs ? new Date(finalTs).toISOString() : null,
    etaMinutes: computeMinutesDiff(nowMs, finalTs),
    etaSource: "prediction",
    status: deriveStatusFromPrediction(prediction),
    discrepancyMinutes: null,
  };

  if (options.stopName) {
    row.stopName = options.stopName;
  }

  return row;
};

export const getCachedStopEtaSnapshot = (
  cache: MbtaCache,
  stopId: string,
  options: CachedSnapshotOptions = {},
): StopEtaSnapshot | null => {
  const predictionsEntry = cache.getPredictions();
  if (!predictionsEntry) {
    return null;
  }

  const predictions = predictionsEntry.data.filter((prediction) => {
    const predictionStopId = extractFirstRelationshipId(prediction.relationships?.stop);
    return predictionStopId === stopId;
  });

  if (predictions.length === 0) {
    return null;
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const minMs = nowMs + (options.minLookaheadMinutes ?? -2) * 60000;
  const maxMs = nowMs + (options.maxLookaheadMinutes ?? 30) * 60000;
  const maxResults = options.maxResults ?? 50;

  const departures = predictions
    .map((prediction) => mapPredictionToDeparture(stopId, prediction, nowMs, options))
    .filter((departure): departure is BlendedDeparture => {
      if (!departure || !departure.finalTime) return false;
      const ts = parseTimestamp(departure.finalTime);
      if (ts == null) return false;
      return ts >= minMs && ts <= maxMs;
    })
    .sort((a, b) => {
      const aTs = parseTimestamp(a.finalTime);
      const bTs = parseTimestamp(b.finalTime);
      if (aTs == null || bTs == null) return 0;
      return aTs - bTs;
    })
    .slice(0, maxResults);

  if (departures.length === 0) {
    return null;
  }

  return {
    stopId,
    generatedAt: now.toISOString(),
    departures,
  };
};

export const getStopEtaSnapshot = async (
  client: MbtaClient,
  stopId: string,
  options: BlendOptions = {},
): Promise<StopEtaSnapshot> => {
  const departures = await fetchBlendedDepartures(client, stopId, options);
  const blended = interpolateDepartures(departures);
  return {
    stopId,
    generatedAt: new Date().toISOString(),
    departures: blended,
  };
};
