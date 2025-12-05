import { createMbtaClient } from "../mbta/client";
import type { MbtaClient } from "../mbta/client";
import type { MbtaCache } from "../cache/mbtaCache";
import { createMbtaCache, type RouteShapeMap } from "../cache/mbtaCache";
import { createRedisManager, type RedisManager } from "../cache/redisClient";
import { extractFirstRelationshipId } from "../utils/jsonApi";
import type { Coordinate } from "../models/domain";
import polyline from "@mapbox/polyline";
import type { MbtaPrediction, MbtaStop, MbtaTrip, MbtaVehicle } from "../models/mbta";
import { resolveBoardableParent } from "../utils/stationKind";
import { logger } from "../utils/logger";
import { buildHomeSnapshot } from "../services/homeSnapshot";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGET_ROUTE_TYPES = [0, 1, 2, 3]; // light rail, heavy rail, commuter rail, bus (inc. Silver Line)
const ROUTE_TYPE_FILTER = TARGET_ROUTE_TYPES.join(",");
const FALLBACK_ROUTE_IDS = [
  "Red",
  "Orange",
  "Blue",
  "Green-B",
  "Green-C",
  "Green-D",
  "Green-E",
  "Mattapan",
  "741", // SL1
  "742", // SL2
  "743", // SL3
  "CR-Fitchburg",
  "CR-Franklin",
];
const HOME_SNAPSHOT_HOTSPOTS: Array<{
  name: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  limit: number;
  favoriteStopIds?: string[];
}> = [
  {
    name: "downtown-crossing",
    lat: 42.3555,
    lng: -71.0605,
    radiusMeters: 1200,
    limit: 10,
  },
  {
    name: "logan-airport",
    lat: 42.3656,
    lng: -71.0096,
    radiusMeters: 1500,
    limit: 8,
  },
  {
    name: "harvard-square",
    lat: 42.3734,
    lng: -71.1189,
    radiusMeters: 1200,
    limit: 10,
  },
];

interface PollingJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  initialDelayMs?: number;
  timer?: NodeJS.Timeout;
}

const ensureArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const chunkArray = <T>(values: T[], size: number): T[][] => {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
};

const fetchStopsByIds = async (client: MbtaClient, ids: string[]): Promise<MbtaStop[]> => {
  if (ids.length === 0) return [];
  const parents: MbtaStop[] = [];
  const batches = chunkArray(ids, 80);
  for (const batch of batches) {
    const response = await client.getStops({
      "filter[id]": batch.join(","),
      "page[limit]": Math.max(50, batch.length),
      include: "parent_station",
    });
    parents.push(...ensureArray(response.data));
    ensureArray(response.included)
      .filter((resource) => resource.type === "stop")
      .forEach((resource) => parents.push(resource as unknown as MbtaStop));
  }
  return parents;
};

const decodePolyline = (encoded: string | null | undefined): Coordinate[] => {
  if (!encoded) return [];
  return (polyline.decode(encoded) as [number, number][]).map(([lat, lng]) => ({ lat, lng }));
};

let selectedRouteIds: string[] = FALLBACK_ROUTE_IDS;
const getTargetRouteIds = () => (selectedRouteIds.length > 0 ? selectedRouteIds : FALLBACK_ROUTE_IDS);

