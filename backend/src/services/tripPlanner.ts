// Multi-source trip planner: stitches DB graph + MBTA data + OSRM walking segments.
import type { MbtaClient } from "../mbta/client";
import type { MbtaCache } from "../cache/mbtaCache";
import type { MbtaPrediction, MbtaRoute, MbtaStop } from "../models/mbta";
import type {
  TripPlannerLeg,
  TripPlannerLegSource,
  TripPlannerMode,
  TripPlannerRequest,
  TripPlannerResponse,
} from "@linelight/core";
import polyline from "@mapbox/polyline";
import {
  getGraphEdgesByRoutesCached,
  getRoutesCachedLight,
  getStopsCachedLight,
  getStopRoutesCachedLight,
  getShapesByRouteCached,
  type DbRoute,
  type DbShape,
  type DbStop,
} from "../db";
import { logger } from "../utils/logger";
import { createTimings } from "../utils/timing";
import { ensureArray } from "../utils/collections";

interface GraphEdge {
  to: string;
  routeId: string;
  directionId: number;
  weightMinutes: number;
  mode: TripPlannerMode;
  isVirtual?: boolean;
  noTransferPenalty?: boolean;
  noLongDistancePenalty?: boolean;
}

export type DbStationGraph = {
  graph: Map<string, GraphEdge[]>;
  stationStopMap: Map<string, string>;
  stopToStationId: Map<string, string>;
  edgeStopIds: Set<string>;
};

type DbNearestStop = {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  distanceMeters: number;
};

type MbtaNearestStop = {
  stationId: string;
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  distanceMeters: number;
};

type NearestStop = DbNearestStop | MbtaNearestStop;

const isMbtaNearestStop = (value: NearestStop): value is MbtaNearestStop => "stationId" in value;

const OSRM_BASE_URL = process.env.OSRM_BASE_URL ?? "";
const OSRM_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS ?? "1500");
const DB_TIMEOUT_MS = Number(process.env.TRIP_PLANNER_DB_TIMEOUT_MS ?? "2000");
const OSRM_CACHE_TTL_MS = 10 * 60 * 1000;
const OSRM_CACHE_MAX_ENTRIES = 800;
const osrmCache = new Map<string, { timestamp: number; coords: [number, number][] }>();
const WALK_ONLY_DISTANCE_KM = Number(process.env.TRIP_PLANNER_WALK_ONLY_KM ?? "0.3");
const SHAPE_COORDS_TTL_MS = 6 * 60 * 60 * 1000;
const shapeCoordsCache = new Map<string, { timestamp: number; coords: [number, number][] }>();
const SHAPE_CACHE_MAX_ENTRIES = Number(process.env.TRIP_PLANNER_SHAPE_CACHE_MAX ?? "2000");

const fetchWalkPolylineCoords = async (
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): Promise<[number, number][] | null> => {
  if (!OSRM_BASE_URL) return null;
  const cacheKey = `${fromLat.toFixed(5)},${fromLon.toFixed(5)}-${toLat.toFixed(5)},${toLon.toFixed(5)}`;
  const cached = osrmCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < OSRM_CACHE_TTL_MS) {
    osrmCache.delete(cacheKey);
    osrmCache.set(cacheKey, cached);
    return cached.coords;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
  try {
    const url = new URL(`/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}`, OSRM_BASE_URL);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "polyline");
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as { routes?: Array<{ geometry?: string }> };
    const geometry = payload.routes?.[0]?.geometry;
    if (!geometry) return null;
    const decoded = polyline.decode(geometry) as [number, number][];
    const coords: [number, number][] = decoded.map(([lat, lon]) => [lat, lon]);
    if (coords.length < 2) return null;
    osrmCache.set(cacheKey, { timestamp: Date.now(), coords });
    if (osrmCache.size > OSRM_CACHE_MAX_ENTRIES) {
      const oldestKey = osrmCache.keys().next().value;
      if (oldestKey) osrmCache.delete(oldestKey);
    }
    return coords;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const decodePolylineCoords = (encoded: string): [number, number][] => polyline.decode(encoded) as [number, number][];

const findClosestIndex = (coords: [number, number][], lat: number, lon: number): { index: number; distance: number } => {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  coords.forEach(([coordLat, coordLon], idx) => {
    const dist = haversineMeters(lat, lon, coordLat, coordLon);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = idx;
    }
  });
  return { index: bestIndex, distance: bestDistance };
};

const buildRouteSegmentPolyline = async (
  routeId: string,
  from: { lat?: number | null; lon?: number | null },
  to: { lat?: number | null; lon?: number | null },
): Promise<[number, number][] | null> => {
  if (from.lat == null || from.lon == null || to.lat == null || to.lon == null) return null;
  let shapes: DbShape[] = [];
  try {
    shapes = await getShapesByRouteCached(routeId);
  } catch (error) {
    logger.warn("Route shapes unavailable, skipping segment polyline", {
      routeId,
      message: String(error),
    });
    return null;
  }
  if (shapes.length === 0) return null;
  let best: { coords: [number, number][]; fromIndex: number; toIndex: number; score: number } | null = null;
  for (const shape of shapes) {
    if (!shape.polyline) continue;
    const cachedCoords = shapeCoordsCache.get(shape.polyline);
    const coords =
      cachedCoords && Date.now() - cachedCoords.timestamp < SHAPE_COORDS_TTL_MS
        ? cachedCoords.coords
        : decodePolylineCoords(shape.polyline);
    if (!cachedCoords || Date.now() - cachedCoords.timestamp >= SHAPE_COORDS_TTL_MS) {
      shapeCoordsCache.set(shape.polyline, { timestamp: Date.now(), coords });
      if (shapeCoordsCache.size > SHAPE_CACHE_MAX_ENTRIES) {
        shapeCoordsCache.clear();
      }
    }
    if (coords.length < 2) continue;
    const fromMatch = findClosestIndex(coords, from.lat, from.lon);
    const toMatch = findClosestIndex(coords, to.lat, to.lon);
    const score = fromMatch.distance + toMatch.distance;
    if (!best || score < best.score) {
      best = { coords, fromIndex: fromMatch.index, toIndex: toMatch.index, score };
    }
  }
  if (!best) return null;
  const start = Math.min(best.fromIndex, best.toIndex);
  const end = Math.max(best.fromIndex, best.toIndex);
  const slice = best.coords.slice(start, end + 1);
  if (slice.length < 2) return null;
  return best.fromIndex <= best.toIndex ? slice : slice.reverse();
};

type DbCandidateStop = {
  stopId: string;
  stationId: string;
  distanceMeters: number;
  walkMinutes: number;
  routeIds: Set<string>;
  modes: Set<TripPlannerMode>;
};

const MODE_ROUTE_TYPES: Record<TripPlannerMode, number[]> = {
  subway: [0, 1],
  bus: [3],
  commuter_rail: [2],
  ferry: [4],
  other: [5, 6, 7],
};

const DEFAULT_SPEED_MPH: Record<TripPlannerMode, number> = {
  subway: 25,
  bus: 12,
  commuter_rail: 45,
  ferry: 20,
  other: 15,
};

const DEFAULT_WAIT_MINUTES: Record<TripPlannerMode, number> = {
  subway: 8,
  bus: 15,
  commuter_rail: 30,
  ferry: 20,
  other: 15,
};

const TRANSFER_PENALTY_MINUTES = 2;
const TRANSFER_SAME_STATION_PENALTY_MINUTES = 12;
const TRANSFER_DISTANCE_PENALTY_PER_KM = 0;
const MAX_WAIT_MINUTES = 30;
const LATE_NIGHT_START_HOUR = 23;
const LATE_NIGHT_END_HOUR = 5;
const LONG_DISTANCE_KM = 25;
const BUS_LONG_DISTANCE_KM = Number(process.env.TRIP_PLANNER_BUS_LONG_DISTANCE_KM ?? "25");
const NON_CR_LONG_DISTANCE_PENALTY = 10;
const BUS_DIRECT_DISTANCE_KM = 12;
const BUS_DIRECT_BONUS_MINUTES = 8;
const MAX_CANDIDATES_PER_MODE = 6;
const MAX_TOTAL_CANDIDATES = 8;
const LONG_DISTANCE_ROUTE_LIMIT_FACTOR = 0.85;
const LONG_DISTANCE_ROUTE_RADIUS_FACTOR = 0.85;
const LONG_DISTANCE_CANDIDATE_FACTOR = 0.9;
const VIRTUAL_ORIGIN_NODE = "__tp_origin__";
const VIRTUAL_DEST_NODE = "__tp_dest__";
const VIRTUAL_ROUTE_ID = "__tp_virtual__";
const ENABLE_REALTIME_PREDICTIONS = false;
const TRANSFER_ROUTE_ID = "__transfer__";
const TRANSFER_WALK_RADIUS_METERS = 500;
const TRANSFER_MAX_NEIGHBORS = 6;
const TRANSFER_GRID_SIZE_DEGREES = 0.005;
const MAX_PATH_HOPS = 2000;
const HOP_PENALTY_MINUTES = 0.1;
const MAX_SEARCH_HOPS = 800;
const CR_LATE_NIGHT_HEADWAY_DEFAULT = 60;
const CR_LATE_NIGHT_HEADWAY_OVERRIDES: Record<string, number> = {
  "CR-Fairmount": 30,
  "CR-Providence": 60,
  "CR-Greenbush": 60,
  "CR-Kingston": 60,
  "CR-Middleborough": 60,
  "CR-Worcester": 60,
  "CR-Newburyport": 60,
  "CR-Haverhill": 60,
  "CR-Lowell": 60,
  "CR-Fitchburg": 60,
  "CR-Needham": 60,
  "CR-Franklin": 60,
};
const MBTA_TIMEOUT_MS = 4000;
const ROUTE_RADIUS_METERS = Number(process.env.TRIP_PLANNER_ROUTE_RADIUS_METERS ?? "8000");
const ROUTE_CANDIDATE_LIMIT = Number(process.env.TRIP_PLANNER_ROUTE_CANDIDATE_LIMIT ?? "80");
const MAX_BUS_ROUTES = Number(process.env.TRIP_PLANNER_MAX_BUS_ROUTES ?? "40");
const MAX_RAIL_ROUTES = Number(process.env.TRIP_PLANNER_MAX_RAIL_ROUTES ?? "30");
const MAX_TOTAL_ROUTES = Number(process.env.TRIP_PLANNER_MAX_TOTAL_ROUTES ?? "80");
const BUS_ROUTE_RADIUS_METERS = Number(process.env.TRIP_PLANNER_BUS_ROUTE_RADIUS_METERS ?? "4000");
const BUS_ROUTE_CANDIDATE_LIMIT = Number(process.env.TRIP_PLANNER_BUS_ROUTE_CANDIDATE_LIMIT ?? "30");
const TRIP_PLANNER_DEBUG = process.env.TRIP_PLANNER_DEBUG === "true";

