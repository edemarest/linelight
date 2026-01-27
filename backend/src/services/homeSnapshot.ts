// Builds the map home response by blending nearby stops with live ETAs.
import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaClient } from "../mbta/client";
import type { MbtaRoute, MbtaStop, RouteType } from "../models/mbta";
import { haversineDistanceMeters } from "../utils/geo";
import { mapRouteTypeToMode } from "../utils/routeMode";
import type { HomeResponse, HomeStopSummary, HomeRouteSummary, Mode } from "@linelight/core";
import { getCachedStopEtaSnapshot, getStopEtaSnapshot } from "./etaService";
import { fetchBlendedDeparturesForStops, type BlendedDeparture } from "./etaBlender";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import { isBoardableKind, resolveStationKind } from "../utils/stationKind";
import { logger } from "../utils/logger";
import {
  getRoutesCachedLight,
  getStopsCachedLight,
  getStopRoutesCachedLight,
  type DbRoute,
  type DbStop,
} from "../db";
import { createTimings } from "../utils/timing";
import { directionIdToLabel } from "../utils/directions";
import { normalizeLabel } from "../utils/text";

interface BuildHomeOptions {
  lat: number;
  lng: number;
  radiusMeters: number;
  limit: number;
  favoriteStopIds: string[];
}

type StationGroup = {
  stationStop: MbtaStop;
  platformStopIds: Set<string>;
  minDistance: number;
};

type StopTarget = {
  stop: MbtaStop;
  distance: number;
  isFavorite: boolean;
};

const HOME_CACHE_COORD_PRECISION = 0.01; // ~1.1km
const HOME_CACHE_RADIUS_INCREMENT = 250;
const MAX_UNIQUE_STOP_TARGETS = 20;
const STOP_SNAPSHOT_CONCURRENCY = 4;
const HOME_SNAPSHOT_TIMEOUT_MS = Number(process.env.HOME_SNAPSHOT_TIMEOUT_MS ?? "1500");
const HOME_SNAPSHOT_CONCURRENCY = Number(process.env.HOME_SNAPSHOT_CONCURRENCY ?? String(STOP_SNAPSHOT_CONCURRENCY));
const SUGGESTED_STATION_IDS = [
  "place-pktrm", // Park Street
  "place-gover", // Government Center
  "place-dwnxg", // Downtown Crossing
  "place-sstat", // South Station
  "place-north", // North Station
  "place-haecl", // Haymarket
  "place-coecl", // Copley
  "place-knncl", // Kendall/MIT
] as const;

const quantizeCoordinate = (value: number) =>
  (Math.round(value / HOME_CACHE_COORD_PRECISION) * HOME_CACHE_COORD_PRECISION).toFixed(4);

const quantizeRadius = (meters: number) =>
  Math.max(HOME_CACHE_RADIUS_INCREMENT, Math.round(meters / HOME_CACHE_RADIUS_INCREMENT) * HOME_CACHE_RADIUS_INCREMENT);

const buildHomeCacheKey = (options: BuildHomeOptions) => {
  const latBucket = quantizeCoordinate(options.lat);
  const lngBucket = quantizeCoordinate(options.lng);
  const radiusBucket = quantizeRadius(options.radiusMeters);
  const limitBucket = Math.max(1, Math.min(50, options.limit));
  const favoritesKey =
    options.favoriteStopIds.length > 0
      ? options.favoriteStopIds
          .slice()
          .sort()
          .join(",")
      : "none";
  return `${latBucket}:${lngBucket}:r${radiusBucket}:l${limitBucket}:f${favoritesKey}`;
};

const groupDeparturesByRoute = (departures: BlendedDeparture[]): HomeRouteSummary[] => {
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
        direction: "Unknown",
        directionId: null,
        nextTimes: [],
      };
    }
    const directionLabel = directionIdToLabel(primary.directionId);
    const primaryHeadsign = normalizeLabel(primary.headsign);
    const alternateHeadsign = group
      .map((item) => normalizeLabel(item.headsign))
      .find((label): label is string => Boolean(label));
    const finalDestination = primaryHeadsign ?? alternateHeadsign ?? null;
    return {
      routeId: primary.routeId ?? "unknown",
      shortName: primary.routeId ?? "Route",
      direction: directionLabel,
      destination: finalDestination,
      directionId: primary.directionId ?? null,
      nextTimes: group.slice(0, 3).map((dep) => ({
        etaMinutes: dep.etaMinutes ?? null,
        source: dep.etaSource,
        status: dep.status,
      })),
    };
  });
};

