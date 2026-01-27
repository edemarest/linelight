import type { MbtaCache } from "../cache/mbtaCache";
import type { StationSummary, Mode } from "../models/domain";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import type { MbtaLine, MbtaRoute, MbtaStop, RouteType } from "../models/mbta";
import { mapRouteTypeToMode } from "../utils/routeMode";
import { isBoardableKind, resolveStationKind } from "../utils/stationKind";
import {
  getRoutesCachedLight,
  getStopsCachedLight,
  getStopRoutesCachedLight,
  getStationSummariesCached,
  type DbRoute,
  type DbStop,
  type DbStationSummary,
} from "../db";
import { logger } from "../utils/logger";

const stationCache = new Map<string, { value: StationSummary[]; fetchedAt: number }>();
const STATION_CACHE_TTL = 1000 * 30;

const buildCacheKey = (mode: Mode | undefined, limit: number) => `${mode ?? "all"}|${limit}`;
const isNonBoardableStopId = (stopId: string) =>
  stopId.startsWith("node-") ||
  stopId.startsWith("entrance-") ||
  stopId.startsWith("door-") ||
  stopId.startsWith("elevator-");

interface StationSummaryOptions {
  limit?: number;
  mode?: Mode | undefined;
}

export const buildStationSummaries = async (
  cache: MbtaCache,
  options: StationSummaryOptions = {},
): Promise<StationSummary[]> => {
  const { limit = 200, mode } = options;

  const cacheKey = buildCacheKey(mode, limit);
  const cached = stationCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < STATION_CACHE_TTL) {
    return cached.value;
  }

  const predictions = cache.getPredictions();
  const lines = cache.getLines();

  const dbStops = getStopsCachedLight().catch((error) => {
    logger.warn("DB stops unavailable, falling back to cache", { message: String(error) });
    return [] as DbStop[];
  });

  const dbRoutes = getRoutesCachedLight().catch((error) => {
    logger.warn("DB routes unavailable, falling back to cache", { message: String(error) });
    return [] as DbRoute[];
  });

  const dbStopRoutes = getStopRoutesCachedLight().catch((error) => {
    logger.warn("DB stop_routes unavailable, falling back to cache", { message: String(error) });
    return new Map<string, Set<string>>();
  });

  const stopsEntry = cache.getStops();
  const routesEntry = cache.getRoutes();
  const stopRouteMapEntry = cache.getStopRouteMap();

  const buildDbStop = (stop: DbStop): MbtaStop => {
    const relationships = stop.parentStationId
      ? { parent_station: { data: { id: stop.parentStationId, type: "stop" } } }
      : null;
    return {
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
    };
  };

  const dbStopsResolved = await dbStops;
  const dbRoutesResolved = await dbRoutes;
  const dbStopRoutesResolved = await dbStopRoutes;
  const dbStationSummaries = await getStationSummariesCached().catch((error) => {
    logger.warn("DB station summaries unavailable, falling back to computed summaries", { message: String(error) });
    return [] as DbStationSummary[];
  });

  const useDb = dbStopsResolved.length > 0 && dbRoutesResolved.length > 0;
  const stops = useDb ? dbStopsResolved.map(buildDbStop) : stopsEntry?.data ?? [];
  const stopLookup = new Map<string, MbtaStop>(stops.map((stop) => [stop.id, stop]));

  if (stops.length === 0) return [];

  const predictionsByStop = new Map<string, Set<string>>();

  (predictions?.data ?? []).forEach((prediction) => {
    const stopId = extractFirstRelationshipId(prediction.relationships?.stop);
    const routeId = extractFirstRelationshipId(prediction.relationships?.route);
    if (!stopId || !routeId) return;
    const set = predictionsByStop.get(stopId) ?? new Set<string>();
    set.add(routeId);
    predictionsByStop.set(stopId, set);
  });

  const routeModeMap = new Map<string, Mode>();
  if (useDb) {
    dbRoutesResolved.forEach((route) => {
      routeModeMap.set(route.id, mapRouteTypeToMode(route.type as RouteType));
    });
  } else if (lines && routesEntry) {
    const routesMap = new Map<string, MbtaRoute>(routesEntry.data.map((route) => [route.id, route]));
    lines.data.forEach((line: MbtaLine) => {
      const routeIds = extractRelationshipIds(line.relationships?.routes);
      routeIds.forEach((routeId) => {
        const route = routesMap.get(routeId);
        if (!route) return;
        routeModeMap.set(routeId, mapRouteTypeToMode(route.attributes.type));
      });
    });
  }

  const normalizeMode = (value: string): Mode | null => {
    if (value === "subway" || value === "bus" || value === "commuter_rail" || value === "ferry" || value === "other") {
      return value;
    }
    return null;
  };

  const summaries = useDb && dbStationSummaries.length > 0
    ? dbStationSummaries
      .map<StationSummary | null>((summary) => {
        if (isNonBoardableStopId(summary.stationId)) {
          return null;
        }
        const stationStop = stopLookup.get(summary.stationId);
        if (stationStop && !isBoardableKind(resolveStationKind(stationStop))) {
          return null;
        }
        const platformStops = summary.platformStopIds
          .map((stopId) => stopLookup.get(stopId))
          .filter((platform): platform is MbtaStop => platform !== undefined)
          .filter((platform) => resolveStationKind(platform) === "platform")
          .filter((platform) => !isNonBoardableStopId(platform.id));
        const platformMarkers = platformStops
          .filter(
            (platform) =>
              typeof platform.attributes.latitude === "number" &&
              typeof platform.attributes.longitude === "number",
          )
          .map((platform) => ({
            stopId: platform.id,
            name: platform.attributes.name,
            latitude: platform.attributes.latitude,
            longitude: platform.attributes.longitude,
          }));

        const routeSet = new Set(summary.routesServing);
        summary.platformStopIds.forEach((stopId) => {
          predictionsByStop.get(stopId)?.forEach((routeId) => routeSet.add(routeId));
        });

        const modesSet = new Set<Mode>();
        summary.modesServed.forEach((mode) => {
          const normalized = normalizeMode(mode);
          if (normalized) modesSet.add(normalized);
        });
        routeSet.forEach((routeId) => {
          const modeValue = routeModeMap.get(routeId);
          if (modeValue) modesSet.add(modeValue);
        });

        return {
          stopId: summary.stationId,
          name: summary.name,
          latitude: summary.lat,
          longitude: summary.lon,
          routesServing: Array.from(routeSet),
          modesServed: Array.from(modesSet),
          platformStopIds: platformStops.map((platform) => platform.id),
          platformMarkers,
        };
      })
      .filter((summary): summary is StationSummary => summary !== null)
    : (() => {
        const summariesByCanonical = new Map<
          string,
          { stop: MbtaStop; routes: Set<string>; modes: Set<Mode>; platformStops: Map<string, MbtaStop> }
        >();

        stops
          .filter((stop) => typeof stop.attributes.latitude === "number" && typeof stop.attributes.longitude === "number")
          .forEach((stop) => {
            const kind = resolveStationKind(stop);
            if (kind === "entrance" || kind === "other") return;

            const canonicalId =
              kind === "station"
                ? stop.id
                : extractFirstRelationshipId(stop.relationships?.parent_station) ?? stop.id;
            const canonicalStop = stopLookup.get(canonicalId) ?? stop;

            const relationshipRoutes = new Set<string>();
            [
              stop.relationships?.route,
              stop.relationships?.routes,
              stop.relationships?.line,
              stop.relationships?.lines,
              stop.relationships?.route_patterns,
            ].forEach((relationship) => {
              extractRelationshipIds(relationship).forEach((id) => relationshipRoutes.add(id));
            });

            const staticRoutes = useDb ? dbStopRoutesResolved.get(stop.id) : stopRouteMapEntry?.data?.get(stop.id);
            staticRoutes?.forEach((routeId) => relationshipRoutes.add(routeId));
            const predictionRoutes = predictionsByStop.get(stop.id);
            predictionRoutes?.forEach((routeId) => relationshipRoutes.add(routeId));

            if (!summariesByCanonical.has(canonicalId)) {
              summariesByCanonical.set(canonicalId, {
                stop: canonicalStop,
                routes: new Set<string>(),
                modes: new Set<Mode>(),
                platformStops: new Map<string, MbtaStop>(),
              });
            }
            const bucket = summariesByCanonical.get(canonicalId)!;
            relationshipRoutes.forEach((routeId) => {
              bucket.routes.add(routeId);
              const modeValue = routeModeMap.get(routeId);
              if (modeValue) bucket.modes.add(modeValue);
            });
            bucket.platformStops.set(stop.id, stop);
            bucket.platformStops.set(canonicalStop.id, canonicalStop);
          });

        return Array.from(summariesByCanonical.values()).map<StationSummary>((entry) => {
          const platformStopIds = Array.from(entry.platformStops.keys());
          const platformMarkers = Array.from(entry.platformStops.values())
            .filter(
              (platform) =>
                typeof platform.attributes.latitude === "number" &&
                typeof platform.attributes.longitude === "number",
            )
            .map((platform) => ({
              stopId: platform.id,
              name: platform.attributes.name,
              latitude: platform.attributes.latitude,
              longitude: platform.attributes.longitude,
            }));

          return {
            stopId: entry.stop.id,
            name: entry.stop.attributes.name,
            latitude: entry.stop.attributes.latitude,
            longitude: entry.stop.attributes.longitude,
            routesServing: Array.from(entry.routes),
            modesServed: Array.from(entry.modes),
            platformStopIds,
            platformMarkers,
          };
        });
      })();

  const filtered = summaries.filter((summary) => {
      if (!mode) return true;
      return summary.modesServed.includes(mode);
    });

  const limited = filtered.slice(0, limit);

  stationCache.set(cacheKey, { value: limited, fetchedAt: Date.now() });
  return limited;

};