const parseDefaultModes = (value: string | undefined): TripPlannerMode[] | null => {
  if (!value) return null;
  const modes = value
    .split(",")
    .map((mode) => mode.trim())
    .filter(Boolean) as TripPlannerMode[];
  return modes.length ? modes : null;
};

const buildTripPlannerLimits = (tripDistanceKm: number) => {
  const isLongTrip = tripDistanceKm >= LONG_DISTANCE_KM;
  const limitFactor = isLongTrip ? LONG_DISTANCE_ROUTE_LIMIT_FACTOR : 1;
  const radiusFactor = isLongTrip ? LONG_DISTANCE_ROUTE_RADIUS_FACTOR : 1;
  const candidateFactor = isLongTrip ? LONG_DISTANCE_CANDIDATE_FACTOR : 1;
  const routeCandidateLimit = Math.max(10, Math.round(ROUTE_CANDIDATE_LIMIT * limitFactor));
  const busRouteCandidateLimit = Math.max(8, Math.round(BUS_ROUTE_CANDIDATE_LIMIT * limitFactor));
  const maxBusRoutes = Math.max(10, Math.round(MAX_BUS_ROUTES * limitFactor));
  const maxRailRoutes = Math.max(10, Math.round(MAX_RAIL_ROUTES * limitFactor));
  const maxTotalRoutes = Math.max(20, Math.round(MAX_TOTAL_ROUTES * limitFactor));
  const perModeCandidates = Math.max(2, Math.round(MAX_CANDIDATES_PER_MODE * candidateFactor));
  const totalCandidates = Math.max(perModeCandidates + 1, Math.round(MAX_TOTAL_CANDIDATES * candidateFactor));
  return {
    isLongTrip,
    routeRadiusMeters: Math.round(ROUTE_RADIUS_METERS * radiusFactor),
    routeCandidateLimit,
    busRouteRadiusMeters: Math.round(BUS_ROUTE_RADIUS_METERS * radiusFactor),
    busRouteCandidateLimit,
    maxBusRoutes,
    maxRailRoutes,
    maxTotalRoutes,
    candidateLimits: { perMode: perModeCandidates, total: totalCandidates },
  };
};

const collectNearbyRouteScores = (
  stops: DbStop[],
  stopRoutes: Map<string, Set<string>>,
  routeModeMap: Map<string, TripPlannerMode>,
  requestedModes: TripPlannerMode[],
  lat: number,
  lon: number,
  radiusMeters: number,
  limit: number,
) => {
  const candidates: Array<{ stopId: string; distance: number }> = [];
  stops.forEach((stop) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
    const dist = haversineMeters(lat, lon, stop.lat, stop.lon);
    if (dist > radiusMeters) return;
    candidates.push({ stopId: stop.id, distance: dist });
  });
  candidates.sort((a, b) => a.distance - b.distance);
  const selected = candidates.slice(0, limit);
  const routeScores = new Map<string, number>();
  selected.forEach(({ stopId, distance }) => {
    const routes = stopRoutes.get(stopId);
    if (!routes) return;
    routes.forEach((routeId) => {
      const mode = routeModeMap.get(routeId);
      if (mode && requestedModes.includes(mode)) {
        const existing = routeScores.get(routeId);
        const score = distance;
        if (existing == null || score < existing) {
          routeScores.set(routeId, score);
        }
      }
    });
  });
  return routeScores;
};

const metersToMiles = (meters: number) => meters / 1609.344;

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result as T | null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const GRAPH_TTL_MS = 6 * 60 * 60 * 1000;
const STOP_LOOKUP_TTL_MS = 12 * 60 * 60 * 1000;
type DbGraphCacheEntry = {
  key: string;
  builtAt: number;
  graph: Map<string, GraphEdge[]>;
  stationStopMap: Map<string, string>;
  stopToStationId: Map<string, string>;
  edgeStopIds: Set<string>;
  stopRouteMap: Map<string, Set<string>>;
  stationCoordLookup: Map<string, { lat: number; lon: number }>;
};
let dbGraphCache: DbGraphCacheEntry | null = null;

const buildWalkOnlyPlan = async (params: TripPlannerRequest): Promise<TripPlannerResponse> => {
  const distMeters = haversineMeters(params.originLat, params.originLon, params.destLat, params.destLon);
  const walkMinutesTotal = walkMinutes(distMeters);
  const coords =
    (await fetchWalkPolylineCoords(params.originLat, params.originLon, params.destLat, params.destLon)) ??
    [
      [params.originLat, params.originLon],
      [params.destLat, params.destLon],
    ];
  const walkPolyline = coords.length >= 2 ? polyline.encode(coords) : null;
  const legs: TripPlannerLeg[] = [
    {
      mode: "walk",
      from: { label: "Origin", lat: params.originLat, lon: params.originLon },
      to: { label: "Destination", lat: params.destLat, lon: params.destLon },
      distanceMeters: Math.round(distMeters),
      durationMinutes: Math.round(walkMinutesTotal * 10) / 10,
      style: "walk",
    },
  ];
  return {
    generatedAt: new Date().toISOString(),
    request: params,
    summary: {
      totalMinutes: Math.round(walkMinutesTotal * 10) / 10,
      walkMinutes: Math.round(walkMinutesTotal * 10) / 10,
      waitMinutes: 0,
      rideMinutes: 0,
      transfers: 0,
      confidence: "fallback",
    },
    primary: {
      tripId: `walk-${Date.now()}`,
      legs,
      map: {
        bounds: [
          [Math.min(params.originLat, params.destLat), Math.min(params.originLon, params.destLon)],
          [Math.max(params.originLat, params.destLat), Math.max(params.originLon, params.destLon)],
        ],
        walkPolyline,
        walkPolylines: walkPolyline ? [walkPolyline] : [],
        lineShapes: [],
      },
    },
    alternates: [],
    warnings: [
      {
        code: "walk_only",
        message: "Trip is within walking distance. Showing walking directions instead.",
      },
    ],
  };
};

// In-memory cache for speed; switch to Redis for multi-instance deployments.
let graphCache:
  | {
      key: string;
      builtAt: number;
      edges: Map<string, GraphEdge[]>;
      stationStopMap: Map<string, string>;
    }
  | undefined;
let stopLookupCache:
  | {
      builtAt: number;
      lookup: Map<string, MbtaStop>;
    }
  | undefined;

const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const r = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const walkMinutes = (meters: number, mph = 3) => (metersToMiles(meters) / mph) * 60;

const getEasternHour = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  return hourPart ? Number(hourPart) : new Date(timestamp).getHours();
};

const isLateNight = (timestamp: number) => {
  const hour = getEasternHour(timestamp);
  return hour >= LATE_NIGHT_START_HOUR || hour < LATE_NIGHT_END_HOUR;
};

const buildStopRef = (stopId: string, name?: string, lat?: number, lon?: number) => {
  const ref: { stopId?: string; name?: string; lat?: number; lon?: number } = { stopId };
  if (name) {
    ref.name = name;
  }
  if (typeof lat === "number") {
    ref.lat = lat;
  }
  if (typeof lon === "number") {
    ref.lon = lon;
  }
  return ref;
};

const pickStationId = (stop: MbtaStop) => {
  const rel = (stop as any).relationships?.parent_station?.data;
  if (rel?.id) return rel.id as string;
  return stop.id;
};

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

const buildDbRoute = (route: DbRoute): MbtaRoute => ({
  id: route.id,
  type: "route",
  attributes: {
    short_name: route.shortName ?? null,
    long_name: route.longName ?? "",
    description: null,
    type: route.type as any,
    color: route.color ?? null,
    text_color: route.textColor ?? null,
    sort_order: null,
  },
});

const buildStopRouteMapFromEdges = (
  edges: Array<{ fromStopId: string; toStopId: string; routeId: string }>,
) => {
  const map = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    const add = (stopId: string) => {
      const set = map.get(stopId) ?? new Set<string>();
      set.add(edge.routeId);
      map.set(stopId, set);
    };
    add(edge.fromStopId);
    add(edge.toStopId);
  });
  return map;
};

const buildGridKey = (lat: number, lon: number, size = TRANSFER_GRID_SIZE_DEGREES) => {
  const latKey = Math.floor(lat / size);
  const lonKey = Math.floor(lon / size);
  return `${latKey}|${lonKey}`;
};