const isBoardableStop = (stop: MbtaStop | null | undefined): boolean => {
  if (!stop) return false;
  return isBoardableKind(resolveStationKind(stop));
};

const resolveCanonicalStationStop = (stop: MbtaStop, stopLookup: Map<string, MbtaStop>): MbtaStop | null => {
  const kind = resolveStationKind(stop);
  if (kind === "station") {
    return stop;
  }
  if (kind === "platform") {
    const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
    if (parentId) {
      const parent = stopLookup.get(parentId);
      if (parent && resolveStationKind(parent) === "station") {
        return parent;
      }
    }
    return stop;
  }
  const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
  if (!parentId) {
    return isBoardableStop(stop) ? stop : null;
  }
  const parentStop = stopLookup.get(parentId);
  if (!parentStop) {
    return isBoardableStop(stop) ? stop : null;
  }
  const parentKind = resolveStationKind(parentStop);
  if (parentKind === "station" || parentKind === "platform") {
    return parentStop;
  }
  return isBoardableStop(stop) ? stop : null;
};

const buildStationChildrenMap = (stops: MbtaStop[]): Map<string, MbtaStop[]> => {
  const map = new Map<string, MbtaStop[]>();
  stops.forEach((stop) => {
    const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
    if (!parentId) return;
    if (resolveStationKind(stop) !== "platform") return;
    const list = map.get(parentId) ?? [];
    list.push(stop);
    map.set(parentId, list);
  });
  return map;
};

const getCanonicalStationMeta = (
  stop: MbtaStop,
  stopLookup: Map<string, MbtaStop>,
): { stationStop: MbtaStop; canonicalId: string; parentStationId: string | null } | null => {
  if (!isBoardableStop(stop)) return null;
  const stationStop = resolveCanonicalStationStop(stop, stopLookup);
  if (!stationStop) return null;
  const parentStationId = extractFirstRelationshipId(stop.relationships?.parent_station) ?? null;
  const canonicalId = parentStationId ?? stationStop.id;
  return { stationStop, canonicalId, parentStationId };
};

const addStopToGroup = (
  groupMap: Map<string, StationGroup>,
  stop: MbtaStop,
  distance: number,
  stopLookup: Map<string, MbtaStop>,
  stationChildrenMap: Map<string, MbtaStop[]>,
) => {
  const meta = getCanonicalStationMeta(stop, stopLookup);
  if (!meta) return;
  const { stationStop, canonicalId, parentStationId } = meta;
  let group = groupMap.get(canonicalId);
  if (!group) {
    group = {
      stationStop,
      platformStopIds: new Set<string>(),
      minDistance: distance,
    };
    groupMap.set(canonicalId, group);
  } else {
    group.minDistance = Math.min(group.minDistance, distance);
    if (
      resolveStationKind(stationStop) === "station" &&
      resolveStationKind(group.stationStop) !== "station"
    ) {
      group.stationStop = stationStop;
    }
  }

  const addPlatform = (candidate: MbtaStop | undefined) => {
    if (!candidate || !isBoardableStop(candidate)) return;
    group?.platformStopIds.add(candidate.id);
  };

  addPlatform(stop);
  if (stationStop.id !== stop.id) {
    addPlatform(stationStop);
  }
  const childrenKey =
    parentStationId ?? (resolveStationKind(stationStop) === "station" ? stationStop.id : null);
  if (childrenKey) {
    const children = stationChildrenMap.get(childrenKey);
    if (children) {
      children.forEach((child) => addPlatform(child));
    }
  }
};

const buildGroupsFromEntries = (
  entries: Array<{ stop: MbtaStop; distance: number }>,
  stopLookup: Map<string, MbtaStop>,
  stationChildrenMap: Map<string, MbtaStop[]>,
) => {
  const map = new Map<string, StationGroup>();
  entries.forEach(({ stop, distance }) => addStopToGroup(map, stop, distance, stopLookup, stationChildrenMap));
  return map;
};

const aggregateDeparturesForGroup = (
  group: StationGroup,
  snapshotMap: Map<string, BlendedDeparture[]>,
): BlendedDeparture[] => {
  const rows: BlendedDeparture[] = [];
  group.platformStopIds.forEach((stopId) => {
    const departures = snapshotMap.get(stopId);
    if (departures && departures.length > 0) {
      rows.push(...departures);
    }
  });
  return rows;
};

