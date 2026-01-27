// Builds a station board payload with cached ETA blending + optional alerts/facilities.
import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaClient } from "../mbta/client";
import type {
  GetStationBoardResponse,
  StationBoardRoutePrimary,
  StationBoardDetails,
  StationDeparture,
  StationEta,
  StationAlert,
  StationFacility,
} from "@linelight/core";
import type { BlendedDeparture } from "./etaBlender";
import { getCachedStopEtaSnapshot, getStopEtaSnapshot, type StopEtaSnapshot } from "./etaService";
import { fetchBlendedDepartures, fetchBlendedDeparturesForStops } from "./etaBlender";
import { haversineDistanceMeters } from "../utils/geo";
import { resolveBoardableParent } from "../utils/stationKind";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import { mapRouteTypeToMode } from "../utils/routeMode";
import { directionIdToLabel, isGenericDirectionLabel } from "../utils/directions";
import { parseTimestamp } from "../utils/time";
import { normalizeLabel } from "../utils/text";
import type { Mode } from "../models/domain";
import { logger } from "../utils/logger";
import type { MbtaAlert, MbtaFacility, MbtaRoute, MbtaStop } from "../models/mbta";
import { getStopsCachedLight, type DbStop } from "../db";
import { isBoardableKind, resolveStationKind } from "../utils/stationKind";

const traceEnabled = process.env.BOARD_TRACE === "1";
const trace = (event: string, meta: Record<string, unknown>) => {
  if (!traceEnabled) return;
  logger.debug(`[board-trace] ${event}`, meta);
};

type BoardCacheEntry = {
  timestamp: number;
  response: GetStationBoardResponse;
};

const BOARD_CACHE_TTL_MS = 20_000;
const BOARD_CACHE_MAX_ENTRIES = 400;
const boardCache = new Map<string, BoardCacheEntry>();

const getBoardCacheKey = (stopId: string, includeAlerts: boolean, includeFacilities: boolean) =>
  `${stopId}|a:${includeAlerts ? 1 : 0}|f:${includeFacilities ? 1 : 0}`;

const getCachedBoard = (key: string): GetStationBoardResponse | null => {
  const entry = boardCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > BOARD_CACHE_TTL_MS) {
    boardCache.delete(key);
    return null;
  }
  return entry.response;
};