const addTransferEdges = (
  graph: Map<string, GraphEdge[]>,
  stationCoordLookup: Map<string, { lat: number; lon: number }>,
  stationModes?: Map<string, Set<TripPlannerMode>>,
) => {
  if (stationCoordLookup.size === 0) return;
  const grid = new Map<string, string[]>();
  stationCoordLookup.forEach((coord, stationId) => {
    const key = buildGridKey(coord.lat, coord.lon);
    const bucket = grid.get(key) ?? [];
    bucket.push(stationId);
    grid.set(key, bucket);
  });

  stationCoordLookup.forEach((coord, stationId) => {
    const originKey = buildGridKey(coord.lat, coord.lon);
    const parts = originKey.split("|");
    if (parts.length < 2) return;
    const latKey = Number(parts[0]);
    const lonKey = Number(parts[1]);
    if (!Number.isFinite(latKey) || !Number.isFinite(lonKey)) return;
    const neighborCandidates: Array<{ stationId: string; distanceMeters: number }> = [];
    const seen = new Set<string>();
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const key = `${latKey + dLat}|${lonKey + dLon}`;
        const bucket = grid.get(key);
        if (!bucket) continue;
        bucket.forEach((neighborId) => {
          if (neighborId === stationId || seen.has(neighborId)) return;
          const neighborCoord = stationCoordLookup.get(neighborId);
          if (!neighborCoord) return;
          const dist = haversineMeters(coord.lat, coord.lon, neighborCoord.lat, neighborCoord.lon);
          if (dist <= TRANSFER_WALK_RADIUS_METERS) {
            neighborCandidates.push({ stationId: neighborId, distanceMeters: dist });
          }
          seen.add(neighborId);
        });
      }
    }

    if (neighborCandidates.length === 0) return;
    neighborCandidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
    neighborCandidates.slice(0, TRANSFER_MAX_NEIGHBORS).forEach((neighbor) => {
      const originModes = stationModes?.get(stationId);
      const neighborModes = stationModes?.get(neighbor.stationId);
      if (originModes && neighborModes) {
        const originBusOnly = originModes.size === 1 && originModes.has("bus");
        const neighborBusOnly = neighborModes.size === 1 && neighborModes.has("bus");
        if (originBusOnly && neighborBusOnly) {
          return;
        }
      }
      const list = graph.get(stationId) ?? [];
      const exists = list.some((edge) => edge.to === neighbor.stationId && edge.routeId === TRANSFER_ROUTE_ID);
      if (!exists) {
        list.push({
          to: neighbor.stationId,
          routeId: TRANSFER_ROUTE_ID,
          directionId: 0,
          weightMinutes: walkMinutes(neighbor.distanceMeters),
          mode: "other",
          noTransferPenalty: true,
          noLongDistancePenalty: true,
        });
        graph.set(stationId, list);
      }
    });
  });
};

const collectCandidateStops = (
  stops: MbtaStop[],
  lat: number,
  lon: number,
  edgeStopIds: Set<string>,
  stopToStationId: Map<string, string>,
  stopRouteMap: Map<string, Set<string>>,
  routeModeMap: Map<string, TripPlannerMode>,
  requestedModes: TripPlannerMode[],
  maxWalkMinutes?: number,
  limits?: { perMode: number; total: number },
) => {
  const candidates: DbCandidateStop[] = [];
  stops.forEach((stop) => {
    if (!edgeStopIds.has(stop.id)) return;
    const attrs = stop.attributes;
    if (!Number.isFinite(attrs.latitude) || !Number.isFinite(attrs.longitude)) return;
    const routeIds = stopRouteMap.get(stop.id) ?? new Set<string>();
    const modes = new Set<TripPlannerMode>();
    routeIds.forEach((routeId) => {
      const mode = routeModeMap.get(routeId);
      if (mode) modes.add(mode);
    });
    const hasRequestedMode = requestedModes.some((mode) => modes.has(mode));
    if (!hasRequestedMode) return;
    const dist = haversineMeters(lat, lon, attrs.latitude, attrs.longitude);
    const walkMin = walkMinutes(dist);
    if (maxWalkMinutes !== undefined && walkMin > maxWalkMinutes) return;
    candidates.push({
      stopId: stop.id,
      stationId: stopToStationId.get(stop.id) ?? stop.id,
      distanceMeters: dist,
      walkMinutes: walkMin,
      routeIds,
      modes,
    });
  });

  const perMode = new Map<TripPlannerMode, DbCandidateStop[]>();
  candidates.forEach((candidate) => {
    requestedModes.forEach((mode) => {
      if (!candidate.modes.has(mode)) return;
      const list = perMode.get(mode) ?? [];
      list.push(candidate);
      perMode.set(mode, list);
    });
  });

  const selected = new Map<string, DbCandidateStop>();
  const perModeLimit = Math.max(1, limits?.perMode ?? MAX_CANDIDATES_PER_MODE);
  const totalLimit = Math.max(perModeLimit, limits?.total ?? MAX_TOTAL_CANDIDATES);
  perMode.forEach((list) => {
    list.sort((a, b) => a.distanceMeters - b.distanceMeters);
    list.slice(0, perModeLimit).forEach((candidate) => {
      const existing = selected.get(candidate.stationId);
      if (!existing || existing.distanceMeters > candidate.distanceMeters) {
        selected.set(candidate.stationId, candidate);
      }
    });
  });

  return Array.from(selected.values()).sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, totalLimit);
};

const buildConnectivityDebug = (
  edges: Map<string, GraphEdge[]>,
  originCandidates: DbCandidateStop[],
  destinationCandidates: DbCandidateStop[],
  maxExplored = 50000,
) => {
  const destinationsByStation = new Map<string, DbCandidateStop>();
  destinationCandidates.forEach((candidate) => destinationsByStation.set(candidate.stationId, candidate));
  const destinationSet = new Set(destinationsByStation.keys());
  const unreachableOrigins: string[] = [];
  const reachableOrigins: Array<{ origin: string; reachableCount: number; sampleDestination?: string }> = [];
  const originSamplePairs: Array<{ origin: string; destination: string }> = [];

  const bfs = (start: string) => {
    const queue: string[] = [start];
    const visited = new Set<string>([start]);
    const reachableDestinations = new Set<string>();
    let explored = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      explored += 1;
      if (destinationSet.has(node)) {
        reachableDestinations.add(node);
        if (reachableDestinations.size >= 3) {
          return { reachableDestinations, explored, truncated: false };
        }
      }
      if (explored >= maxExplored) {
        return { reachableDestinations, explored, truncated: true };
      }
      const outgoing = edges.get(node) ?? [];
      for (const edge of outgoing) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
    return { reachableDestinations, explored, truncated: false };
  };

  originCandidates.forEach((originCandidate) => {
    const { reachableDestinations } = bfs(originCandidate.stationId);
    if (reachableDestinations.size === 0) {
      unreachableOrigins.push(originCandidate.stationId);
      const nearestDestination = destinationCandidates[0];
      if (nearestDestination) {
        originSamplePairs.push({ origin: originCandidate.stationId, destination: nearestDestination.stationId });
      }
    } else {
      const sample = reachableDestinations.values().next().value as string | undefined;
      reachableOrigins.push({
        origin: originCandidate.stationId,
        reachableCount: reachableDestinations.size,
        ...(sample ? { sampleDestination: sample } : {}),
      });
    }
  });

  return {
    originCandidates: originCandidates.length,
    destinationCandidates: destinationCandidates.length,
    unreachableOrigins: unreachableOrigins.slice(0, 6),
    reachableOrigins: reachableOrigins.slice(0, 6),
    samplePairs: originSamplePairs.slice(0, 6),
  };
};

export const buildStationGraphFromDb = (
  dbEdges: Array<{
    fromStopId: string;
    toStopId: string;
    routeId: string;
    directionId: number;
    weightMinutes: number | null;
  }>,
  dbStops: DbStop[],
  dbRoutes: DbRoute[],
  routeIds: string[],
): DbStationGraph => {
  const stopToStationId = new Map<string, string>(
    dbStops.map((stop) => [stop.id, stop.parentStationId ?? stop.id]),
  );
  const stopLookup = new Map(dbStops.map((stop) => [stop.id, stop]));
  const routeTypeMap = new Map(dbRoutes.map((route) => [route.id, route.type]));
  const edgeStopIds = new Set<string>(dbEdges.flatMap((edge) => [edge.fromStopId, edge.toStopId]));
  const graph = new Map<string, GraphEdge[]>();
  dbEdges.forEach((edge) => {
    if (!routeIds.includes(edge.routeId)) return;
    const fromStation = stopToStationId.get(edge.fromStopId) ?? edge.fromStopId;
    const toStation = stopToStationId.get(edge.toStopId) ?? edge.toStopId;
    if (!fromStation || !toStation || fromStation === toStation) return;
    const fromStop = stopLookup.get(edge.fromStopId);
    const toStop = stopLookup.get(edge.toStopId);
    const routeType = routeTypeMap.get(edge.routeId);
    const mode =
      routeType === 0 || routeType === 1
        ? "subway"
        : routeType === 2
          ? "commuter_rail"
          : routeType === 3
            ? "bus"
            : routeType === 4
              ? "ferry"
              : "other";
    const distMeters =
      fromStop && toStop ? haversineMeters(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon) : 0;
    const weightMinutes =
      edge.weightMinutes && edge.weightMinutes > 0
        ? edge.weightMinutes
        : distMeters > 0
          ? walkMinutes(distMeters, DEFAULT_SPEED_MPH[mode])
          : 2;
    const list = graph.get(fromStation) ?? [];
    list.push({ to: toStation, routeId: edge.routeId, directionId: edge.directionId, weightMinutes, mode });
    graph.set(fromStation, list);
  });

  const stationStopMap = new Map<string, string>();
  dbStops.forEach((stop) => {
    if (!edgeStopIds.has(stop.id)) return;
    const stationId = stop.parentStationId ?? stop.id;
    if (!stationStopMap.has(stationId)) {
      stationStopMap.set(stationId, stop.id);
    }
  });

  return {
    graph,
    stationStopMap,
    stopToStationId,
    edgeStopIds,
  };
};

const getStopLookup = async (client: MbtaClient, cache: MbtaCache) => {
  if (stopLookupCache && Date.now() - stopLookupCache.builtAt < STOP_LOOKUP_TTL_MS) {
    return stopLookupCache.lookup;
  }
  const cached = cache.getStops();
  if (cached?.data?.length) {
    const lookup = new Map(cached.data.map((stop) => [stop.id, stop]));
    stopLookupCache = { builtAt: Date.now(), lookup };
    return lookup;
  }
  const response = await client.getStops({ "page[limit]": 10000 });
  const lookup = new Map(ensureArray(response.data).map((stop) => [stop.id, stop]));
  stopLookupCache = { builtAt: Date.now(), lookup };
  return lookup;
};