const toHomeStopSummary = (
  stop: MbtaStop,
  distanceMeters: number,
  departures: BlendedDeparture[],
  routeModes: Map<string, Mode>,
  platformStopIds: string[],
  dbStopRoutes?: Map<string, Set<string>>,
): HomeStopSummary => {
  const routes = groupDeparturesByRoute(departures);
  
  // Collect modes from departures
  const modesFromDepartures = new Set(
    routes
      .map((route) => (route.routeId ? routeModes.get(route.routeId) : undefined))
      .filter((mode): mode is Mode => Boolean(mode)),
  );

  // Also add modes from database for stops that have routes in DB
  if (dbStopRoutes) {
    const dbModesForStop = new Set<Mode>();
    platformStopIds.forEach((platformId) => {
      const routeIds = dbStopRoutes.get(platformId);
      if (routeIds && routeIds.size > 0) {
        routeIds.forEach((routeId) => {
          const mode = routeModes.get(routeId);
          if (mode) {
            dbModesForStop.add(mode);
            modesFromDepartures.add(mode);
          }
        });
      }
    });
    if (stop.id === "place-north" && dbModesForStop.size > 0) {
      logger.debug("North Station DB modes", { platformStopIds, dbModes: Array.from(dbModesForStop) });
    }
  }

  const modes = Array.from(modesFromDepartures);

  return {
    stopId: stop.id,
    name: stop.attributes.name,
    distanceMeters,
    modes,
    routes,
    platformStopIds,
  };
};

const buildRouteModeLookup = (routes: MbtaRoute[] | undefined): Map<string, Mode> => {
  const map = new Map<string, Mode>();
  if (!routes) return map;
  routes.forEach((route) => {
    map.set(route.id, mapRouteTypeToMode(route.attributes.type ?? null));
  });
  return map;
};

const collectStopsWithinRadius = (
  stops: MbtaStop[] | undefined,
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number,
  stopRouteMap?: Map<string, Set<string>>,
): Array<{ stop: MbtaStop; distance: number }> => {
  if (!stops) return [];
  const maxCandidates = Math.max(limit * 4, limit);
  const entries: Array<{ stop: MbtaStop; distance: number }> = [];

  const hasService = (stopId: string) => {
    if (!stopRouteMap) return true;
    return (stopRouteMap.get(stopId)?.size ?? 0) > 0;
  };

  for (const stop of stops) {
    if (entries.length >= maxCandidates) break;
    if (!hasService(stop.id)) continue;
    const distance = haversineDistanceMeters(lat, lng, stop.attributes.latitude, stop.attributes.longitude);
    if (distance > radiusMeters) continue;
    entries.push({ stop, distance });
  }

  return entries.sort((a, b) => a.distance - b.distance).slice(0, limit);
};

const scoreGroupByRoutes = (group: StationGroup, stopRouteMap?: Map<string, Set<string>>): number => {
  if (!stopRouteMap) return 0;
  const routes = new Set<string>();
  const stationRoutes = stopRouteMap.get(group.stationStop.id);
  if (stationRoutes) {
    stationRoutes.forEach((routeId) => routes.add(routeId));
  }
  group.platformStopIds.forEach((stopId) => {
    const routeIds = stopRouteMap.get(stopId);
    if (!routeIds) return;
    routeIds.forEach((routeId) => routes.add(routeId));
  });
  return routes.size;
};

