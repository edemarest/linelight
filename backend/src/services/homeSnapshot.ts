import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaClient } from "../mbta/client";
import type { MbtaRoute, MbtaStop } from "../models/mbta";
import { haversineDistanceMeters } from "../utils/geo";
import { mapRouteTypeToMode } from "../utils/routeMode";
import type { HomeResponse, HomeStopSummary, HomeRouteSummary, Mode } from "@linelight/core";
import { getCachedStopEtaSnapshot, getStopEtaSnapshot } from "./etaService";
import type { BlendedDeparture } from "./etaBlender";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import { isBoardableKind, resolveStationKind } from "../utils/stationKind";
import { logger } from "../utils/logger";

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

const HOME_CACHE_COORD_PRECISION = 0.01; // ~1.1km
const HOME_CACHE_RADIUS_INCREMENT = 250;

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

const normalizeLabel = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
    const directionLabel =
      primary.directionId === 0 ? "Inbound" : primary.directionId === 1 ? "Outbound" : "Unknown";
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
): HomeStopSummary => {
  const routes = groupDeparturesByRoute(departures);
  const modes = Array.from(
    new Set(
      routes
        .map((route) => (route.routeId ? routeModes.get(route.routeId) : undefined))
        .filter((mode): mode is Mode => Boolean(mode)),
    ),
  );

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

type StopSnapshotFetcher = typeof getStopEtaSnapshot;

export const buildHomeSnapshot = async (
  cache: MbtaCache,
  client: MbtaClient,
  options: BuildHomeOptions,
  deps?: { fetchStopSnapshot?: StopSnapshotFetcher },
): Promise<HomeResponse> => {
  const cacheKey = buildHomeCacheKey(options);
  const cached = await cache.getHomeSnapshot(cacheKey);
  if (cached) {
    return cached;
  }

  const fetchStopSnapshot = deps?.fetchStopSnapshot ?? getStopEtaSnapshot;
  const stopsEntry = cache.getStops();
  const routesEntry = cache.getRoutes();

  const routeModes = buildRouteModeLookup(routesEntry?.data);
  const allStops = stopsEntry?.data ?? [];
  const stopLookup = new Map<string, MbtaStop>();
  allStops.forEach((stop) => stopLookup.set(stop.id, stop));
  const stationChildrenMap = buildStationChildrenMap(allStops);

  const nearbyStops = collectStopsWithinRadius(
    allStops,
    options.lat,
    options.lng,
    options.radiusMeters,
    options.limit * 4,
    cache.getStopRouteMap()?.data,
  );

  const nearbyGroupsMap = buildGroupsFromEntries(nearbyStops, stopLookup, stationChildrenMap);
  const orderedNearbyGroups = Array.from(nearbyGroupsMap.values()).sort(
    (a, b) => a.minDistance - b.minDistance,
  );
  const limitedNearbyGroups = orderedNearbyGroups.slice(0, options.limit);

  const favoriteStops = options.favoriteStopIds
    .map((id) => stopLookup.get(id))
    .filter((stop): stop is MbtaStop => Boolean(stop));

  const favoriteEntries = favoriteStops.map((stop) => ({
    stop,
    distance: haversineDistanceMeters(options.lat, options.lng, stop.attributes.latitude, stop.attributes.longitude),
  }));
  const favoriteGroupsMap = buildGroupsFromEntries(favoriteEntries, stopLookup, stationChildrenMap);

  const etaTargetStopIds = new Set<string>();
  const addTargetsFromGroup = (group: StationGroup | undefined) => {
    if (!group) return;
    group.platformStopIds.forEach((stopId) => etaTargetStopIds.add(stopId));
  };
  limitedNearbyGroups.forEach((group) => addTargetsFromGroup(group));
  favoriteGroupsMap.forEach((group) => addTargetsFromGroup(group));

  const uniqueStopTargets = Array.from(etaTargetStopIds)
    .map((id) => stopLookup.get(id))
    .filter((stop): stop is MbtaStop => Boolean(stop));

  const etaSnapshots = await Promise.all(
    uniqueStopTargets.map(async (stop) => {
      const cachedSnapshot = getCachedStopEtaSnapshot(cache, stop.id, {
        maxLookaheadMinutes: 30,
        minLookaheadMinutes: -2,
        stopName: stop.attributes.name,
      });
      if (cachedSnapshot) {
        return { stop, snapshot: cachedSnapshot };
      }
      try {
        const snapshot = await fetchStopSnapshot(client, stop.id, {
          maxLookaheadMinutes: 30,
          minLookaheadMinutes: -2,
        });
        return { stop, snapshot };
      } catch (error) {
        logger.error("Failed to fetch stop snapshot for home view", {
          stopId: stop.id,
          message: String(error),
        });
        return { stop, snapshot: null };
      }
    }),
  );

  const snapshotMap = new Map<string, BlendedDeparture[]>();
  etaSnapshots.forEach(({ stop, snapshot }) => {
    if (snapshot) {
      snapshotMap.set(stop.id, snapshot.departures);
    }
  });

  const summarizeGroup = (group: StationGroup): HomeStopSummary =>
    toHomeStopSummary(
      group.stationStop,
      group.minDistance,
      aggregateDeparturesForGroup(group, snapshotMap),
      routeModes,
      Array.from(group.platformStopIds),
    );

  const nearbySummaries: HomeStopSummary[] = limitedNearbyGroups.map(summarizeGroup);

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

  await cache.setHomeSnapshot(cacheKey, response);

  return response;
};
