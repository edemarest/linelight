import type {
  MbtaAlert,
  MbtaLine,
  MbtaPrediction,
  MbtaRoute,
  MbtaStop,
  MbtaTrip,
  MbtaVehicle,
} from "../models/mbta";
import type { Coordinate } from "../models/domain";
import type { RedisManager } from "./redisClient";
import { logger } from "../utils/logger";
import type { HomeResponse } from "@linelight/core";

export interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export interface CacheHealth {
  redisStatus: string;
  predictionsAgeMs: number | null;
  predictionsIsStale: boolean;
}

export type RouteShapeMap = Map<string, Coordinate[][]>;

const CACHE_KEYS = {
  routes: "linelight:cache:routes",
  lines: "linelight:cache:lines",
  predictions: "linelight:cache:predictions",
  vehicles: "linelight:cache:vehicles",
  alerts: "linelight:cache:alerts",
  stops: "linelight:cache:stops",
  stopRouteMap: "linelight:cache:stopRouteMap",
  trips: "linelight:cache:trips",
  shapes: "linelight:cache:shapes",
} as const;
const HOME_SNAPSHOT_PREFIX = "linelight:cache:home:";

const TTL_MS = {
  predictions: 60_000,
  vehicles: 60_000,
  alerts: 120_000,
  homeSnapshot: 30_000,
};

const STALE_PREDICTION_THRESHOLD_MS = 90_000;

export class MbtaCache {
  private routes?: CacheEntry<MbtaRoute[]>;
  private lines?: CacheEntry<MbtaLine[]>;
  private predictions?: CacheEntry<MbtaPrediction[]>;
  private vehicles?: CacheEntry<MbtaVehicle[]>;
  private alerts?: CacheEntry<MbtaAlert[]>;
  private stops?: CacheEntry<MbtaStop[]>;
  private stopRouteMap?: CacheEntry<Map<string, Set<string>>>;
  private trips?: CacheEntry<MbtaTrip[]>;
  private shapes?: CacheEntry<RouteShapeMap>;
  private homeSnapshots = new Map<string, CacheEntry<HomeResponse>>();
  private readonly redis: RedisManager | undefined;

  constructor(redis?: RedisManager) {
    this.redis = redis && redis.status !== "disabled" ? redis : undefined;
    void this.hydrateFromRedis();
  }

  private async hydrateFromRedis() {
    if (!this.redis || this.redis.status === "error") return;
    const loaders: Array<[keyof typeof CACHE_KEYS, (value: any) => void]> = [
      ["routes", (entry) => (this.routes = entry)],
      ["lines", (entry) => (this.lines = entry)],
      ["predictions", (entry) => (this.predictions = entry)],
      ["vehicles", (entry) => (this.vehicles = entry)],
      ["alerts", (entry) => (this.alerts = entry)],
      ["stops", (entry) => (this.stops = entry)],
      ["stopRouteMap", (entry) => (this.stopRouteMap = entry)],
      ["trips", (entry) => (this.trips = entry)],
      ["shapes", (entry) => (this.shapes = entry)],
    ];

    await Promise.all(
      loaders.map(async ([key, setter]) => {
        const redisKey = CACHE_KEYS[key];
        const entry = await this.redis!.getJson<CacheEntry<any>>(redisKey);
        if (!entry) return;
        try {
          if (key === "stopRouteMap" && entry.data && Array.isArray(entry.data)) {
            entry.data = new Map(
              (entry.data as Array<[string, string[]]>).map(([stopId, routes]) => [
                stopId,
                new Set(routes),
              ]),
            );
          }
          if (key === "shapes" && entry.data && Array.isArray(entry.data)) {
            entry.data = new Map(entry.data as Array<[string, Coordinate[][]]>);
          }
          setter(entry);
          logger.info("Hydrated cache entry from Redis", { entry: key });
        } catch (error) {
          logger.warn("Failed to hydrate cache entry", { entry: key, message: String(error) });
        }
      }),
    );
  }

  private persist<T>(key: keyof typeof CACHE_KEYS, entry: CacheEntry<T>, ttlMs?: number) {
    if (!this.redis || this.redis.status !== "ready") return;
    let payload: CacheEntry<any> = entry;
    if (key === "stopRouteMap") {
      payload = {
        ...entry,
        data: Array.from((entry.data as Map<string, Set<string>>).entries()).map(([stopId, routes]) => [
          stopId,
          Array.from(routes),
        ]),
      };
    }
    if (key === "shapes") {
      payload = {
        ...entry,
        data: Array.from((entry.data as RouteShapeMap).entries()),
      };
    }
    void this.redis.setJson(CACHE_KEYS[key], payload, ttlMs);
  }

  private isEntryFresh(entry: CacheEntry<unknown>, ttlMs: number) {
    return Date.now() - entry.fetchedAt <= ttlMs;
  }

  public setRoutes(data: MbtaRoute[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.routes = entry;
    this.persist("routes", entry);
  }

  public getRoutes() {
    return this.routes;
  }

  public setLines(data: MbtaLine[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.lines = entry;
    this.persist("lines", entry);
  }

  public getLines() {
    return this.lines;
  }

  public setPredictions(data: MbtaPrediction[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.predictions = entry;
    this.persist("predictions", entry, TTL_MS.predictions);
  }

  public getPredictions() {
    return this.predictions;
  }

  public setVehicles(data: MbtaVehicle[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.vehicles = entry;
    this.persist("vehicles", entry, TTL_MS.vehicles);
  }

  public getVehicles() {
    return this.vehicles;
  }

  public setAlerts(data: MbtaAlert[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.alerts = entry;
    this.persist("alerts", entry, TTL_MS.alerts);
  }

  public getAlerts() {
    return this.alerts;
  }

  public setStops(data: MbtaStop[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.stops = entry;
    this.persist("stops", entry);
  }

  public getStops() {
    return this.stops;
  }

  public setStopRouteMap(data: Map<string, Set<string>>) {
    const entry = { data, fetchedAt: Date.now() };
    this.stopRouteMap = entry;
    this.persist("stopRouteMap", entry);
  }

  public getStopRouteMap() {
    return this.stopRouteMap;
  }

  public setTrips(data: MbtaTrip[]) {
    const entry = { data, fetchedAt: Date.now() };
    this.trips = entry;
    this.persist("trips", entry);
  }

  public getTrips() {
    return this.trips;
  }

  public setShapes(routeShapes: RouteShapeMap) {
    const entry = { data: routeShapes, fetchedAt: Date.now() };
    this.shapes = entry;
    this.persist("shapes", entry);
  }

  public getShapes() {
    return this.shapes;
  }

  public getHealth(): CacheHealth {
    const predictionsFetchedAt = this.predictions?.fetchedAt ?? null;
    const age = predictionsFetchedAt ? Date.now() - predictionsFetchedAt : null;
    return {
      redisStatus: this.redis?.status ?? "disabled",
      predictionsAgeMs: age,
      predictionsIsStale: age != null ? age > STALE_PREDICTION_THRESHOLD_MS : true,
    };
  }
}

export const createMbtaCache = (redis?: RedisManager) => new MbtaCache(redis);