const setCachedBoard = (key: string, response: GetStationBoardResponse) => {
  boardCache.set(key, { timestamp: Date.now(), response });
  if (boardCache.size <= BOARD_CACHE_MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  boardCache.forEach((entry, entryKey) => {
    if (entry.timestamp < oldestTs) {
      oldestTs = entry.timestamp;
      oldestKey = entryKey;
    }
  });
  if (oldestKey) boardCache.delete(oldestKey);
};

const withDistance = (
  response: GetStationBoardResponse,
  distanceMeters?: number,
): GetStationBoardResponse => {
  if (distanceMeters == null) return response;
  return {
    ...response,
    primary: {
      ...response.primary,
      distanceMeters,
      walkMinutes: Math.round(distanceMeters / 80),
    },
  };
};

const toStationEta = (departure: BlendedDeparture): StationEta => {
  const eta: StationEta = {
    etaMinutes: departure.etaMinutes ?? null,
    source: departure.etaSource,
    status: departure.status,
  };
  if (departure.scheduledTime) {
    eta.scheduledTime = departure.scheduledTime;
  }
  if (departure.predictedTime) {
    eta.predictedTime = departure.predictedTime;
  }
  if (departure.tripId) {
    eta.tripId = departure.tripId;
  }
  return eta;
};

const resolveRouteDestination = (
  departure: BlendedDeparture,
  routesMap: Map<string, MbtaRoute>,
): string | null => {
  const explicit = normalizeLabel(departure.headsign);
  if (explicit) return explicit;
  if (!departure.routeId) return null;
  const route = routesMap.get(departure.routeId);
  if (!route) return null;
  if (departure.directionId != null) {
    const fromRoute = normalizeLabel(route.attributes.direction_destinations?.[departure.directionId] ?? null);
    if (fromRoute) {
      return fromRoute;
    }
  }
  return normalizeLabel(route.attributes.long_name) ?? normalizeLabel(route.attributes.short_name) ?? null;
};

const DETAIL_DEPARTURE_DIRECTION_LIMIT = 6;
const DETAIL_SCHEDULE_ONLY_LIMIT = 6;
const DETAIL_DEPARTURE_TOTAL_LIMIT = 60;
const DETAIL_MAX_LOOKAHEAD_MINUTES = 120;
const DETAIL_MAX_RESULTS = 140;
const SNAPSHOT_FETCH_TIMEOUT_MS = 1500;
const SNAPSHOT_BATCH_TIMEOUT_MS = 2200;
const DETAIL_SCHEDULE_TIMEOUT_MS = 2000;

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const groupDepartures = (
  departures: BlendedDeparture[],
  routesMap: Map<string, MbtaRoute>,
): StationBoardRoutePrimary[] => {
  const groups = new Map<string, BlendedDeparture[]>();
  departures.forEach((departure) => {
    const key = `${departure.routeId ?? "unknown"}-${departure.directionId ?? "na"}`;
    const existing = groups.get(key) ?? [];
    existing.push(departure);
    groups.set(key, existing);
  });

  return Array.from(groups.values()).map((group) => {
    group.sort((a, b) => (a.etaMinutes ?? Infinity) - (b.etaMinutes ?? Infinity));
    const primary = group[0];
    if (!primary) {
      return {
        routeId: "unknown",
        shortName: "Route",
        mode: "other" as Mode,
        direction: "Unknown",
        primaryEta: null,
        extraEtas: [],
      };
    }
    const route = primary.routeId ? routesMap.get(primary.routeId) : undefined;
    const mode = route ? mapRouteTypeToMode(route.attributes.type) : ("other" as Mode);
    const shortName =
      normalizeLabel(route?.attributes.short_name) ?? normalizeLabel(route?.attributes.long_name) ?? primary.routeId ?? "Route";
    return {
      routeId: primary.routeId ?? "unknown",
      shortName,
      mode,
      direction: directionIdToLabel(primary.directionId),
      primaryEta: toStationEta(primary),
      extraEtas: group.slice(1, 4).map(toStationEta),
    };
  });
};

const toStationDeparture = (
  departure: BlendedDeparture,
  routesMap: Map<string, MbtaRoute>,
  destinationFallbacks: Map<string, string>,
): StationDeparture => {
  const directionLabel = directionIdToLabel(departure.directionId);
  const destinationKey = `${departure.routeId ?? "unknown"}-${departure.directionId ?? "na"}`;
  const resolvedDestination = resolveRouteDestination(departure, routesMap);
  const fallbackDestination = destinationFallbacks.get(destinationKey) ?? null;
  const destination =
    resolvedDestination && !isGenericDirectionLabel(resolvedDestination)
      ? resolvedDestination
      : fallbackDestination ?? resolvedDestination ?? "—";
  const row: StationDeparture = {
    routeId: departure.routeId ?? "unknown",
    shortName: departure.routeId ?? "Route",
    direction: directionLabel,
    destination,
    etaMinutes: departure.etaMinutes ?? null,
    source: departure.etaSource,
    status: departure.status,
  };
  if (departure.tripId) {
    row.tripId = departure.tripId;
  }
  if (departure.vehicleId) {
    row.vehicleId = departure.vehicleId;
  }
  if (departure.scheduledTime) {
    row.scheduledTime = departure.scheduledTime;
  }
  if (departure.predictedTime) {
    row.predictedTime = departure.predictedTime;
  }
  return row;
};

const isNonBoardableStopId = (stopId: string) =>
  stopId.startsWith("node-") ||
  stopId.startsWith("entrance-") ||
  stopId.startsWith("door-") ||
  stopId.startsWith("elevator-");

const collectPlatformStopIds = (stopMap: Map<string, MbtaStop>, station: MbtaStop): string[] => {
  const ids = new Set<string>();
  if (!isNonBoardableStopId(station.id)) {
    ids.add(station.id);
  }
  stopMap.forEach((stop) => {
    const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
    if (parentId !== station.id) return;
    if (isNonBoardableStopId(stop.id)) return;
    if (!isBoardableKind(resolveStationKind(stop))) return;
    ids.add(stop.id);
  });
  return Array.from(ids);
};

const sortDeparturesByFinalTime = (departures: BlendedDeparture[]): BlendedDeparture[] => {
  return [...departures].sort((a, b) => {
    const aTs = parseTimestamp(a.finalTime);
    const bTs = parseTimestamp(b.finalTime);
    if (aTs == null && bTs == null) return 0;
    if (aTs == null) return 1;
    if (bTs == null) return -1;
    return aTs - bTs;
  });
};

const getMinuteKey = (time?: string | null): number | null => {
  if (!time) return null;
  const ts = parseTimestamp(time);
  if (ts == null) return null;
  return Math.floor(ts / 60000);
};

const pickBetterDeparture = (a: BlendedDeparture, b: BlendedDeparture): BlendedDeparture => {
  const aPred = Boolean(a.predictedTime);
  const bPred = Boolean(b.predictedTime);
  if (aPred !== bPred) return aPred ? a : b;

  const aTs =
    parseTimestamp(a.finalTime) ??
    parseTimestamp(a.predictedTime ?? null) ??
    parseTimestamp(a.scheduledTime ?? null) ??
    Infinity;
  const bTs =
    parseTimestamp(b.finalTime) ??
    parseTimestamp(b.predictedTime ?? null) ??
    parseTimestamp(b.scheduledTime ?? null) ??
    Infinity;
  if (aTs !== bTs) return aTs < bTs ? a : b;

  const aTrip = Boolean(a.tripId);
  const bTrip = Boolean(b.tripId);
  if (aTrip !== bTrip) return aTrip ? a : b;

  const aStop = a.stopSequence ?? Infinity;
  const bStop = b.stopSequence ?? Infinity;
  if (aStop !== bStop) return aStop < bStop ? a : b;

  return a;
};

const dedupeDepartures = (departures: BlendedDeparture[]): BlendedDeparture[] => {
  const byKey = new Map<string, BlendedDeparture>();
  departures.forEach((departure) => {
    const key = departure.tripId
      ? `trip:${departure.tripId}`
      : `${departure.routeId ?? "unknown"}-${departure.directionId ?? "na"}-${
          getMinuteKey(departure.finalTime ?? departure.predictedTime ?? departure.scheduledTime ?? null) ?? "na"
        }`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, departure);
      return;
    }
    byKey.set(key, pickBetterDeparture(existing, departure));
  });
  return sortDeparturesByFinalTime(Array.from(byKey.values()));
};