const getDbGraphBundle = (
  routeIds: string[],
  dbEdges: Array<{ fromStopId: string; toStopId: string; routeId: string; directionId: number; weightMinutes: number | null }>,
  dbStops: DbStop[],
  dbRoutes: DbRoute[],
): DbGraphCacheEntry => {
  const graphKey = routeIds.slice().sort().join("|");
  if (dbGraphCache && dbGraphCache.key === graphKey && Date.now() - dbGraphCache.builtAt < GRAPH_TTL_MS) {
    return dbGraphCache;
  }
  const routeModeMap = new Map<string, TripPlannerMode>(
    dbRoutes.map((route) => [route.id, routeMode(buildDbRoute(route))]),
  );
  const filteredEdges = dbEdges.filter((edge) => routeIds.includes(edge.routeId));
  const stationGraph = buildStationGraphFromDb(filteredEdges, dbStops, dbRoutes, routeIds);
  const stopRouteMap = buildStopRouteMapFromEdges(filteredEdges);
  const stationModes = new Map<string, Set<TripPlannerMode>>();
  stopRouteMap.forEach((routeIds, stopId) => {
    const stationId = stationGraph.stopToStationId.get(stopId) ?? stopId;
    const modeSet = stationModes.get(stationId) ?? new Set<TripPlannerMode>();
    routeIds.forEach((routeId) => {
      const mode = routeModeMap.get(routeId);
      if (mode) modeSet.add(mode);
    });
    if (modeSet.size > 0) {
      stationModes.set(stationId, modeSet);
    }
  });
  const stationCoordLookup = new Map<string, { lat: number; lon: number }>();
  dbStops.forEach((stop) => {
    const stationId = stop.parentStationId ?? stop.id;
    if (!stationCoordLookup.has(stationId)) {
      stationCoordLookup.set(stationId, { lat: stop.lat, lon: stop.lon });
    }
  });
  addTransferEdges(stationGraph.graph, stationCoordLookup, stationModes);
  dbGraphCache = {
    key: graphKey,
    builtAt: Date.now(),
    graph: stationGraph.graph,
    stationStopMap: stationGraph.stationStopMap,
    stopToStationId: stationGraph.stopToStationId,
    edgeStopIds: stationGraph.edgeStopIds,
    stopRouteMap,
    stationCoordLookup,
  };
  return dbGraphCache;
};

const nearestStation = async (
  client: MbtaClient,
  lat: number,
  lon: number,
  radius = 0.01,
): Promise<MbtaNearestStop | null> => {
  const response = await client.getStops({
    "filter[latitude]": lat,
    "filter[longitude]": lon,
    "filter[radius]": radius,
    sort: "distance",
    "page[limit]": 10,
  });
  const stops = ensureArray(response.data);
  if (!stops.length) return null;

  const candidates = stops.map((stop) => {
    const stationId = pickStationId(stop);
    const attrs = stop.attributes;
    const dist = haversineMeters(lat, lon, attrs.latitude, attrs.longitude);
    return {
      stationId,
      stopId: stop.id,
      name: attrs.name,
      lat: attrs.latitude,
      lon: attrs.longitude,
      distanceMeters: dist,
    };
  });

  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return candidates[0] ?? null;
};

const nearestStopFromDb = (
  stops: MbtaStop[],
  lat: number,
  lon: number,
  radiusMeters = 5000,
  allowedStopIds?: Set<string>,
): DbNearestStop | null => {
  let best: DbNearestStop | null = null;
  for (const stop of stops) {
    if (allowedStopIds && !allowedStopIds.has(stop.id)) continue;
    const attrs = stop.attributes;
    if (attrs.latitude == null || attrs.longitude == null) continue;
    const dist = haversineMeters(lat, lon, attrs.latitude, attrs.longitude);
    if (dist > radiusMeters) continue;
    if (!best || dist < best.distanceMeters) {
      best = {
        stopId: stop.id,
        name: attrs.name,
        lat: attrs.latitude,
        lon: attrs.longitude,
        distanceMeters: dist,
      };
    }
  }
  return best;
};

const routeMode = (route: MbtaRoute | undefined): TripPlannerMode => {
  const type = route?.attributes.type;
  if (type === 0 || type === 1) return "subway";
  if (type === 2) return "commuter_rail";
  if (type === 3) return "bus";
  if (type === 4) return "ferry";
  return "other";
};

const buildGraph = async (
  client: MbtaClient,
  routeIds: string[],
  stationStopMap: Map<string, string>,
  routeModeMap: Map<string, TripPlannerMode>,
) => {
  const graphKey = routeIds.slice().sort().join("|");
  if (graphCache && graphCache.key === graphKey && Date.now() - graphCache.builtAt < GRAPH_TTL_MS) {
    stationStopMap.clear();
    for (const [stationId, stopId] of graphCache.stationStopMap.entries()) {
      stationStopMap.set(stationId, stopId);
    }
    return graphCache.edges;
  }

  const edges = new Map<string, GraphEdge[]>();
  const stationCoords = new Map<string, { lat: number; lon: number }>();

  for (const routeId of routeIds) {
    const patternResponse = await client.getRoutePatterns({ "filter[route]": routeId });
    const patterns = ensureArray(patternResponse.data);
    for (const pattern of patterns) {
      const directionId = pattern.attributes.direction_id;
      const tripsResponse = await client.getTrips({
        "filter[route_pattern]": pattern.id,
        include: "stops",
        "page[limit]": 1,
      });
      const trips = ensureArray(tripsResponse.data);
      const trip = trips[0];
      if (!trip) continue;

      const stopSeq = ensureArray((trip as any).relationships?.stops?.data);
      if (!stopSeq.length) continue;

      const included = new Map<string, MbtaStop>();
      for (const resource of tripsResponse.included ?? []) {
        if (resource.type === "stop") {
          included.set(resource.id, resource as unknown as MbtaStop);
        }
      }

      const stationSeq: string[] = [];
      for (const stopRef of stopSeq) {
        const stop = included.get(stopRef.id);
        if (!stop) continue;
        const stationId = pickStationId(stop);
        stationSeq.push(stationId);
        if (!stationStopMap.has(stationId)) {
          stationStopMap.set(stationId, stop.id);
        }
        if (!stationCoords.has(stationId)) {
          const lat = stop.attributes.latitude;
          const lon = stop.attributes.longitude;
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            stationCoords.set(stationId, { lat, lon });
          }
        }
      }

      for (let i = 0; i < stationSeq.length - 1; i += 1) {
        const from = stationSeq[i];
        const to = stationSeq[i + 1];
        if (!from || !to || from === to) continue;
        const list = edges.get(from) ?? [];
        const mode = routeModeMap.get(routeId) ?? "other";
        const fromCoord = stationCoords.get(from);
        const toCoord = stationCoords.get(to);
        const distMeters =
          fromCoord && toCoord ? haversineMeters(fromCoord.lat, fromCoord.lon, toCoord.lat, toCoord.lon) : 0;
        const weightMinutes =
          distMeters > 0 ? walkMinutes(distMeters, DEFAULT_SPEED_MPH[mode]) : 2;
        list.push({ to, routeId, directionId, weightMinutes, mode });
        edges.set(from, list);
      }
    }
  }

  addTransferEdges(edges, stationCoords);

  graphCache = {
    key: graphKey,
    builtAt: Date.now(),
    edges,
    stationStopMap: new Map(stationStopMap.entries()),
  };

  return edges;
};

const bfsPath = (edges: Map<string, GraphEdge[]>, start: string, goal: string) => {
  const queue: string[] = [start];
  const prev = new Map<string, string | null>([[start, null]]);
  const prevEdge = new Map<string, GraphEdge>();

  while (queue.length) {
    const node = queue.shift()!;
    if (node === goal) break;
    const outgoing = edges.get(node) ?? [];
    for (const edge of outgoing) {
      if (prev.has(edge.to)) continue;
      prev.set(edge.to, node);
      prevEdge.set(edge.to, edge);
      queue.push(edge.to);
    }
  }

  if (!prev.has(goal)) return [];
  const path: Array<{ from: string; to: string; edge: GraphEdge }> = [];
  let node = goal;
  while (node !== start) {
    const from = prev.get(node);
    if (!from) break;
    const edge = prevEdge.get(node);
    if (!edge) break;
    path.push({ from, to: node, edge });
    node = from;
  }
  return path.reverse();
};

