import type { MbtaCache } from "../cache/mbtaCache";
import type { StationSummary, Mode } from "../models/domain";
import { extractFirstRelationshipId, extractRelationshipIds } from "../utils/jsonApi";
import type { MbtaLine, MbtaRoute, MbtaStop } from "../models/mbta";
import { mapRouteTypeToMode } from "../utils/routeMode";
import { resolveStationKind } from "../utils/stationKind";

const stationCache = new Map<string, { value: StationSummary[]; fetchedAt: number }>();
const STATION_CACHE_TTL = 1000 * 30;

const buildCacheKey = (mode: Mode | undefined, limit: number) => `${mode ?? "all"}|${limit}`;

interface StationSummaryOptions {
  limit?: number;
  mode?: Mode | undefined;
}

export const buildStationSummaries = (
  cache: MbtaCache,
  options: StationSummaryOptions = {},
): StationSummary[] => {
  const { limit = 200, mode } = options;

  const cacheKey = buildCacheKey(mode, limit);
  const cached = stationCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < STATION_CACHE_TTL) {
    return cached.value;
  }

  const stops = cache.getStops();
  const predictions = cache.getPredictions();
  const lines = cache.getLines();
  const routes = cache.getRoutes();
  const stopRouteMapEntry = cache.getStopRouteMap();
  const stopLookup = new Map<string, MbtaStop>((stops?.data ?? []).map((stop) => [stop.id, stop]));

  if (!stops) return [];

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
  if (lines && routes) {
    const routesMap = new Map<string, MbtaRoute>(routes.data.map((route) => [route.id, route]));
    lines.data.forEach((line: MbtaLine) => {
      const routeIds = extractRelationshipIds(line.relationships?.routes);
      routeIds.forEach((routeId) => {
        const route = routesMap.get(routeId);
        if (!route) return;
        routeModeMap.set(routeId, mapRouteTypeToMode(route.attributes.type));
      });
    });
  }

const summariesByCanonical = new Map<
  string,
  { stop: MbtaStop; routes: Set<string>; modes: Set<Mode>; platformStops: Map<string, MbtaStop> }
>();

  (stops?.data ?? [])
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

      const staticRoutes = stopRouteMapEntry?.data?.get(stop.id);
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
        const mode = routeModeMap.get(routeId);
        if (mode) bucket.modes.add(mode);
      });
      bucket.platformStops.set(stop.id, stop);
      bucket.platformStops.set(canonicalStop.id, canonicalStop);
    });

  const summaries = Array.from(summariesByCanonical.values()).map<StationSummary>((entry) => {
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

  const filtered = summaries.filter((summary) => {
      if (!mode) return true;
      return summary.modesServed.includes(mode);
    });

  const limited = filtered.slice(0, limit);

  stationCache.set(cacheKey, { value: limited, fetchedAt: Date.now() });
  return limited;

};