const ALERT_SEVERITY_MINOR_MAX = 3;
const ALERT_SEVERITY_MODERATE_MAX = 6;

const mapAlertSeverity = (severity: number | null | undefined): StationAlert["severity"] => {
  if (severity == null) return "minor";
  if (severity <= ALERT_SEVERITY_MINOR_MAX) return "minor";
  if (severity <= ALERT_SEVERITY_MODERATE_MAX) return "moderate";
  return "major";
};

type FacilityProperty = { name?: string | null; value?: unknown };

const getFacilityPropertyString = (
  properties: FacilityProperty[] | null | undefined,
  keys: string[],
): string | null => {
  if (!properties) return null;
  for (const prop of properties) {
    if (!prop?.name) continue;
    if (!keys.includes(prop.name)) continue;
    const value = prop.value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
};

const getFacilityPropertyNumber = (
  properties: FacilityProperty[] | null | undefined,
  keys: string[],
): number | null => {
  if (!properties) return null;
  for (const prop of properties) {
    if (!prop?.name) continue;
    if (!keys.includes(prop.name)) continue;
    const value = prop.value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const normalizeFacilityType = (rawType: string | null): StationFacility["type"] => {
  if (!rawType) return "other";
  const normalized = rawType.toLowerCase();
  if (normalized.includes("elevator")) return "elevator";
  if (normalized.includes("escalator")) return "escalator";
  if (normalized.includes("parking") || normalized.includes("garage")) return "parking";
  return "other";
};

const normalizeFacilitySubtype = (rawType: string | null): string | null => {
  if (!rawType) return null;
  const normalized = rawType
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^\w]/g, "")
    .replace(/_{2,}/g, "_");
  if (!normalized) return null;
  switch (normalized) {
    case "fully_elevated_platform":
      return "high_level_platform";
    case "elevated_subplatform":
      return "mini_high_platform";
    case "parking_area":
      return "parking";
    default:
      return normalized;
  }
};

const normalizeFacilityStatus = (rawStatus: string | null): StationFacility["status"] => {
  if (!rawStatus) return "unknown";
  const normalized = rawStatus.toLowerCase();
  if (normalized.includes("out_of_service") || normalized.includes("out of service") || normalized.includes("unavailable")) {
    return "unavailable";
  }
  if (normalized.includes("limited")) return "limited";
  if (normalized.includes("available") || normalized.includes("in service")) return "available";
  return "unknown";
};

type FacilityCacheEntry = {
  timestamp: number;
  facilities: StationFacility[];
};

const FACILITY_CACHE_TTL_MS = 90_000;
const FACILITY_CACHE_MAX_ENTRIES = 200;
const facilitiesCache = new Map<string, FacilityCacheEntry>();

const getFacilitiesCacheKey = (stopIds: string[]) => [...stopIds].sort().join("|");

const getCachedFacilities = (key: string): StationFacility[] | null => {
  const entry = facilitiesCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > FACILITY_CACHE_TTL_MS) {
    facilitiesCache.delete(key);
    return null;
  }
  return entry.facilities;
};

