// Blends predictions + schedules into a unified departure list for station boards.
import type { MbtaClient } from "../mbta/client";
import type { MbtaPrediction, MbtaSchedule, MbtaTrip } from "../models/mbta";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import type { JsonApiResource } from "../models/jsonApi";
import { ensureArray } from "../utils/collections";
import { parseTimestamp } from "../utils/time";
import { logger } from "../utils/logger";

const traceEnabled = process.env.BOARD_TRACE === "1";
const trace = (event: string, meta: Record<string, unknown>) => {
  if (!traceEnabled) return;
  logger.debug(`[board-trace] ${event}`, meta);
};

const extractTrips = (included: JsonApiResource<any>[] | undefined): MbtaTrip[] =>
  ensureArray(included)
    .filter((item) => item.type === "trip")
    .map((item) => item as unknown as MbtaTrip);

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
  vehicleId?: string | null;
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
const SCHEDULE_CACHE_TTL_MS = Number(process.env.SCHEDULE_CACHE_TTL_MS ?? "30000");
const MAX_BATCH_SCHEDULE_LIMIT = 1000;
const STOP_BATCH_SIZE = 12;
const SERVICE_TIMEZONE = process.env.MBTA_TIMEZONE ?? "America/New_York";

let scheduleTimeFormatter: Intl.DateTimeFormat | null = null;
try {
  scheduleTimeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: SERVICE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
} catch {
  scheduleTimeFormatter = null;
}

const formatToHhMm = (value: Date): string => {
  if (scheduleTimeFormatter) {
    return scheduleTimeFormatter.format(value);
  }
  return value.toISOString().substring(11, 16);
};

type ScheduleCacheEntry = {
  schedules: MbtaSchedule[];
  trips: MbtaTrip[];
  fetchedAt: number;
};

const scheduleCache = new Map<string, ScheduleCacheEntry>();

const buildScheduleCacheKey = (stopId: string, minTimeStr: string, maxTimeStr: string) =>
  `${stopId}:${minTimeStr}:${maxTimeStr}`;

const getScheduleCache = (key: string): ScheduleCacheEntry | null => {
  const entry = scheduleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SCHEDULE_CACHE_TTL_MS) {
    scheduleCache.delete(key);
    return null;
  }
  return entry;
};

const setScheduleCache = (key: string, schedules: MbtaSchedule[], trips: MbtaTrip[]) => {
  scheduleCache.set(key, { schedules, trips, fetchedAt: Date.now() });
};

const chunkStops = (stopIds: string[], size = STOP_BATCH_SIZE) => {
  const chunks: string[][] = [];
  for (let i = 0; i < stopIds.length; i += size) {
    chunks.push(stopIds.slice(i, i + size));
  }
  return chunks;
};