const createJobs = (client: MbtaClient, cache: MbtaCache): PollingJob[] => [
  {
    name: "routes",
    intervalMs: 1000 * 60 * 60,
    initialDelayMs: 0,
    run: async () => {
      const response = await client.getRoutes();
      const routes = ensureArray(response.data);
      cache.setRoutes(routes);
      selectedRouteIds = routes
        .filter((route) => TARGET_ROUTE_TYPES.includes(route.attributes.type))
        .map((route) => route.id);
    },
  },
  {
    name: "lines",
    intervalMs: 1000 * 60 * 60,
    initialDelayMs: 2000,
    run: async () => {
      const response = await client.getLines({ include: "routes" });
      cache.setLines(ensureArray(response.data));
    },
  },
  {
    name: "stops",
    intervalMs: 1000 * 60 * 60 * 6,
    initialDelayMs: 4000,
    run: async () => {
      const response = await client.getStops({
        "filter[route_type]": ROUTE_TYPE_FILTER,
        "page[limit]": 5000,
        include: "parent_station",
      });
      const directStops = ensureArray(response.data);
      const includedStops = ensureArray(response.included)
        .filter((resource) => resource.type === "stop")
        .map((resource) => resource as unknown as MbtaStop);
      const merged = new Map<string, MbtaStop>();
      [...directStops, ...includedStops].forEach((stop) => {
        merged.set(stop.id, stop);
      });
      const missingParentIds = new Set<string>();
      merged.forEach((stop) => {
        const parentId = extractFirstRelationshipId(stop.relationships?.parent_station);
        if (parentId && !merged.has(parentId)) {
          missingParentIds.add(parentId);
        }
      });
      if (missingParentIds.size > 0) {
        try {
          const parents = await fetchStopsByIds(client, Array.from(missingParentIds));
          parents.forEach((parent) => {
            merged.set(parent.id, parent);
          });
        } catch (error) {
          logger.warn("Failed to load parent stations while polling stops", {
            message: String(error),
          });
        }
      }
      const mergedStops = Array.from(merged.values());
      cache.setStops(mergedStops);
      const stopLookup = new Map<string, MbtaStop>(mergedStops.map((stop) => [stop.id, stop]));

      const stopRouteMap = new Map<string, Set<string>>();
      const routeChunks = chunkArray(getTargetRouteIds(), 5);
      for (const chunk of routeChunks) {
        for (const routeId of chunk) {
          try {
            const res = await client.getStops({
              "filter[route]": routeId,
              "page[limit]": 200,
              include: "parent_station",
            });
            ensureArray(res.data).forEach((stop) => {
              const boardable =
                resolveBoardableParent(stop as MbtaStop, stopLookup) ?? (stop as MbtaStop | undefined);
              const target = boardable ?? (stop as MbtaStop);
              const set = stopRouteMap.get(target.id) ?? new Set<string>();
              set.add(routeId);
              stopRouteMap.set(target.id, set);
            });
          } catch (error) {
            logger.warn("Failed to load stops for a route during polling", {
              routeId,
              message: String(error),
            });
          }
          // small spacing to avoid large request bursts to MBTA
          await sleep(75);
        }
      }
      cache.setStopRouteMap(stopRouteMap);
    },
  },
  {
    name: "vehicles",
    intervalMs: 1000 * 30,
    initialDelayMs: 6000,
    run: async () => {
      const routeChunks = chunkArray(getTargetRouteIds(), 20);
      const vehicles: MbtaVehicle[] = [];
      for (const chunk of routeChunks) {
        const response = await client.getVehicles({
          "filter[route]": chunk.join(","),
        });
        vehicles.push(...ensureArray(response.data));
        await sleep(50);
      }
      cache.setVehicles(vehicles);
    },
  },
  {
    name: "predictions",
    intervalMs: 1000 * 20,
    initialDelayMs: 8000,
    run: async () => {
      const routeChunks = chunkArray(getTargetRouteIds(), 10);
      const predictions: MbtaPrediction[] = [];
      for (const chunk of routeChunks) {
        const response = await client.getPredictions({
          "filter[route]": chunk.join(","),
          include: "route,stop,trip",
          "page[limit]": 500,
        });
        predictions.push(...ensureArray(response.data));
        await sleep(60);
      }
      cache.setPredictions(predictions);
    },
  },
  {
    name: "alerts",
    intervalMs: 1000 * 60,
    initialDelayMs: 10000,
    run: async () => {
      const response = await client.getAlerts();
      cache.setAlerts(ensureArray(response.data));
    },
  },
  {
    name: "trips",
    intervalMs: 1000 * 60 * 5,
    initialDelayMs: 12000,
    run: async () => {
      const routeChunks = chunkArray(getTargetRouteIds(), 10);
      const trips: MbtaTrip[] = [];
      for (const chunk of routeChunks) {
        const response = await client.getTrips({
          "filter[route]": chunk.join(","),
          "page[limit]": 500,
        });
        trips.push(...ensureArray(response.data));
        await sleep(60);
      }
      cache.setTrips(trips);
    },
  },
  {
    name: "shapes",
    intervalMs: 1000 * 60 * 60 * 6,
    initialDelayMs: 14000,
    run: async () => {
      const routeChunks = chunkArray(getTargetRouteIds(), 5);
      const routeShapeMap: RouteShapeMap = new Map();
      for (const chunk of routeChunks) {
        const response = await client.getShapes({
          "filter[route]": chunk.join(","),
          "page[limit]": 2000,
        });
        ensureArray(response.data).forEach((shape) => {
          const routeId = extractFirstRelationshipId(shape.relationships?.route);
          if (!routeId) return;
          const coords = decodePolyline(shape.attributes.polyline);
          if (coords.length < 2) return;
          const existing = routeShapeMap.get(routeId) ?? [];
          existing.push(coords);
          routeShapeMap.set(routeId, existing);
        });
        await sleep(120);
      }
      cache.setShapes(routeShapeMap);
    },
  },
  {
    name: "home-hotspots",
    intervalMs: 1000 * 45,
    initialDelayMs: 20000,
    run: async () => {
      for (const hotspot of HOME_SNAPSHOT_HOTSPOTS) {
        try {
          await buildHomeSnapshot(cache, client, {
            lat: hotspot.lat,
            lng: hotspot.lng,
            radiusMeters: hotspot.radiusMeters,
            limit: hotspot.limit,
            favoriteStopIds: hotspot.favoriteStopIds ?? [],
          });
        } catch (error) {
          logger.warn("Failed to warm home hotspot cache", {
            hotspot: hotspot.name,
            message: String(error),
          });
        }
        await sleep(150);
      }
    },
  },
];

const startJob = (job: PollingJob) => {
  const scheduleNext = (delayMs: number) => {
    job.timer = setTimeout(async () => {
      const start = Date.now();
      try {
        await job.run();
        const duration = Date.now() - start;
        logger.info("Polling job completed", { job: job.name, durationMs: duration });
      } catch (error) {
        logger.error("Polling job failed", { job: job.name, message: String(error) });
      } finally {
        scheduleNext(job.intervalMs);
      }
    }, Math.max(0, delayMs));
  };

  scheduleNext(job.initialDelayMs ?? 0);
};

export interface PollingBundle {
  client: MbtaClient;
  cache: MbtaCache;
  jobs: PollingJob[];
  redis?: RedisManager;
}

export const initializePolling = (): PollingBundle => {
  const client = createMbtaClient();
  const redis = createRedisManager();
  const cache = createMbtaCache(redis);
  const jobs = createJobs(client, cache);

  jobs.forEach(startJob);

  return { client, cache, jobs, redis };
};