const setCachedFacilities = (key: string, facilities: StationFacility[]) => {
  facilitiesCache.set(key, { timestamp: Date.now(), facilities });
  if (facilitiesCache.size <= FACILITY_CACHE_MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  facilitiesCache.forEach((entry, entryKey) => {
    if (entry.timestamp < oldestTs) {
      oldestTs = entry.timestamp;
      oldestKey = entryKey;
    }
  });
  if (oldestKey) facilitiesCache.delete(oldestKey);
};

const mapFacility = (facility: MbtaFacility): StationFacility => {
  const props = facility.attributes?.properties ?? [];
  const typeRaw = facility.attributes?.type ?? getFacilityPropertyString(props, ["facility_type", "type"]);
  const statusRaw = getFacilityPropertyString(props, ["status", "facility_status", "facilityStatus"]);
  const alternateService = getFacilityPropertyString(props, ["alternate-service-text", "alternate_service_text"]);
  const description =
    alternateService ??
    facility.attributes?.long_name ??
    facility.attributes?.short_name ??
    getFacilityPropertyString(props, ["description", "name", "title"]);
  const capacity = getFacilityPropertyNumber(props, ["capacity", "total", "slots"]);
  const available = getFacilityPropertyNumber(props, ["available", "spaces_available", "spacesAvailable"]);
  const computedStatus = alternateService ? "unavailable" : normalizeFacilityStatus(statusRaw);
  const subtype = normalizeFacilitySubtype(typeRaw);
  return {
    id: facility.id,
    type: normalizeFacilityType(typeRaw),
    ...(subtype ? { subtype } : {}),
    status: computedStatus,
    ...(description ? { description } : {}),
    ...(capacity != null ? { capacity } : {}),
    ...(available != null ? { available } : {}),
  };
};

const mapAlertsForStops = (alerts: MbtaAlert[], stopIds: Set<string>): StationAlert[] =>
  alerts
    .filter((alert) => {
      const relatedStops = extractRelationshipIds(alert.relationships?.stops);
      return relatedStops.some((id) => stopIds.has(id));
    })
    .map((alert) => ({
      id: alert.id,
      severity: mapAlertSeverity(alert.attributes.severity),
      header: alert.attributes.header_text ?? "Service alert",
      ...(alert.attributes.description_text ? { description: alert.attributes.description_text } : {}),
      effect: alert.attributes.effect ?? "Service alert",
    }));

const fetchFacilitiesForStops = async (
  client: MbtaClient,
  stopIds: string[],
): Promise<StationFacility[]> => {
  const startMs = Date.now();
  const key = getFacilitiesCacheKey(stopIds);
  const cached = getCachedFacilities(key);
  if (cached) {
    trace("facilities-cache-hit", { stopCount: stopIds.length, ms: Date.now() - startMs });
    return cached;
  }

  try {
    const response = await client.getFacilities({
      "filter[stop]": stopIds.join(","),
      "page[limit]": 500,
    });
    const facilities = (Array.isArray(response.data) ? response.data : [response.data])
      .filter((facility): facility is MbtaFacility => facility.type === "facility")
      .map(mapFacility);
    setCachedFacilities(key, facilities);
    trace("facilities-fetch", { stopCount: stopIds.length, ms: Date.now() - startMs, count: facilities.length });
    return facilities;
  } catch (error) {
    logger.warn("Failed to fetch live facilities", { stopIds, message: String(error) });
    return [];
  }
};

export const buildStationBoardV2 = async (
  cache: MbtaCache,
  client: MbtaClient,
  stopId: string,
  params: { lat?: number; lng?: number } = {},
  options: { includeAlerts?: boolean; includeFacilities?: boolean } = {},
): Promise<GetStationBoardResponse | null> => {
  const startMs = Date.now();
  const includeAlerts = options.includeAlerts !== false;
  const includeFacilities = options.includeFacilities !== false;
  trace("board-start", {
    stopId,
    includeAlerts,
    includeFacilities,
  });
  const stopsEntry = cache.getStops();
  let stopMap = stopsEntry ? new Map(stopsEntry.data.map((entry) => [entry.id, entry])) : null;
  let requestedStop = stopMap?.get(stopId);

  if (!requestedStop) {
    const dbStops = await getStopsCachedLight().catch(() => [] as DbStop[]);
    if (dbStops.length > 0) {
      const dbStopMap = new Map<string, MbtaStop>();
      dbStops.forEach((stop) => {
        const relationships = stop.parentStationId
          ? { parent_station: { data: { id: stop.parentStationId, type: "stop" } } }
          : undefined;
        dbStopMap.set(stop.id, {
          id: stop.id,
          type: "stop",
          attributes: {
            name: stop.name,
            description: null,
            latitude: stop.lat,
            longitude: stop.lon,
            wheelchair_boarding: stop.wheelchairBoarding ?? null,
            location_type: stop.locationType ?? (stop.parentStationId ? 0 : 1),
          },
          ...(relationships ? { relationships } : {}),
        });
      });
      stopMap = dbStopMap;
      requestedStop = stopMap.get(stopId);
    }
  }

  if (!requestedStop || !stopMap) {
    trace("board-miss", { stopId, reason: "stop_not_found", ms: Date.now() - startMs });
    return null;
  }
  const boardableStop = resolveBoardableParent(requestedStop, stopMap);
  if (!boardableStop) {
    trace("board-miss", { stopId, reason: "non_boardable", ms: Date.now() - startMs });
    return null;
  }

  const distanceMeters =
    params.lat != null && params.lng != null
      ? haversineDistanceMeters(params.lat, params.lng, boardableStop.attributes.latitude, boardableStop.attributes.longitude)
      : undefined;

  const cacheKey = getBoardCacheKey(boardableStop.id, includeAlerts, includeFacilities);
  const cached = getCachedBoard(cacheKey);
  if (cached) {
    trace("board-cache-hit", { stopId, boardableStopId: boardableStop.id, ms: Date.now() - startMs });
    return withDistance(cached, distanceMeters);
  }
  trace("board-cache-miss", { stopId, boardableStopId: boardableStop.id, ms: Date.now() - startMs });

  const routesEntry = cache.getRoutes();
  const routesMap = new Map<string, MbtaRoute>((routesEntry?.data ?? []).map((route) => [route.id, route]));

  const platformStopIds = collectPlatformStopIds(stopMap, boardableStop);
  const snapshotMap = new Map<string, StopEtaSnapshot>();
  platformStopIds.forEach((platformId) => {
    const cached = getCachedStopEtaSnapshot(cache, platformId, {
      maxLookaheadMinutes: 60,
      minLookaheadMinutes: -2,
    });
    if (cached) {
      snapshotMap.set(platformId, cached);
    }
  });
  trace("board-snapshots", {
    stopId,
    boardableStopId: boardableStop.id,
    totalPlatforms: platformStopIds.length,
    cachedPlatforms: snapshotMap.size,
  });

  const missingPlatformIds = platformStopIds.filter((platformId) => !snapshotMap.has(platformId));
  if (missingPlatformIds.length > 0) {
    trace("board-missing", {
      stopId,
      missingPlatforms: missingPlatformIds.length,
      strategy: missingPlatformIds.length <= 2 ? "single" : "batch",
    });
    const now = new Date();
    if (missingPlatformIds.length <= 2) {
      const fetchedSnapshots = await Promise.all(
        missingPlatformIds.map(async (platformId) => {
          const fetchStart = Date.now();
          try {
            const snapshot = await withTimeout(
              getStopEtaSnapshot(client, platformId, {
                maxLookaheadMinutes: 60,
                minLookaheadMinutes: -2,
              }),
              SNAPSHOT_FETCH_TIMEOUT_MS,
              platformId,
            );
            trace("snapshot-fetch", {
              stopId,
              platformId,
              ms: Date.now() - fetchStart,
              success: Boolean(snapshot),
            });
            return snapshot;
          } catch (error) {
            const message = String(error);
            logger.warn("Failed to fetch station board snapshot", {
              stopId: platformId,
              message,
            });
            trace("snapshot-fetch", {
              stopId,
              platformId,
              ms: Date.now() - fetchStart,
              success: false,
            });
            return null;
          }
        }),
      );
      fetchedSnapshots.forEach((snapshot) => {
        if (snapshot) {
          snapshotMap.set(snapshot.stopId, snapshot);
        }
      });
    } else {
      try {
        const fetchStart = Date.now();
        const batched = await withTimeout(
          fetchBlendedDeparturesForStops(client, missingPlatformIds, {
            maxLookaheadMinutes: 60,
            minLookaheadMinutes: -2,
            maxResults: 200,
          }),
          SNAPSHOT_BATCH_TIMEOUT_MS,
          "batch",
        );
        trace("snapshot-batch", {
          stopId,
          platforms: missingPlatformIds.length,
          ms: Date.now() - fetchStart,
        });
        missingPlatformIds.forEach((platformId) => {
          const departures = batched.get(platformId) ?? [];
          if (departures.length > 0) {
            snapshotMap.set(platformId, {
              stopId: platformId,
              generatedAt: now.toISOString(),
              departures,
            });
          }
        });
      } catch (error) {
        logger.warn("Failed to fetch batched station board snapshots", {
          stopId,
          message: String(error),
        });
      }
    }
  }

  const departures = dedupeDepartures(sortDeparturesByFinalTime(
    platformStopIds
      .map((platformId) => snapshotMap.get(platformId))
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot))
      .flatMap((snapshot) => snapshot.departures ?? []),
  ));
  let detailSourceDepartures = departures;
  const hasScheduledTimes = departures.some((departure) => Boolean(departure.scheduledTime));
  if (!hasScheduledTimes) {
    const fetchStart = Date.now();
    try {
      const blended = await withTimeout(
        fetchBlendedDepartures(client, boardableStop.id, {
          minLookaheadMinutes: -2,
          maxLookaheadMinutes: DETAIL_MAX_LOOKAHEAD_MINUTES,
          maxResults: DETAIL_MAX_RESULTS,
        }),
        DETAIL_SCHEDULE_TIMEOUT_MS,
        "details_schedule_tail",
      );
      const blendedSorted = sortDeparturesByFinalTime(blended);
      const blendedDeduped = dedupeDepartures(blendedSorted);
      if (blendedDeduped.length > 0) {
        detailSourceDepartures = blendedDeduped;
      }
      const scheduledTotal = blendedDeduped.filter((row) => Boolean(row.scheduledTime)).length;
      const predictedTotal = blendedDeduped.filter((row) => Boolean(row.predictedTime)).length;
      const scheduleOnly = blendedDeduped.filter((row) => !row.predictedTime && Boolean(row.scheduledTime)).length;
      trace("details-schedule-tail", {
        stopId,
        boardableStopId: boardableStop.id,
        ms: Date.now() - fetchStart,
        departures: blendedDeduped.length,
        scheduledTotal,
        predictedTotal,
        scheduleOnly,
      });
    } catch (error) {
      logger.warn("Failed to fetch schedule tail for station board", {
        stopId: boardableStop.id,
        message: String(error),
      });
      trace("details-schedule-tail", {
        stopId,
        boardableStopId: boardableStop.id,
        ms: Date.now() - fetchStart,
        departures: 0,
        error: true,
      });
    }
  }

  const destinationFallbacks = new Map<string, Map<string, number>>();
  for (const departure of detailSourceDepartures) {
    const key = `${departure.routeId ?? "unknown"}-${departure.directionId ?? "na"}`;
    const label =
      normalizeLabel(departure.headsign) ?? resolveRouteDestination(departure, routesMap) ?? null;
    if (!label || isGenericDirectionLabel(label)) {
      continue;
    }
    const counts = destinationFallbacks.get(key) ?? new Map<string, number>();
    counts.set(label, (counts.get(label) ?? 0) + 1);
    destinationFallbacks.set(key, counts);
  }
  const resolvedFallbacks = new Map<string, string>();
  destinationFallbacks.forEach((counts, key) => {
    let winner: string | null = null;
    let best = -1;
    counts.forEach((count, label) => {
      if (count > best) {
        best = count;
        winner = label;
      }
    });
    if (winner) {
      resolvedFallbacks.set(key, winner);
    }
  });

  const primaryRoutes = groupDepartures(
    departures.length > 0 ? departures : detailSourceDepartures,
    routesMap,
  );
  const detailDepartureCounts = new Map<string, { predicted: number; schedule: number }>();
  const detailDepartures: StationDeparture[] = [];
  for (const departure of detailSourceDepartures) {
    if (detailDepartures.length >= DETAIL_DEPARTURE_TOTAL_LIMIT) {
      break;
    }
    const routeIdKey = departure.routeId ?? "unknown";
    const directionLabel = directionIdToLabel(departure.directionId);
    const detailKey = `${routeIdKey}-${directionLabel}`;
    const counts = detailDepartureCounts.get(detailKey) ?? { predicted: 0, schedule: 0 };
    const isScheduleOnly = !departure.predictedTime && !!departure.scheduledTime;
    if (isScheduleOnly) {
      if (counts.schedule >= DETAIL_SCHEDULE_ONLY_LIMIT) continue;
      counts.schedule += 1;
    } else {
      if (counts.predicted >= DETAIL_DEPARTURE_DIRECTION_LIMIT) continue;
      counts.predicted += 1;
    }
    detailDepartureCounts.set(detailKey, counts);
    detailDepartures.push(toStationDeparture(departure, routesMap, resolvedFallbacks));
  }

  const stopIdSet = new Set(platformStopIds);
  stopIdSet.add(boardableStop.id);
  const alerts = includeAlerts ? mapAlertsForStops(cache.getAlerts()?.data ?? [], stopIdSet) : [];
  const facilities =
    includeFacilities && platformStopIds.length > 0 ? await fetchFacilitiesForStops(client, platformStopIds) : [];

  const details: StationBoardDetails = {
    departures: detailDepartures,
    alerts,
    facilities,
  };

  const primary: GetStationBoardResponse["primary"] = {
    stopId: boardableStop.id,
    stopName: boardableStop.attributes.name,
    routes: primaryRoutes,
  };

  trace("board-done", {
    stopId,
    boardableStopId: boardableStop.id,
    departures: detailDepartures.length,
    alerts: alerts.length,
    facilities: facilities.length,
    totalMs: Date.now() - startMs,
  });
  const response: GetStationBoardResponse = {
    primary,
    details,
  };
  setCachedBoard(cacheKey, response);
  trace("board-cache-store", { stopId, boardableStopId: boardableStop.id, ms: Date.now() - startMs });
  return withDistance(response, distanceMeters);
};