export const findWeightedPath = (
  edges: Map<string, GraphEdge[]>,
  start: string,
  goal: string,
  options: {
    stationCoordLookup?: Map<string, { lat: number; lon: number }>;
    destination?: { lat: number; lon: number };
    longDistanceKm?: number;
    maxTransfers?: number;
  } = {},
): { path: Array<{ from: string; to: string; edge: GraphEdge }>; cost: number } => {
  const getCoordPenalty = (_stationId: string) => 0;
  const maxStates = Number(process.env.TRIP_PLANNER_MAX_STATES ?? "200000");
  const maxSearchMs = Number(process.env.TRIP_PLANNER_MAX_SEARCH_MS ?? "2500");
  const searchStart = Date.now();
  let expandedStates = 0;
  let maxQueueSize = 0;
  let maxDistSize = 0;
  let maxHops = 0;

  const dist = new Map<string, number>();
  const transfersByKey = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const prevEdge = new Map<string, GraphEdge>();
  const queue = new MinHeap<{ key: string; cost: number; node: string; routeId: string | null; transfers: number; hops: number }>(
    (a, b) => a.cost - b.cost,
  );

  const pushState = (node: string, routeId: string | null, transfers: number, cost: number, hops: number) => {
    const key = `${node}|${routeId ?? "none"}`;
    const existing = dist.get(key);
    const existingTransfers = transfersByKey.get(key);
    if (existing !== undefined) {
      if (cost > existing) return;
      if (cost === existing && existingTransfers !== undefined && existingTransfers <= transfers) return;
    }
    dist.set(key, cost);
    transfersByKey.set(key, transfers);
    queue.push({ key, cost, node, routeId, transfers, hops });
  };

  pushState(start, null, 0, 0, 0);

  let stopReason: "found" | "timeout" | "maxStates" | "exhausted" = "exhausted";
  while (queue.size() > 0) {
    const current = queue.pop();
    if (!current) break;
    expandedStates += 1;
    maxQueueSize = Math.max(maxQueueSize, queue.size());
    maxDistSize = Math.max(maxDistSize, dist.size);
    if (Number.isFinite(current.hops)) {
      maxHops = Math.max(maxHops, current.hops);
    }
    if (TRIP_PLANNER_DEBUG && expandedStates % 5000 === 0) {
      const heap = process.memoryUsage();
      logger.info("Trip planner debug: search progress", {
        expandedStates,
        distSize: dist.size,
        maxQueueSize,
        maxHops,
        heapUsedMb: Math.round(heap.heapUsed / 1024 / 1024),
      });
    }
    if (Date.now() - searchStart > maxSearchMs) {
      stopReason = "timeout";
      break;
    }
    if (dist.size > maxStates) {
      stopReason = "maxStates";
      break;
    }
    if (current.node === goal) {
      stopReason = "found";
      const path: Array<{ from: string; to: string; edge: GraphEdge }> = [];
      let key = current.key;
      while (prev.has(key)) {
        const edge = prevEdge.get(key);
        const fromKey = prev.get(key);
        if (!edge || !fromKey) break;
        const [fromNode] = fromKey.split("|");
        const [toNode] = key.split("|");
        if (!fromNode || !toNode) break;
        path.push({ from: fromNode, to: toNode, edge });
        if (path.length > MAX_PATH_HOPS) {
          if (TRIP_PLANNER_DEBUG) {
            logger.info("Trip planner debug: path too long", {
              stopReason: "path_too_long",
              pathHops: path.length,
              expandedStates,
              maxQueueSize,
              maxDistSize,
            });
          }
          return { path: [], cost: Number.POSITIVE_INFINITY };
        }
        key = fromKey;
      }
      if (TRIP_PLANNER_DEBUG) {
        logger.info("Trip planner debug: search", {
          stopReason,
          expandedStates,
          maxQueueSize,
          maxDistSize,
          maxHops,
          durationMs: Date.now() - searchStart,
        });
      }
      return { path: path.reverse(), cost: current.cost };
    }

    const outgoing = edges.get(current.node) ?? [];
    for (const edge of outgoing) {
      const isTransfer = Boolean(current.routeId && current.routeId !== edge.routeId);
      const shouldPenalizeTransfer = isTransfer && !edge.noTransferPenalty;
      const nextHops = current.hops + (edge.isVirtual ? 0 : 1);
      if (nextHops > MAX_SEARCH_HOPS) {
        continue;
      }
      const transfers = current.transfers + (shouldPenalizeTransfer ? 1 : 0);
      if (options.maxTransfers !== undefined && transfers > options.maxTransfers) {
        continue;
      }
      const transferWaitPenalty = shouldPenalizeTransfer ? DEFAULT_WAIT_MINUTES[edge.mode] : 0;
      const transferPenalty = shouldPenalizeTransfer
        ? TRANSFER_SAME_STATION_PENALTY_MINUTES + transferWaitPenalty + getCoordPenalty(current.node)
        : 0;
      const longDistancePenalty =
        !edge.noLongDistancePenalty &&
        options.longDistanceKm &&
        options.longDistanceKm >= LONG_DISTANCE_KM &&
        edge.mode !== "commuter_rail"
          ? NON_CR_LONG_DISTANCE_PENALTY
          : 0;
      const hopPenalty = edge.isVirtual ? 0 : HOP_PENALTY_MINUTES;
      const nextCost = current.cost + edge.weightMinutes + transferPenalty + longDistancePenalty + hopPenalty;
      const nextKey = `${edge.to}|${edge.routeId ?? "none"}`;
      const existing = dist.get(nextKey);
      const existingTransfers = transfersByKey.get(nextKey);
      if (existing !== undefined) {
        if (nextCost > existing) continue;
        if (nextCost === existing && existingTransfers !== undefined && existingTransfers <= transfers) continue;
      }
      dist.set(nextKey, nextCost);
      transfersByKey.set(nextKey, transfers);
      prev.set(nextKey, current.key);
      prevEdge.set(nextKey, edge);
      queue.push({ key: nextKey, cost: nextCost, node: edge.to, routeId: edge.routeId, transfers, hops: nextHops });
    }
  }

  if (TRIP_PLANNER_DEBUG) {
    logger.info("Trip planner debug: search", {
      stopReason,
      expandedStates,
      maxQueueSize,
      maxDistSize,
      maxHops,
      durationMs: Date.now() - searchStart,
    });
  }
  return { path: [], cost: Number.POSITIVE_INFINITY };
};

class MinHeap<T> {
  private data: T[] = [];
  private compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  size() {
    return this.data.length;
  }

  push(item: T) {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length && last) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.data[index]!;
      const parentValue = this.data[parent]!;
      if (this.compare(current, parentValue) >= 0) break;
      [this.data[index], this.data[parent]] = [parentValue, current];
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    const length = this.data.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && this.compare(this.data[left]!, this.data[smallest]!) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.data[right]!, this.data[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.data[index], this.data[smallest]] = [this.data[smallest]!, this.data[index]!];
      index = smallest;
    }
  }
}

