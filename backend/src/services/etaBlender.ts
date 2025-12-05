import type { MbtaClient } from "../mbta/client";
import type { MbtaPrediction, MbtaSchedule, MbtaTrip } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import type { JsonApiResource } from "../models/jsonApi";

const ensureArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const findTripHeadsign = (tripId: string | null, included: JsonApiResource<any>[] | undefined): string | null => {
  if (!tripId || !included) return null;
  const trip = included.find((item) => item.type === "trip" && item.id === tripId) as MbtaTrip | undefined;
  return trip?.attributes?.headsign ?? null;
};

export type EtaSource = "prediction" | "schedule" | "blended" | "unknown";
export type ServiceStatus =
  | "on_time"
  | "delayed"
  | "cancelled"
  | "skipped"
  | "no_service"
  | "unknown";

export interface BlendedDeparture {
  stopId: string;
  stopName?: string;
  routeId: string | null;
  directionId: 0 | 1 | null;
  tripId: string | null;
  stopSequence: number | null;
  headsign?: string;
  scheduledTime: string | null;
  predictedTime: string | null;
  finalTime: string | null;
  etaMinutes: number | null;
  etaSource: EtaSource;
  status: ServiceStatus;
  discrepancyMinutes: number | null;
}

export interface BlendOptions {
  now?: Date;
  windowMinutes?: number;
  maxResults?: number;
  stopName?: string;
  maxLookaheadMinutes?: number;
  minLookaheadMinutes?: number;
}

const computeMinutesDiff = (from: number, to: number | null): number | null => {
  if (to == null) return null;
  return Math.round((to - from) / 60000);
};

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const deriveStatus = (prediction: MbtaPrediction | null, scheduleOnly: boolean): ServiceStatus => {
  if (!prediction) {
    return scheduleOnly ? "on_time" : "unknown";
  }

  const raw = prediction.attributes.status?.toLowerCase() ?? "";
  if (raw.includes("delay")) return "delayed";
  if (raw.includes("cancel")) return "cancelled";
  if (raw.includes("skip")) return "skipped";
  if (raw.includes("no service")) return "no_service";
  if (raw.includes("hold")) return "delayed";
  return "on_time";
};

const buildKey = (
  tripId: string | null,
  stopId: string | null,
  stopSequence: number | null | undefined,
): string | null => {
  if (!tripId || !stopId || stopSequence == null) return null;
  return `${tripId}-${stopId}-${stopSequence}`;
};

const buildScheduleKey = (schedule: MbtaSchedule): string | null => {
  const tripId = extractFirstRelationshipId(schedule.relationships?.trip) ?? null;
  const stopId = extractFirstRelationshipId(schedule.relationships?.stop) ?? null;
  return buildKey(tripId, stopId, schedule.attributes.stop_sequence);
};

const buildPredictionKey = (prediction: MbtaPrediction): string | null => {
  const tripId = extractFirstRelationshipId(prediction.relationships?.trip) ?? null;
  const stopId = extractFirstRelationshipId(prediction.relationships?.stop) ?? null;
  return buildKey(tripId, stopId, prediction.attributes.stop_sequence);
};

const DEFAULT_WINDOW_MINUTES = 90;
const DEFAULT_MAX_LOOKAHEAD_MINUTES = 30;
const DEFAULT_MIN_LOOKAHEAD_MINUTES = -2;