const buildSuggestedNearbyGroups = (
  allStops: MbtaStop[],
  options: Pick<BuildHomeOptions, "lat" | "lng" | "limit">,
  stopLookup: Map<string, MbtaStop>,
  stationChildrenMap: Map<string, MbtaStop[]>,
  stopRouteMap?: Map<string, Set<string>>,
): StationGroup[] => {
  const preferredStops = SUGGESTED_STATION_IDS.map((id) => stopLookup.get(id)).filter((stop): stop is MbtaStop => Boolean(stop));
  const placeStops = allStops.filter((stop) => stop.id.startsWith("place-") && isBoardableStop(stop));

  const uniqueCandidates = new Map<string, MbtaStop>();
  preferredStops.forEach((stop) => uniqueCandidates.set(stop.id, stop));
  placeStops.forEach((stop) => uniqueCandidates.set(stop.id, stop));

  const entries = Array.from(uniqueCandidates.values()).map((stop) => ({
    stop,
    distance: haversineDistanceMeters(options.lat, options.lng, stop.attributes.latitude, stop.attributes.longitude),
  }));

  const groupsMap = buildGroupsFromEntries(entries, stopLookup, stationChildrenMap);
  const selected: StationGroup[] = [];
  const seen = new Set<string>();

  const addGroup = (group: StationGroup | undefined, options?: { allowUnscored?: boolean }) => {
    if (!group) return;
    const key = group.stationStop.id;
    if (seen.has(key)) return;
    if (!options?.allowUnscored && scoreGroupByRoutes(group, stopRouteMap) === 0) return;
    selected.push(group);
    seen.add(key);
  };

  SUGGESTED_STATION_IDS.forEach((id) => addGroup(groupsMap.get(id), { allowUnscored: true }));

  if (!stopRouteMap) {
    return selected.slice(0, options.limit);
  }

  const scored = Array.from(groupsMap.values())
    .map((group) => ({ group, score: scoreGroupByRoutes(group, stopRouteMap) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.group.minDistance - b.group.minDistance);

  scored.forEach(({ group }) => addGroup(group));

  return selected.slice(0, options.limit);
};

type StopSnapshotFetcher = typeof getStopEtaSnapshot;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const fetchStopSnapshots = async (
  cache: MbtaCache,
  client: MbtaClient,
  targets: StopTarget[],
  fetchStopSnapshot: StopSnapshotFetcher,
  prefetchedSnapshots?: Map<string, BlendedDeparture[]>,
): Promise<Array<{ stop: MbtaStop; snapshot: BlendedDeparture[] | null }>> => {
  if (targets.length === 0) return [];
  const queue = targets.slice();
  const results: Array<{ stop: MbtaStop; snapshot: BlendedDeparture[] | null }> = [];
  const prefetched = prefetchedSnapshots ?? new Map<string, BlendedDeparture[]>();

  const worker = async () => {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      const { stop } = target;
      const prefetchedSnapshot = prefetched.get(stop.id);
      if (prefetchedSnapshot !== undefined) {
        results.push({ stop, snapshot: prefetchedSnapshot });
        continue;
      }
      const cachedSnapshot = getCachedStopEtaSnapshot(cache, stop.id, {
        maxLookaheadMinutes: 30,
        minLookaheadMinutes: -2,
        stopName: stop.attributes.name,
      });
      if (cachedSnapshot) {
        results.push({ stop, snapshot: cachedSnapshot.departures });
        continue;
      }
      if (!target.isFavorite) {
        results.push({ stop, snapshot: null });
        continue;
      }
      try {
        const snapshot = await withTimeout(
          fetchStopSnapshot(client, stop.id, {
            maxLookaheadMinutes: 30,
            minLookaheadMinutes: -2,
          }),
          HOME_SNAPSHOT_TIMEOUT_MS,
        );
        results.push({ stop, snapshot: snapshot.departures });
      } catch (error) {
        logger.error("Failed to fetch stop snapshot for home view", {
          stopId: stop.id,
          message: String(error),
        });
        results.push({ stop, snapshot: null });
      }
    }
  };

  const workerCount = Math.min(
    Math.max(1, Number.isFinite(HOME_SNAPSHOT_CONCURRENCY) ? HOME_SNAPSHOT_CONCURRENCY : STOP_SNAPSHOT_CONCURRENCY),
    targets.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

export const buildHomeSnapshot = async (
  cache: MbtaCache,
  client: MbtaClient,
  options: BuildHomeOptions,
  deps?: { fetchStopSnapshot?: StopSnapshotFetcher },
): Promise<HomeResponse> => {
  logger.debug("buildHomeSnapshot called", { lat: options.lat, lng: options.lng });
  const timing = createTimings();
  const cacheKey = buildHomeCacheKey(options);
  const cached = await cache.getHomeSnapshot(cacheKey);
  if (cached) {
    logger.debug("Home snapshot cache hit", { durationMs: timing.totalMs() });
    return cached;
  }

  const fetchStopSnapshot = deps?.fetchStopSnapshot ?? getStopEtaSnapshot;
  const stopsEntry = cache.getStops();
  const routesEntry = cache.getRoutes();

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

  const dbStopsResolved = await dbStops;
  const dbRoutesResolved = await dbRoutes;
  const dbStopRoutesResolved = await dbStopRoutes;
  timing.mark("dbLoad");

  logger.debug("DB data loaded", { dbStopsCount: dbStopsResolved.length, dbRoutesCount: dbRoutesResolved.length, dbStopRoutesSize: dbStopRoutesResolved.size });

  const useDb = dbStopsResolved.length > 0 && dbRoutesResolved.length > 0 && dbStopRoutesResolved.size > 0;
  logger.debug("useDb decision", { useDb });
  
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

  const allStops = useDb ? dbStopsResolved.map(buildDbStop) : stopsEntry?.data ?? [];
  const routeModes = useDb
    ? new Map(dbRoutesResolved.map((route) => [route.id, mapRouteTypeToMode(route.type as RouteType)]))
    : buildRouteModeLookup(routesEntry?.data);

  const crRoutesInMap = Array.from(routeModes.entries()).filter(([id]) => id.startsWith("CR-"));
  logger.debug("routeModes compiled", { totalRoutes: routeModes.size, crRoutes: crRoutesInMap.length, crSample: crRoutesInMap.slice(0, 3).map(([id, mode]) => ({ id, mode })) });

  if (allStops.length === 0 || routeModes.size === 0) {
    const response: HomeResponse = {
      favorites: [],
      nearby: [],
      generatedAt: new Date().toISOString(),
    };
    await cache.setHomeSnapshot(cacheKey, response);
    logger.warn("Home snapshot empty, missing stop or route data", {
      stopsCount: allStops.length,
      routesCount: routeModes.size,
      useDb,
    });
    return response;
  }
  const stopLookup = new Map<string, MbtaStop>();
  allStops.forEach((stop) => stopLookup.set(stop.id, stop));
  const stationChildrenMap = buildStationChildrenMap(allStops);

  const nearbyStops = collectStopsWithinRadius(
    allStops,
    options.lat,
    options.lng,
    options.radiusMeters,
    options.limit * 4,
    useDb ? dbStopRoutesResolved : cache.getStopRouteMap()?.data,
  );
  timing.mark("nearbyStops");

  const nearbyGroupsMap = buildGroupsFromEntries(nearbyStops, stopLookup, stationChildrenMap);
  const orderedNearbyGroups = Array.from(nearbyGroupsMap.values()).sort(
    (a, b) => a.minDistance - b.minDistance,
  );
  let limitedNearbyGroups = orderedNearbyGroups.slice(0, options.limit);
  if (limitedNearbyGroups.length === 0) {
    limitedNearbyGroups = buildSuggestedNearbyGroups(
      allStops,
      options,
      stopLookup,
      stationChildrenMap,
      useDb ? dbStopRoutesResolved : cache.getStopRouteMap()?.data,
    );
  }

  const favoriteStops = options.favoriteStopIds
    .map((id) => stopLookup.get(id))
    .filter((stop): stop is MbtaStop => Boolean(stop));

  const favoriteEntries = favoriteStops.map((stop) => ({
    stop,
    distance: haversineDistanceMeters(options.lat, options.lng, stop.attributes.latitude, stop.attributes.longitude),
  }));
  const favoriteGroupsMap = buildGroupsFromEntries(favoriteEntries, stopLookup, stationChildrenMap);

  const etaTargetStopIds = new Set<string>();
  const stopPriority = new Map<string, { distance: number; isFavorite: boolean }>();
  const registerGroupTargets = (group: StationGroup | undefined, isFavorite: boolean) => {
    if (!group) return;
    group.platformStopIds.forEach((stopId) => {
      etaTargetStopIds.add(stopId);
      const existing = stopPriority.get(stopId);
      const distance = existing ? Math.min(existing.distance, group.minDistance) : group.minDistance;
      stopPriority.set(stopId, {
        distance,
        isFavorite: existing?.isFavorite ? true : isFavorite,
      });
    });
  };
  limitedNearbyGroups.forEach((group) => registerGroupTargets(group, false));
  favoriteGroupsMap.forEach((group) => registerGroupTargets(group, true));

  const uniqueStopTargets = Array.from(etaTargetStopIds)
    .map((id) => stopLookup.get(id))
    .filter((stop): stop is MbtaStop => Boolean(stop));
  const prioritizedTargets: StopTarget[] = uniqueStopTargets
    .map((stop) => {
      const priority = stopPriority.get(stop.id);
      return {
        stop,
        distance: priority?.distance ?? Number.POSITIVE_INFINITY,
        isFavorite: priority?.isFavorite ?? false,
      };
    })
    .sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) {
        return a.isFavorite ? -1 : 1;
      }
      return a.distance - b.distance;
    });

  const favoriteTargets = prioritizedTargets.filter((entry) => entry.isFavorite);
  const nonFavoriteTargets = prioritizedTargets.filter((entry) => !entry.isFavorite);
  const maxTargets = Math.max(MAX_UNIQUE_STOP_TARGETS, favoriteTargets.length);
  const limitedTargets = [...favoriteTargets, ...nonFavoriteTargets].slice(0, maxTargets);

  let prefetchedSnapshots = new Map<string, BlendedDeparture[]>();
  if (favoriteTargets.length > 0) {
    try {
      prefetchedSnapshots = await fetchBlendedDeparturesForStops(
        client,
        favoriteTargets.map((entry) => entry.stop.id),
        {
          maxLookaheadMinutes: 30,
          minLookaheadMinutes: -2,
        },
      );
    } catch (error) {
      logger.warn("Failed to batch fetch favorite stop snapshots", { message: String(error) });
    }
  }

  const etaSnapshots = await fetchStopSnapshots(
    cache,
    client,
    limitedTargets,
    fetchStopSnapshot,
    prefetchedSnapshots,
  );
  timing.mark("etaFetch");

  const snapshotMap = new Map<string, BlendedDeparture[]>();
  etaSnapshots.forEach(({ stop, snapshot }) => {
    if (snapshot && snapshot.length > 0) {
      snapshotMap.set(stop.id, snapshot);
    }
  });

  const summarizeGroup = (group: StationGroup): HomeStopSummary => {
    if (group.stationStop.id === "place-north") {
      logger.debug("North Station group", { platformStopIds: Array.from(group.platformStopIds).slice(0, 5), totalPlatformStops: group.platformStopIds.size });
    }
    return toHomeStopSummary(
      group.stationStop,
      group.minDistance,
      aggregateDeparturesForGroup(group, snapshotMap),
      routeModes,
      Array.from(group.platformStopIds),
      useDb ? dbStopRoutesResolved : cache.getStopRouteMap()?.data,
    );
  };

  const nearbySummaries: HomeStopSummary[] = limitedNearbyGroups
    .map((group) => ({ group, departures: aggregateDeparturesForGroup(group, snapshotMap) }))
    .filter(({ departures }) => departures.length > 0)
    .map(({ group, departures }) =>
      toHomeStopSummary(
        group.stationStop,
        group.minDistance,
        departures,
        routeModes,
        Array.from(group.platformStopIds),
        useDb ? dbStopRoutesResolved : cache.getStopRouteMap()?.data,
      ),
    );

  const favoriteSummaryMap = new Map<string, HomeStopSummary>();
  favoriteGroupsMap.forEach((group, stationId) => {
    favoriteSummaryMap.set(stationId, summarizeGroup(group));
  });

  const favoriteSummaries: HomeStopSummary[] = [];
  const seenFavoriteStations = new Set<string>();
  options.favoriteStopIds.forEach((id) => {
    const stop = stopLookup.get(id);
    if (!stop) return;
    const meta = getCanonicalStationMeta(stop, stopLookup);
    if (!meta) return;
    if (seenFavoriteStations.has(meta.canonicalId)) return;
    const summary = favoriteSummaryMap.get(meta.canonicalId);
    if (summary) {
      seenFavoriteStations.add(meta.canonicalId);
      favoriteSummaries.push(summary);
    }
  });

  const response: HomeResponse = {
    favorites: favoriteSummaries,
    nearby: nearbySummaries,
    generatedAt: new Date().toISOString(),
  };
  timing.mark("responseBuilt");

  await cache.setHomeSnapshot(cacheKey, response);
  logger.debug("Home snapshot timing", {
    useDb,
    totalMs: timing.totalMs(),
    dbLoadMs: timing.marks.dbLoad,
    nearbyStopsMs: timing.marks.nearbyStops,
    etaFetchMs: timing.marks.etaFetch,
    responseMs: timing.marks.responseBuilt,
  });

  return response;
};