const blendDeparturesForStop = (
  stopId: string,
  schedules: MbtaSchedule[],
  predictions: MbtaPrediction[],
  schedulesTrips: MbtaTrip[],
  predictionsTrips: MbtaTrip[],
  options: BlendOptions,
  now: Date,
): BlendedDeparture[] => {
  const predictionMap = new Map<string, MbtaPrediction>();

  predictions.forEach((prediction) => {
    const key = buildPredictionKey(prediction);
    if (key) {
      predictionMap.set(key, prediction);
    }
  });

  const schedulesIncluded: JsonApiResource<any>[] = schedulesTrips;
  const predictionsIncluded: JsonApiResource<any>[] = predictionsTrips;

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
    const vehicleId = extractFirstRelationshipId(prediction?.relationships?.vehicle) ?? null;
    const headsignValue =
      findTripHeadsign(tripId, schedulesIncluded) ??
      findTripHeadsign(extractFirstRelationshipId(prediction?.relationships?.trip), predictionsIncluded) ??
      schedule.attributes.stop_headsign;

    const row: BlendedDeparture = {
      stopId,
      routeId: extractFirstRelationshipId(schedule.relationships?.route) ?? null,
      directionId: (prediction?.attributes.direction_id ??
        schedule.attributes.direction_id ??
        null) as 0 | 1 | null,
      tripId,
      ...(vehicleId ? { vehicleId } : {}),
      stopSequence: schedule.attributes.stop_sequence ?? prediction?.attributes.stop_sequence ?? null,
      ...(headsignValue ? { headsign: headsignValue } : {}),
      scheduledTime: schedule.attributes.departure_time ?? schedule.attributes.arrival_time ?? null,
      predictedTime: prediction?.attributes.departure_time ?? prediction?.attributes.arrival_time ?? null,
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
    const vehicleId = extractFirstRelationshipId(prediction.relationships?.vehicle) ?? null;
    const headsignValue = findTripHeadsign(tripId, predictionsIncluded);

    const row: BlendedDeparture = {
      stopId,
      routeId: extractFirstRelationshipId(prediction.relationships?.route) ?? null,
      directionId: (prediction.attributes.direction_id ?? null) as 0 | 1 | null,
      tripId,
      ...(vehicleId ? { vehicleId } : {}),
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

  const minDate = new Date(now.getTime() + (options.minLookaheadMinutes ?? DEFAULT_MIN_LOOKAHEAD_MINUTES) * 60 * 1000);
  const maxDate = new Date(now.getTime() + (options.maxLookaheadMinutes ?? DEFAULT_MAX_LOOKAHEAD_MINUTES) * 60 * 1000);
  const minTimestampMs = minDate.getTime();
  const maxTimestampMs = maxDate.getTime();

  return rows
    .filter((row) => {
      if (row.finalTime === null) return false;
      const finalTs = parseTimestamp(row.finalTime);
      if (finalTs == null) return false;
      return finalTs >= minTimestampMs && finalTs <= maxTimestampMs;
    })
    .sort((a, b) => {
      const aTs = parseTimestamp(a.finalTime);
      const bTs = parseTimestamp(b.finalTime);
      if (aTs == null || bTs == null) return 0;
      return aTs - bTs;
    });
};

export const fetchBlendedDepartures = async (
  client: MbtaClient,
  stopId: string,
  options: BlendOptions = {},
): Promise<BlendedDeparture[]> => {
  const startMs = Date.now();
  const now = options.now ?? new Date();
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const minLookaheadMinutes = options.minLookaheadMinutes ?? DEFAULT_MIN_LOOKAHEAD_MINUTES;
  const maxLookaheadMinutes = options.maxLookaheadMinutes ?? DEFAULT_MAX_LOOKAHEAD_MINUTES;
  const minDate = new Date(now.getTime() + minLookaheadMinutes * 60 * 1000);
  const maxDate = new Date(now.getTime() + maxLookaheadMinutes * 60 * 1000);
  const minTimeStr = formatToHhMm(minDate);
  const maxTimeStr = formatToHhMm(maxDate);

  const scheduleCacheKey = buildScheduleCacheKey(stopId, minTimeStr, maxTimeStr);
  const cachedSchedules = getScheduleCache(scheduleCacheKey);
  let scheduleFetchMs = 0;
  let predictionFetchMs = 0;

  const [scheduleResponse, predictionResponse] = await Promise.all([
    cachedSchedules
      ? Promise.resolve(null)
      : (async () => {
          const fetchStart = Date.now();
          const response = await client.getSchedules({
            "filter[stop]": stopId,
            min_time: minTimeStr,
            max_time: maxTimeStr,
            include: "trip,route,stop",
            "page[limit]": options.maxResults ?? 200,
          });
          scheduleFetchMs = Date.now() - fetchStart;
          return response;
        })(),
    (async () => {
      const fetchStart = Date.now();
      const response = await client.getPredictions({
        "filter[stop]": stopId,
        include: "trip,route,stop",
        "page[limit]": options.maxResults ?? 200,
      });
      predictionFetchMs = Date.now() - fetchStart;
      return response;
    })(),
  ]);

  const schedules = cachedSchedules?.schedules ?? ensureArray(scheduleResponse?.data) as MbtaSchedule[];
  const schedulesTrips = cachedSchedules?.trips ?? extractTrips(scheduleResponse?.included);
  if (!cachedSchedules) {
    setScheduleCache(scheduleCacheKey, schedules, schedulesTrips);
  }

  const predictions = ensureArray(predictionResponse.data) as MbtaPrediction[];
  const predictionsTrips = extractTrips(predictionResponse.included);

  const blendStart = Date.now();
  const blended = blendDeparturesForStop(stopId, schedules, predictions, schedulesTrips, predictionsTrips, options, now);
  const blendMs = Date.now() - blendStart;
  trace("blend-stop", {
    stopId,
    cacheHit: Boolean(cachedSchedules),
    scheduleFetchMs,
    predictionFetchMs,
    blendMs,
    schedulesCount: schedules.length,
    predictionsCount: predictions.length,
    totalMs: Date.now() - startMs,
  });
  return blended;
};

export const fetchBlendedDeparturesForStops = async (
  client: MbtaClient,
  stopIds: string[],
  options: BlendOptions = {},
): Promise<Map<string, BlendedDeparture[]>> => {
  const startMs = Date.now();
  const now = options.now ?? new Date();
  const minLookaheadMinutes = options.minLookaheadMinutes ?? DEFAULT_MIN_LOOKAHEAD_MINUTES;
  const maxLookaheadMinutes = options.maxLookaheadMinutes ?? DEFAULT_MAX_LOOKAHEAD_MINUTES;
  const minDate = new Date(now.getTime() + minLookaheadMinutes * 60 * 1000);
  const maxDate = new Date(now.getTime() + maxLookaheadMinutes * 60 * 1000);
  const minTimeStr = formatToHhMm(minDate);
  const maxTimeStr = formatToHhMm(maxDate);
  const perStopLimit = options.maxResults ?? 200;

  const uniqueStops = Array.from(new Set(stopIds)).filter(Boolean);
  const scheduleByStop = new Map<string, MbtaSchedule[]>();
  const scheduleTripsByStop = new Map<string, MbtaTrip[]>();
  const stopsNeedingSchedules: string[] = [];

  uniqueStops.forEach((stopId) => {
    const cacheKey = buildScheduleCacheKey(stopId, minTimeStr, maxTimeStr);
    const cached = getScheduleCache(cacheKey);
    if (cached) {
      scheduleByStop.set(stopId, cached.schedules);
      scheduleTripsByStop.set(stopId, cached.trips);
    } else {
      stopsNeedingSchedules.push(stopId);
    }
  });

  let scheduleFetchMsTotal = 0;
  let scheduleBatchCount = 0;
  for (const batch of chunkStops(stopsNeedingSchedules)) {
    const fetchStart = Date.now();
    const scheduleResponse = await client.getSchedules({
      "filter[stop]": batch.join(","),
      min_time: minTimeStr,
      max_time: maxTimeStr,
      include: "trip,route,stop",
      "page[limit]": Math.min(MAX_BATCH_SCHEDULE_LIMIT, perStopLimit * batch.length),
    });
    scheduleFetchMsTotal += Date.now() - fetchStart;
    scheduleBatchCount += 1;

    const schedules = ensureArray(scheduleResponse.data) as MbtaSchedule[];
    const includedTrips = extractTrips(scheduleResponse.included);
    const tripMap = new Map(includedTrips.map((trip) => [trip.id, trip]));
    const groupedSchedules = new Map<string, MbtaSchedule[]>();

    schedules.forEach((schedule) => {
      const scheduleStopId = extractFirstRelationshipId(schedule.relationships?.stop);
      if (!scheduleStopId) return;
      const existing = groupedSchedules.get(scheduleStopId) ?? [];
      existing.push(schedule);
      groupedSchedules.set(scheduleStopId, existing);
    });

    batch.forEach((stopId) => {
      const stopSchedules = groupedSchedules.get(stopId) ?? [];
      const tripIds = new Set(
        stopSchedules
          .map((schedule) => extractFirstRelationshipId(schedule.relationships?.trip))
          .filter((tripId): tripId is string => Boolean(tripId)),
      );
      const stopTrips = Array.from(tripIds)
        .map((tripId) => tripMap.get(tripId))
        .filter((trip): trip is MbtaTrip => Boolean(trip));
      scheduleByStop.set(stopId, stopSchedules);
      scheduleTripsByStop.set(stopId, stopTrips);
      setScheduleCache(buildScheduleCacheKey(stopId, minTimeStr, maxTimeStr), stopSchedules, stopTrips);
    });
  }

  const predictionsByStop = new Map<string, MbtaPrediction[]>();
  let predictionsTrips: MbtaTrip[] = [];
  let predictionFetchMsTotal = 0;
  let predictionBatchCount = 0;
  for (const batch of chunkStops(uniqueStops)) {
    const fetchStart = Date.now();
    const predictionResponse = await client.getPredictions({
      "filter[stop]": batch.join(","),
      include: "trip,route,stop",
      "page[limit]": Math.min(MAX_BATCH_SCHEDULE_LIMIT, perStopLimit * batch.length),
    });
    predictionFetchMsTotal += Date.now() - fetchStart;
    predictionBatchCount += 1;
    const predictions = ensureArray(predictionResponse.data) as MbtaPrediction[];
    const includedTrips = extractTrips(predictionResponse.included);
    predictionsTrips = predictionsTrips.concat(includedTrips);
    predictions.forEach((prediction) => {
      const predictionStopId = extractFirstRelationshipId(prediction.relationships?.stop);
      if (!predictionStopId) return;
      const existing = predictionsByStop.get(predictionStopId) ?? [];
      existing.push(prediction);
      predictionsByStop.set(predictionStopId, existing);
    });
  }

  const results = new Map<string, BlendedDeparture[]>();
  const blendStart = Date.now();
  uniqueStops.forEach((stopId) => {
    const schedules = scheduleByStop.get(stopId) ?? [];
    const scheduleTrips = scheduleTripsByStop.get(stopId) ?? [];
    const predictions = predictionsByStop.get(stopId) ?? [];
    results.set(
      stopId,
      blendDeparturesForStop(stopId, schedules, predictions, scheduleTrips, predictionsTrips, options, now),
    );
  });
  const blendMs = Date.now() - blendStart;
  trace("blend-batch", {
    stopCount: uniqueStops.length,
    cachedScheduleCount: uniqueStops.length - stopsNeedingSchedules.length,
    scheduleFetchMs: scheduleFetchMsTotal,
    scheduleBatches: scheduleBatchCount,
    predictionFetchMs: predictionFetchMsTotal,
    predictionBatches: predictionBatchCount,
    blendMs,
    totalMs: Date.now() - startMs,
  });

  return results;
};