export const fetchBlendedDepartures = async (
  client: MbtaClient,
  stopId: string,
  options: BlendOptions = {},
): Promise<BlendedDeparture[]> => {
  const now = options.now ?? new Date();
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const minLookaheadMinutes = options.minLookaheadMinutes ?? DEFAULT_MIN_LOOKAHEAD_MINUTES;
  const maxLookaheadMinutes = options.maxLookaheadMinutes ?? DEFAULT_MAX_LOOKAHEAD_MINUTES;
  const minDate = new Date(now.getTime() + minLookaheadMinutes * 60 * 1000);
  const maxDate = new Date(now.getTime() + maxLookaheadMinutes * 60 * 1000);
  const formatToHhMm = (value: Date) => value.toISOString().substring(11, 16); // HH:MM in UTC
  const minTimeStr = formatToHhMm(minDate);
  const maxTimeStr = formatToHhMm(maxDate);

  const [scheduleResponse, predictionResponse] = await Promise.all([
    client.getSchedules({
      "filter[stop]": stopId,
      min_time: minTimeStr,
      max_time: maxTimeStr,
      include: "trip,route,stop",
      "page[limit]": options.maxResults ?? 200,
    }),
    client.getPredictions({
      "filter[stop]": stopId,
      include: "trip,route,stop",
      "page[limit]": options.maxResults ?? 200,
    }),
  ]);

  const schedules = ensureArray(scheduleResponse.data) as MbtaSchedule[];
  const predictions = ensureArray(predictionResponse.data) as MbtaPrediction[];
  const schedulesIncluded = scheduleResponse.included;
  const predictionsIncluded = predictionResponse.included;
  const predictionMap = new Map<string, MbtaPrediction>();

  predictions.forEach((prediction) => {
    const key = buildPredictionKey(prediction);
    if (key) {
      predictionMap.set(key, prediction);
    }
  });

  const nowMs = now.getTime();
  const rows: BlendedDeparture[] = schedules.map((schedule) => {
    const key = buildScheduleKey(schedule);
    const prediction = key ? predictionMap.get(key) ?? null : null;
    if (key && prediction) {
      predictionMap.delete(key);
    }

    const scheduledTs =
      parseTimestamp(schedule.attributes.departure_time) ??
      parseTimestamp(schedule.attributes.arrival_time);
    const predictedTs =
      parseTimestamp(prediction?.attributes.departure_time ?? null) ??
      parseTimestamp(prediction?.attributes.arrival_time ?? null);
    const finalTs = predictedTs ?? scheduledTs;

    const tripId = extractFirstRelationshipId(schedule.relationships?.trip) ?? null;
    const headsignValue = findTripHeadsign(tripId, schedulesIncluded) ?? 
                     findTripHeadsign(extractFirstRelationshipId(prediction?.relationships?.trip), predictionsIncluded) ?? 
                     schedule.attributes.stop_headsign;

    const row: BlendedDeparture = {
      stopId,
      routeId: extractFirstRelationshipId(schedule.relationships?.route) ?? null,
      directionId: (prediction?.attributes.direction_id ??
        schedule.attributes.direction_id ??
        null) as 0 | 1 | null,
      tripId,
      stopSequence: schedule.attributes.stop_sequence ?? prediction?.attributes.stop_sequence ?? null,
      ...(headsignValue ? { headsign: headsignValue } : {}),
      scheduledTime: schedule.attributes.departure_time ?? schedule.attributes.arrival_time ?? null,
      predictedTime:
        prediction?.attributes.departure_time ?? prediction?.attributes.arrival_time ?? null,
      finalTime: finalTs ? new Date(finalTs).toISOString() : null,
      etaMinutes: computeMinutesDiff(nowMs, finalTs),
      etaSource: predictedTs ? "prediction" : scheduledTs ? "schedule" : "unknown",
      status: deriveStatus(prediction, !prediction && !!scheduledTs),
      discrepancyMinutes:
        predictedTs && scheduledTs ? computeMinutesDiff(scheduledTs, predictedTs) : null,
    };
    if (options.stopName) {
      row.stopName = options.stopName;
    }
    return row;
  });

  predictionMap.forEach((prediction) => {
    const predictedTs =
      parseTimestamp(prediction.attributes.departure_time) ??
      parseTimestamp(prediction.attributes.arrival_time);
    const tripId = extractFirstRelationshipId(prediction.relationships?.trip) ?? null;
    const headsignValue = findTripHeadsign(tripId, predictionsIncluded);
    
    const row: BlendedDeparture = {
      stopId,
      routeId: extractFirstRelationshipId(prediction.relationships?.route) ?? null,
      directionId: (prediction.attributes.direction_id ?? null) as 0 | 1 | null,
      tripId,
      stopSequence: prediction.attributes.stop_sequence ?? null,
      ...(headsignValue ? { headsign: headsignValue } : {}),
      scheduledTime: null,
      predictedTime: prediction.attributes.departure_time ?? prediction.attributes.arrival_time ?? null,
      finalTime: predictedTs ? new Date(predictedTs).toISOString() : null,
      etaMinutes: computeMinutesDiff(nowMs, predictedTs),
      etaSource: "prediction",
      status: deriveStatus(prediction, false),
      discrepancyMinutes: null,
    };
    if (options.stopName) {
      row.stopName = options.stopName;
    }
    rows.push(row);
  });

  const minTimestampMs = minDate.getTime();
  const maxTimestampMs = maxDate.getTime();

  return rows
    .filter((row) => {
      if (row.finalTime === null) return false;
      const finalTs = parseTimestamp(row.finalTime);
      if (finalTs == null) return false;
      // Filter out departures outside our actual time window
      return finalTs >= minTimestampMs && finalTs <= maxTimestampMs;
    })
    .sort((a, b) => {
      const aTs = parseTimestamp(a.finalTime);
      const bTs = parseTimestamp(b.finalTime);
      if (aTs == null || bTs == null) return 0;
      return aTs - bTs;
    });
};