export const buildTripPlan = async (
  client: MbtaClient,
  cache: MbtaCache,
  params: TripPlannerRequest,
): Promise<TripPlannerResponse | null> => {
  const timing = createTimings();
  const allowRealtime = ENABLE_REALTIME_PREDICTIONS && process.env.TRIP_PLANNER_REALTIME !== "false";
  let predictionMs = 0;
  let scheduleMs = 0;
  let tripScheduleMs = 0;
  const tripDistanceKm =
    haversineMeters(params.originLat, params.originLon, params.destLat, params.destLon) / 1000;
  const limits = buildTripPlannerLimits(tripDistanceKm);
  const defaultMaxTransfers = params.maxTransfers ?? (tripDistanceKm >= LONG_DISTANCE_KM ? 6 : 8);
  if (tripDistanceKm <= WALK_ONLY_DISTANCE_KM) {
    return buildWalkOnlyPlan(params);
  }
  if (params.modes?.length === 1 && params.modes[0] === "bus" && tripDistanceKm >= BUS_LONG_DISTANCE_KM) {
    logger.warn("Bus-only trip exceeds long-distance limit", { tripDistanceKm });
    return null;
  }
  const dbStops = withTimeout(getStopsCachedLight(), DB_TIMEOUT_MS)
    .then((value) => {
      if (value == null) {
        throw new Error("dbStops_timeout");
      }
      return value;
    })
    .catch((error) => {
      logger.warn("DB stops unavailable for trip planner", { message: String(error) });
      return [] as DbStop[];
    });

  const dbRoutes = withTimeout(getRoutesCachedLight(), DB_TIMEOUT_MS)
    .then((value) => {
      if (value == null) {
        throw new Error("dbRoutes_timeout");
      }
      return value;
    })
    .catch((error) => {
      logger.warn("DB routes unavailable for trip planner", { message: String(error) });
      return [] as DbRoute[];
    });

  const dbStopRoutes = withTimeout(getStopRoutesCachedLight(), DB_TIMEOUT_MS)
    .then((value) => {
      if (value == null) {
        throw new Error("dbStopRoutes_timeout");
      }
      return value;
    })
    .catch((error) => {
      logger.warn("DB stop routes unavailable for trip planner", { message: String(error) });
      return new Map<string, Set<string>>();
    });

  const dbStopsResolved = await dbStops;
  const dbRoutesResolved = await dbRoutes;
  const dbStopRoutesResolved = await dbStopRoutes;

  const routesEntry = cache.getRoutes();
  const routes = dbRoutesResolved.length > 0
    ? dbRoutesResolved.map(buildDbRoute)
    : routesEntry?.data ?? ensureArray((await client.getRoutes()).data);
  const routeLookup = new Map<string, MbtaRoute>(routes.map((route) => [route.id, route]));
  const routeModeMap = new Map<string, TripPlannerMode>(
    routes.map((route) => [route.id, routeMode(route)]),
  );

  const defaultModes = parseDefaultModes(process.env.TRIP_PLANNER_DEFAULT_MODES);
  const requestedModes = params.modes?.length
    ? params.modes
    : defaultModes ?? (Object.keys(MODE_ROUTE_TYPES) as TripPlannerMode[]);
  const explicitModes = params.modes?.length ? params.modes : null;
  const dropLongBus =
    tripDistanceKm >= BUS_LONG_DISTANCE_KM &&
    explicitModes?.includes("bus") &&
    explicitModes.length > 1;
  const effectiveModes = dropLongBus
    ? requestedModes.filter((mode) => mode !== "bus")
    : requestedModes;
  const requestedRouteIds = ensureArray(routes)
    .filter((route) => effectiveModes.some((mode) => MODE_ROUTE_TYPES[mode].includes(route.attributes.type)))
    .map((route) => route.id);

  const modeScores = new Map<TripPlannerMode, Map<string, number>>();
  if (dbStopRoutesResolved.size) {
    effectiveModes.forEach((mode) => {
      const radius = mode === "bus" || mode === "other" ? limits.busRouteRadiusMeters : limits.routeRadiusMeters;
      const limit = mode === "bus" || mode === "other" ? limits.busRouteCandidateLimit : limits.routeCandidateLimit;
      const originScores = collectNearbyRouteScores(
        dbStopsResolved,
        dbStopRoutesResolved,
        routeModeMap,
        [mode],
        params.originLat,
        params.originLon,
        radius,
        limit,
      );
      const destinationScores = collectNearbyRouteScores(
        dbStopsResolved,
        dbStopRoutesResolved,
        routeModeMap,
        [mode],
        params.destLat,
        params.destLon,
        radius,
        limit,
      );
      let merged = new Map<string, number>();
      originScores.forEach((score, routeId) => merged.set(routeId, score));
      destinationScores.forEach((score, routeId) => {
        const existing = merged.get(routeId);
        if (existing == null || score < existing) merged.set(routeId, score);
      });
      if (limits.isLongTrip && (mode === "bus" || mode === "other")) {
        const intersection = new Map<string, number>();
        originScores.forEach((score, routeId) => {
          const destScore = destinationScores.get(routeId);
          if (destScore != null) {
            intersection.set(routeId, Math.min(score, destScore));
          }
        });
        if (intersection.size >= Math.min(6, limit)) {
          merged = intersection;
        }
      }
      modeScores.set(mode, merged);
    });
  }

  const routeIdsForEdges = (() => {
    const byMode = new Map<TripPlannerMode, string[]>();
    requestedRouteIds.forEach((routeId) => {
      const mode = routeModeMap.get(routeId);
      if (!mode) return;
      const list = byMode.get(mode) ?? [];
      list.push(routeId);
      byMode.set(mode, list);
    });
    const allowed = new Set<string>();
    effectiveModes.forEach((mode) => {
      const allForMode = byMode.get(mode) ?? [];
      const scoreMap = modeScores.get(mode);
      const scored = allForMode
        .map((routeId) => ({ routeId, score: scoreMap?.get(routeId) }))
        .filter((entry) => entry.score != null)
        .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
        .map((entry) => entry.routeId);
      const fallback = allForMode;
      const limit = mode === "bus" || mode === "other" ? limits.maxBusRoutes : limits.maxRailRoutes;
      const selected = scored.length > 0 ? scored.slice(0, limit) : fallback.slice(0, limit);
      selected.forEach((routeId) => allowed.add(routeId));
    });
    const ordered = Array.from(allowed)
      .map((routeId) => ({
        routeId,
        score:
          modeScores.get(routeModeMap.get(routeId) ?? "subway")?.get(routeId) ??
          Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.routeId);
    return ordered.slice(0, limits.maxTotalRoutes);
  })();

  if (TRIP_PLANNER_DEBUG) {
    const heap = process.memoryUsage();
    logger.info("Trip planner debug: route selection", {
      requestedModes: effectiveModes,
      requestedRouteCount: requestedRouteIds.length,
      selectedRouteCount: routeIdsForEdges.length,
      busRouteCount: routeIdsForEdges.filter((id) => routeModeMap.get(id) === "bus").length,
      railRouteCount: routeIdsForEdges.filter((id) => {
        const mode = routeModeMap.get(id);
        return mode === "subway" || mode === "commuter_rail";
      }).length,
      heapUsedMb: Math.round(heap.heapUsed / 1024 / 1024),
    });
  }

  const dbEdgesResolved = await withTimeout(getGraphEdgesByRoutesCached(routeIdsForEdges), DB_TIMEOUT_MS)
    .then((value) => {
      if (value == null) {
        throw new Error("dbGraphEdges_timeout");
      }
      return value;
    })
    .catch((error) => {
      logger.warn("DB graph edges unavailable for trip planner", { message: String(error) });
      return [] as { fromStopId: string; toStopId: string; routeId: string; directionId: number; weightMinutes: number | null }[];
    });

  const useDb = dbStopsResolved.length > 0 && dbRoutesResolved.length > 0 && dbEdgesResolved.length > 0;
  timing.mark("dbLoad");

  const routeIds = useDb ? routeIdsForEdges : requestedRouteIds;

  const dbStopsAsMbta = useDb ? dbStopsResolved.map(buildDbStop) : [];
  const dbGraphBundle = useDb
    ? getDbGraphBundle(routeIds, dbEdgesResolved, dbStopsResolved, dbRoutesResolved)
    : null;
  const edgeStopIds = dbGraphBundle?.edgeStopIds ?? new Set<string>();
  const stopToStationId = dbGraphBundle?.stopToStationId ?? new Map<string, string>();
  const stopRouteMap = useDb ? dbGraphBundle?.stopRouteMap ?? new Map<string, Set<string>>() : new Map<string, Set<string>>();
  const origin: NearestStop | null = useDb
    ? null
    : await nearestStation(client, params.originLat, params.originLon);
  const destination: NearestStop | null = useDb
    ? null
    : await nearestStation(client, params.destLat, params.destLon);
  if (!useDb && (!origin || !destination)) return null;
  const originValue = origin ?? undefined;
  const destinationValue = destination ?? undefined;
  let originId = useDb
    ? ""
    : originValue && isMbtaNearestStop(originValue)
      ? originValue.stationId
      : originValue?.stopId ?? "";
  let destinationId = useDb
    ? ""
    : destinationValue && isMbtaNearestStop(destinationValue)
      ? destinationValue.stationId
      : destinationValue?.stopId ?? "";

  const stationStopMap = new Map<string, string>();
  const edges = useDb
    ? (() => {
        dbGraphBundle?.stationStopMap.forEach((stopId, stationId) =>
          stationStopMap.set(stationId, stopId),
        );
        return dbGraphBundle?.graph ?? new Map<string, GraphEdge[]>();
      })()
    : await buildGraph(client, routeIds, stationStopMap, routeModeMap);
  timing.mark("graphBuild");
  if (TRIP_PLANNER_DEBUG) {
    const heap = process.memoryUsage();
    let edgeCount = 0;
    edges.forEach((list) => (edgeCount += list.length));
    logger.info("Trip planner debug: graph", {
      nodeCount: edges.size,
      edgeCount,
      heapUsedMb: Math.round(heap.heapUsed / 1024 / 1024),
    });
  }
  const stationCoordLookup = useDb
    ? dbGraphBundle?.stationCoordLookup
    : undefined;
  let pathEdges: Array<{ from: string; to: string; edge: GraphEdge }> = [];
  let selectedOriginStopId = originValue?.stopId ?? null;
  let selectedDestinationStopId = destinationValue?.stopId ?? null;
  const warnings: Array<{ code: string; message: string }> = [];
  if (useDb) {
    const originCandidates = collectCandidateStops(
      dbStopsAsMbta,
      params.originLat,
      params.originLon,
      edgeStopIds,
      stopToStationId,
      stopRouteMap,
      routeModeMap,
      requestedModes,
      params.maxWalkMinutes,
      limits.candidateLimits,
    );
    const destinationCandidates = collectCandidateStops(
      dbStopsAsMbta,
      params.destLat,
      params.destLon,
      edgeStopIds,
      stopToStationId,
      stopRouteMap,
      routeModeMap,
      requestedModes,
      params.maxWalkMinutes,
      limits.candidateLimits,
    );
    const busRouteSet = new Set<string>(
      Array.from(routeModeMap.entries())
        .filter(([, mode]) => mode === "bus")
        .map(([routeId]) => routeId),
    );
    const buildCandidateByStation = (candidates: DbCandidateStop[]) => {
      const map = new Map<string, DbCandidateStop>();
      candidates.forEach((candidate) => {
        const existing = map.get(candidate.stationId);
        if (!existing || candidate.walkMinutes < existing.walkMinutes) {
          map.set(candidate.stationId, candidate);
        }
      });
      return map;
    };
    const buildVirtualEdges = (
      originMap: Map<string, DbCandidateStop>,
      destinationMap: Map<string, DbCandidateStop>,
    ) => {
      const virtualEdges = new Map<string, GraphEdge[]>(edges);
      const originEdges: GraphEdge[] = Array.from(originMap.values()).map((candidate) => ({
        to: candidate.stationId,
        routeId: VIRTUAL_ROUTE_ID,
        directionId: 0,
        weightMinutes: candidate.walkMinutes,
        mode: "other",
        isVirtual: true,
        noTransferPenalty: true,
        noLongDistancePenalty: true,
      }));
      virtualEdges.set(VIRTUAL_ORIGIN_NODE, originEdges);
      destinationMap.forEach((candidate, stationId) => {
        const existing = virtualEdges.get(stationId) ?? [];
        const virtualEdge: GraphEdge = {
          to: VIRTUAL_DEST_NODE,
          routeId: VIRTUAL_ROUTE_ID,
          directionId: 0,
          weightMinutes: candidate.walkMinutes,
          mode: "other",
          isVirtual: true,
          noTransferPenalty: true,
          noLongDistancePenalty: true,
        };
        virtualEdges.set(stationId, [...existing, virtualEdge]);
      });
      if (!virtualEdges.has(VIRTUAL_DEST_NODE)) {
        virtualEdges.set(VIRTUAL_DEST_NODE, []);
      }
      return virtualEdges;
    };
    const extractVirtualPath = (path: Array<{ from: string; to: string; edge: GraphEdge }>) => {
      if (path.length === 0) return null;
      const originHop = path.find(
        (hop) => hop.from === VIRTUAL_ORIGIN_NODE && hop.edge.isVirtual,
      );
      const destinationHop = [...path]
        .reverse()
        .find((hop) => hop.to === VIRTUAL_DEST_NODE && hop.edge.isVirtual);
      if (!originHop || !destinationHop) return null;
      const filtered = path.filter((hop) => !hop.edge.isVirtual);
      return {
        originStationId: originHop.to,
        destinationStationId: destinationHop.from,
        filteredPath: filtered,
      };
    };
    const baseOptions = stationCoordLookup
      ? {
          stationCoordLookup,
          destination: { lat: params.destLat, lon: params.destLon },
          longDistanceKm: tripDistanceKm,
        }
      : { destination: { lat: params.destLat, lon: params.destLon }, longDistanceKm: tripDistanceKm };
    const runVirtualSearch = (originList: DbCandidateStop[], destinationList: DbCandidateStop[]) => {
      const originMap = buildCandidateByStation(originList);
      const destinationMap = buildCandidateByStation(destinationList);
      if (originMap.size === 0 || destinationMap.size === 0) {
        return {
          path: [] as Array<{ from: string; to: string; edge: GraphEdge }>,
          cost: Number.POSITIVE_INFINITY,
          relaxed: false,
          originCandidate: undefined as DbCandidateStop | undefined,
          destinationCandidate: undefined as DbCandidateStop | undefined,
        };
      }
      const virtualEdges = buildVirtualEdges(originMap, destinationMap);
      let result = findWeightedPath(virtualEdges, VIRTUAL_ORIGIN_NODE, VIRTUAL_DEST_NODE, {
        ...baseOptions,
        maxTransfers: defaultMaxTransfers,
      });
      let relaxed = false;
      if (result.path.length === 0 && defaultMaxTransfers !== undefined) {
        result = findWeightedPath(virtualEdges, VIRTUAL_ORIGIN_NODE, VIRTUAL_DEST_NODE, baseOptions);
        relaxed = result.path.length > 0;
      }
      const extracted = extractVirtualPath(result.path);
      if (!extracted) {
        return {
          path: [] as Array<{ from: string; to: string; edge: GraphEdge }>,
          cost: Number.POSITIVE_INFINITY,
          relaxed: false,
          originCandidate: undefined as DbCandidateStop | undefined,
          destinationCandidate: undefined as DbCandidateStop | undefined,
        };
      }
      return {
        path: extracted.filteredPath,
        cost: result.cost,
        relaxed,
        originCandidate: originMap.get(extracted.originStationId),
        destinationCandidate: destinationMap.get(extracted.destinationStationId),
      };
    };
    let bestCost = Number.POSITIVE_INFINITY;
    let bestPath: Array<{ from: string; to: string; edge: GraphEdge }> = [];
    let bestOriginCandidate: DbCandidateStop | undefined;
    let bestDestinationCandidate: DbCandidateStop | undefined;
    let usedRelaxedTransferCap = false;
    if (TRIP_PLANNER_DEBUG) {
      logger.info("Trip planner debug: candidates", {
        originCandidates: originCandidates.length,
        destinationCandidates: destinationCandidates.length,
      });
    }
    const baseline = runVirtualSearch(originCandidates, destinationCandidates);
    if (baseline.path.length > 0) {
      bestCost = baseline.cost;
      bestPath = baseline.path;
      bestOriginCandidate = baseline.originCandidate;
      bestDestinationCandidate = baseline.destinationCandidate;
      usedRelaxedTransferCap = baseline.relaxed;
    }
    if (tripDistanceKm <= BUS_DIRECT_DISTANCE_KM && originCandidates.length && destinationCandidates.length) {
      const sharedOriginStations = new Set<string>();
      const sharedDestinationStations = new Set<string>();
      originCandidates.forEach((originCandidate) => {
        const originBusRoutes = Array.from(originCandidate.routeIds).filter((routeId) => busRouteSet.has(routeId));
        if (!originBusRoutes.length) return;
        destinationCandidates.forEach((destinationCandidate) => {
          const sharesBus = originBusRoutes.some((routeId) => destinationCandidate.routeIds.has(routeId));
          if (sharesBus) {
            sharedOriginStations.add(originCandidate.stationId);
            sharedDestinationStations.add(destinationCandidate.stationId);
          }
        });
      });
      const sharedOriginCandidates = originCandidates.filter((candidate) =>
        sharedOriginStations.has(candidate.stationId),
      );
      const sharedDestinationCandidates = destinationCandidates.filter((candidate) =>
        sharedDestinationStations.has(candidate.stationId),
      );
      if (sharedOriginCandidates.length && sharedDestinationCandidates.length) {
        const busResult = runVirtualSearch(sharedOriginCandidates, sharedDestinationCandidates);
        if (busResult.path.length > 0) {
          const busCost = busResult.cost - BUS_DIRECT_BONUS_MINUTES;
          if (busCost < bestCost) {
            bestCost = busCost;
            bestPath = busResult.path;
            bestOriginCandidate = busResult.originCandidate;
            bestDestinationCandidate = busResult.destinationCandidate;
            usedRelaxedTransferCap = busResult.relaxed;
          }
        }
      }
    }
    if (usedRelaxedTransferCap) {
      warnings.push({
        code: "transfer_cap_relaxed",
        message: "No route found within the transfer cap; showing the closest available option.",
      });
    }
    if (TRIP_PLANNER_DEBUG && bestPath.length === 0) {
      logger.info("Trip planner debug: connectivity", buildConnectivityDebug(edges, originCandidates, destinationCandidates));
    }
    if (bestPath.length > 0 && bestOriginCandidate && bestDestinationCandidate) {
      originId = bestOriginCandidate.stationId;
      destinationId = bestDestinationCandidate.stationId;
      selectedOriginStopId = bestOriginCandidate.stopId;
      selectedDestinationStopId = bestDestinationCandidate.stopId;
    }
    pathEdges = bestPath;
  } else {
    pathEdges = bfsPath(edges, originId, destinationId);
  }
  timing.mark("pathSearch");
  if (TRIP_PLANNER_DEBUG) {
    logger.info("Trip planner debug: timings", { marks: timing.marks, totalMs: timing.totalMs() });
  }
  if (!pathEdges.length) return null;

  const segments: Array<{ routeId: string; directionId: number; stations: string[] }> = [];
  let current: { routeId: string; directionId: number; stations: string[] } | null = null;
  for (const hop of pathEdges) {
    if (current && current.routeId === hop.edge.routeId && current.directionId === hop.edge.directionId) {
      current.stations.push(hop.to);
    } else {
      if (current) segments.push(current);
      current = { routeId: hop.edge.routeId, directionId: hop.edge.directionId, stations: [hop.from, hop.to] };
    }
  }
  if (current) segments.push(current);

  const stopLookup = useDb
    ? new Map<string, MbtaStop>(dbStopsAsMbta.map((stop) => [stop.id, stop]))
    : await getStopLookup(client, cache);

  const legs: TripPlannerLeg[] = [];

  const boardStopId = selectedOriginStopId ?? stationStopMap.get(originId) ?? originId;
  const boardStop = stopLookup.get(boardStopId);
  if (boardStop) {
    const dist = haversineMeters(params.originLat, params.originLon, boardStop.attributes.latitude, boardStop.attributes.longitude);
    const minutes = walkMinutes(dist);
    legs.push({
      mode: "walk",
      from: { label: "Origin", lat: params.originLat, lon: params.originLon },
      to: { stopId: originId, name: boardStop.attributes.name, lat: boardStop.attributes.latitude, lon: boardStop.attributes.longitude },
      distanceMeters: Math.round(dist),
      durationMinutes: Math.round(minutes * 10) / 10,
      style: "walk",
    });
  }

  let totalWait = 0;
  let totalRide = 0;
  let totalWalk = legs.reduce((sum, leg) => sum + (leg.durationMinutes ?? 0), 0);
  let totalTransferPenalty = 0;
  let confidence: "realtime" | "schedule" | "fallback" = "fallback";

  let previousRouteId: string | null = null;
  for (const segment of segments) {
    const boardStationId = segment.stations[0];
    const alightStationId = segment.stations[segment.stations.length - 1];
    if (!boardStationId || !alightStationId) {
      continue;
    }
    const boardId = stationStopMap.get(boardStationId) ?? boardStationId;
    const alightId = stationStopMap.get(alightStationId) ?? alightStationId;
    if (segment.routeId === TRANSFER_ROUTE_ID) {
      const boardStop = stopLookup.get(boardId);
      const alightStop = stopLookup.get(alightId);
      if (boardStop && alightStop) {
        const dist = haversineMeters(
          boardStop.attributes.latitude,
          boardStop.attributes.longitude,
          alightStop.attributes.latitude,
          alightStop.attributes.longitude,
        );
        const minutes = walkMinutes(dist);
        totalWalk += minutes;
        legs.push({
          mode: "walk",
          routeId: TRANSFER_ROUTE_ID,
          from: buildStopRef(
            boardStationId,
            boardStop.attributes.name,
            boardStop.attributes.latitude,
            boardStop.attributes.longitude,
          ),
          to: buildStopRef(
            alightStationId,
            alightStop.attributes.name,
            alightStop.attributes.latitude,
            alightStop.attributes.longitude,
          ),
          distanceMeters: Math.round(dist),
          durationMinutes: Math.round(minutes * 10) / 10,
          style: "walk",
        });
      }
      continue;
    }
    const transferPenaltyMinutes =
      previousRouteId && previousRouteId !== segment.routeId
        ? TRANSFER_SAME_STATION_PENALTY_MINUTES +
          (() => {
            if (!stationCoordLookup) return 0;
            const coord = stationCoordLookup.get(boardStationId);
            if (!coord) return 0;
            const distKm =
              haversineMeters(coord.lat, coord.lon, params.destLat, params.destLon) / 1000;
            return distKm * TRANSFER_DISTANCE_PENALTY_PER_KM;
          })()
        : 0;
    if (transferPenaltyMinutes > 0) {
      totalTransferPenalty += transferPenaltyMinutes;
    }

    let predictions: { data: MbtaPrediction[] } = { data: [] };
    if (allowRealtime) {
      const predictionStart = Date.now();
      const predictionsResponse = await withTimeout(
        client.getPredictions({
          "filter[stop]": boardId,
          "filter[route]": segment.routeId,
          "filter[direction_id]": segment.directionId,
          sort: "departure_time",
          "page[limit]": 5,
        }),
        MBTA_TIMEOUT_MS,
      );
      const predictionData = ensureArray(predictionsResponse?.data);
      predictions = { data: predictionData };
      if (!predictionsResponse) {
        warnings.push({
          code: "mbta_timeout",
          message: `Prediction request timed out for route ${segment.routeId}.`,
        });
      }
      predictionMs += Date.now() - predictionStart;
    }

    let departureTime: string | null = null;
    let tripId: string | null = null;
    for (const prediction of ensureArray(predictions.data)) {
      const dep = prediction.attributes.departure_time ?? prediction.attributes.arrival_time;
      if (dep) {
        departureTime = dep;
        tripId = (prediction as any).relationships?.trip?.data?.id ?? null;
        break;
      }
    }

    let source: TripPlannerLegSource = "prediction";
    if (!departureTime && allowRealtime) {
      const scheduleStart = Date.now();
      const schedulesResponse = await withTimeout(
        client.getSchedules({
          "filter[stop]": boardId,
          "filter[route]": segment.routeId,
          "filter[direction_id]": segment.directionId,
          sort: "departure_time",
          "page[limit]": 5,
        }),
        MBTA_TIMEOUT_MS,
      );
      const schedules = schedulesResponse ?? { data: [] };
      scheduleMs += Date.now() - scheduleStart;
      if (!schedulesResponse) {
        warnings.push({
          code: "mbta_timeout",
          message: `Schedule request timed out for route ${segment.routeId}.`,
        });
      }
      for (const schedule of ensureArray(schedules.data)) {
        const dep = schedule.attributes.departure_time ?? schedule.attributes.arrival_time;
        if (dep) {
          departureTime = dep;
          source = "schedule";
          break;
        }
      }
    }
    if (!allowRealtime) {
      source = "fallback";
      warnings.push({
        code: "realtime_disabled",
        message: "Realtime predictions disabled; using average headways.",
      });
    }

    let waitMinutes = 0;
    if (departureTime) {
      const departAt = Date.parse(departureTime);
      const now = params.departAt ? Date.parse(params.departAt) : Date.now();
      waitMinutes = Math.max(0, (departAt - now) / 60000);
      if (source === "prediction") confidence = "realtime";
      if (source === "schedule" && confidence !== "realtime") confidence = "schedule";
    } else {
      const route = routes.find((entry) => entry.id === segment.routeId);
      const mode = routeMode(route);
      waitMinutes = DEFAULT_WAIT_MINUTES[mode];
      source = "fallback";
      warnings.push({
        code: "fallback_headway",
        message: `Used fallback headway for route ${segment.routeId}.`,
      });
    }
      const waitMode = routeMode(routeLookup.get(segment.routeId));
    const nowForWait = params.departAt ? Date.parse(params.departAt) : Date.now();
    if (isLateNight(nowForWait) && source !== "prediction") {
      const crOverride =
        segment.routeId && segment.routeId.startsWith("CR-")
          ? CR_LATE_NIGHT_HEADWAY_OVERRIDES[segment.routeId] ?? CR_LATE_NIGHT_HEADWAY_DEFAULT
          : null;
      waitMinutes = crOverride ?? DEFAULT_WAIT_MINUTES[waitMode];
      warnings.push({
        code: "late_night_headway",
        message: `Used average headway for late-night service on route ${segment.routeId}.`,
      });
    }
    if (waitMinutes > MAX_WAIT_MINUTES) {
      waitMinutes = DEFAULT_WAIT_MINUTES[waitMode];
      warnings.push({
        code: "capped_wait",
        message: `Capped wait time for route ${segment.routeId}.`,
      });
    }

    let arrivalTime: string | null = null;
    let rideMinutes = 0;
    if (tripId && allowRealtime) {
      const tripScheduleStart = Date.now();
      const scheduleResponse = await withTimeout(
        client.getSchedules({
          "filter[trip]": tripId,
          "filter[stop]": alightId,
          "page[limit]": 1,
        }),
        MBTA_TIMEOUT_MS,
      );
      const schedule = scheduleResponse ?? { data: [] };
      tripScheduleMs += Date.now() - tripScheduleStart;
      if (!scheduleResponse) {
        warnings.push({
          code: "mbta_timeout",
          message: `Trip schedule request timed out for route ${segment.routeId}.`,
        });
      }
      const arrival = ensureArray(schedule.data)[0]?.attributes.arrival_time;
      if (arrival && departureTime) {
        arrivalTime = arrival;
        rideMinutes = Math.max(1, (Date.parse(arrival) - Date.parse(departureTime)) / 60000);
      }
    }

    if (!rideMinutes) {
      const boardStop = stopLookup.get(boardId);
      const alightStop = stopLookup.get(alightId);
      const mode = routeMode(routeLookup.get(segment.routeId));
      if (boardStop && alightStop) {
        const dist = haversineMeters(
          boardStop.attributes.latitude,
          boardStop.attributes.longitude,
          alightStop.attributes.latitude,
          alightStop.attributes.longitude,
        );
        rideMinutes = walkMinutes(dist, DEFAULT_SPEED_MPH[mode]);
      } else {
        rideMinutes = 10;
      }
      if (source !== "prediction") source = "fallback";
    }

    totalWait += waitMinutes;
    totalRide += rideMinutes;

    const boardStop = stopLookup.get(boardId);
    const alightStop = stopLookup.get(alightId);
    legs.push({
      mode: routeMode(routeLookup.get(segment.routeId)),
      routeId: segment.routeId,
      lineId: segment.routeId,
      directionId: segment.directionId,
      from: buildStopRef(
        boardStationId,
        boardStop?.attributes.name,
        boardStop?.attributes.latitude,
        boardStop?.attributes.longitude,
      ),
      to: buildStopRef(
        alightStationId,
        alightStop?.attributes.name,
        alightStop?.attributes.latitude,
        alightStop?.attributes.longitude,
      ),
      departureTime,
      arrivalTime,
      waitMinutes: Math.round(waitMinutes * 10) / 10,
      rideMinutes: Math.round(rideMinutes * 10) / 10,
      source,
      ...(transferPenaltyMinutes > 0
        ? { transferPenaltyMinutes: Math.round(transferPenaltyMinutes * 10) / 10 }
        : {}),
    });
    previousRouteId = segment.routeId;
  }
  timing.mark("legsBuilt");

  const alightStopId = selectedDestinationStopId ?? stationStopMap.get(destinationId) ?? destinationId;
  const alightStop = stopLookup.get(alightStopId);
  if (alightStop) {
    const dist = haversineMeters(alightStop.attributes.latitude, alightStop.attributes.longitude, params.destLat, params.destLon);
    const minutes = walkMinutes(dist);
    totalWalk += minutes;
    legs.push({
      mode: "walk",
      from: { stopId: destinationId, name: alightStop.attributes.name, lat: alightStop.attributes.latitude, lon: alightStop.attributes.longitude },
      to: { label: "Destination", lat: params.destLat, lon: params.destLon },
      distanceMeters: Math.round(dist),
      durationMinutes: Math.round(minutes * 10) / 10,
      style: "walk",
    });
  }

  const totalMinutes = totalWalk + totalRide + totalWait + totalTransferPenalty;
  const transfers = Math.max(0, legs.filter((leg) => leg.mode !== "walk").length - 1);

  const routeSegments = await Promise.all(
    legs.map((leg) =>
      leg.routeId ? buildRouteSegmentPolyline(leg.routeId, leg.from, leg.to) : Promise.resolve(null),
    ),
  );
  const lineShapeMap = new Map<string, { lineId: string; color: string | null; coords: [number, number][] }>();
  for (let idx = 0; idx < legs.length; idx += 1) {
    const leg = legs[idx];
    const segment = routeSegments[idx];
    if (!leg?.routeId || !segment) continue;
    const route = routeLookup.get(leg.routeId);
    const existing = lineShapeMap.get(leg.routeId);
    if (existing) {
      const last = existing.coords[existing.coords.length - 1];
      const first = segment[0];
      if (last && first && last[0] === first[0] && last[1] === first[1]) {
        existing.coords.push(...segment.slice(1));
      } else {
        existing.coords.push(...segment);
      }
    } else {
      lineShapeMap.set(leg.routeId, {
        lineId: leg.routeId,
        color: route?.attributes.color ?? null,
        coords: [...segment],
      });
    }
  }

  const lineShapes = Array.from(lineShapeMap.values()).map((shape) => ({
    lineId: shape.lineId,
    color: shape.color,
    polyline: shape.coords.length >= 2 ? polyline.encode(shape.coords) : null,
  }));

  const walkPolylineResults = await Promise.all(
    legs.map(async (leg) => {
      if (leg.mode !== "walk") return null;
      const fromLat = leg.from?.lat;
      const fromLon = leg.from?.lon;
      const toLat = leg.to?.lat;
      const toLon = leg.to?.lon;
      if ([fromLat, fromLon, toLat, toLon].some((value) => typeof value !== "number")) return null;
      const segmentCoords =
        (await fetchWalkPolylineCoords(fromLat as number, fromLon as number, toLat as number, toLon as number)) ??
        [
          [fromLat as number, fromLon as number],
          [toLat as number, toLon as number],
        ];
      if (segmentCoords.length < 2) return null;
      return polyline.encode(segmentCoords);
    }),
  );
  const walkPolylines = walkPolylineResults.filter((value): value is string => Boolean(value));

  const walkPolyline = walkPolylines.length === 1 ? (walkPolylines[0] ?? null) : null;

  const response: TripPlannerResponse = {
    generatedAt: new Date().toISOString(),
    request: params,
    summary: {
      totalMinutes: Math.round(totalMinutes * 10) / 10,
      walkMinutes: Math.round(totalWalk * 10) / 10,
      waitMinutes: Math.round(totalWait * 10) / 10,
      rideMinutes: Math.round(totalRide * 10) / 10,
      ...(totalTransferPenalty > 0
        ? { transferPenaltyMinutes: Math.round(totalTransferPenalty * 10) / 10 }
        : {}),
      transfers,
      confidence,
    },
    primary: {
      tripId: `tripplan-${Date.now()}`,
      legs,
      map: {
        bounds: [
          [Math.min(params.originLat, params.destLat), Math.min(params.originLon, params.destLon)],
          [Math.max(params.originLat, params.destLat), Math.max(params.originLon, params.destLon)],
        ],
        walkPolyline,
        walkPolylines,
        lineShapes,
      },
    },
    alternates: [],
    warnings,
  };
  timing.mark("responseBuilt");
  logger.debug("Trip planner timing", {
    useDb,
    totalMs: timing.totalMs(),
    dbLoadMs: timing.marks.dbLoad,
    graphBuildMs: timing.marks.graphBuild,
    pathSearchMs: timing.marks.pathSearch,
    legsBuiltMs: timing.marks.legsBuilt,
    responseMs: timing.marks.responseBuilt,
    predictionMs,
    scheduleMs,
    tripScheduleMs,
    segments: segments.length,
    legs: legs.length,
  });

  return response;
};
