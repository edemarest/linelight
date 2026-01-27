import test from "node:test";
import assert from "node:assert/strict";
import { MbtaCache } from "../cache/mbtaCache";
import type { MbtaRoute, MbtaStop, MbtaPrediction, MbtaSchedule } from "../models/mbta";
import type { MbtaClient } from "../mbta/client";
import { buildStationGraphFromDb, buildTripPlan, findWeightedPath } from "../services/tripPlanner";

delete process.env.DATABASE_URL;
delete process.env.PGSSLROOTCERT;
delete process.env.PGSSL_SERVERNAME;
delete process.env.OSRM_BASE_URL;

const makeStop = (id: string, name: string, lat: number, lon: number): MbtaStop => ({
  id,
  type: "stop",
  attributes: {
    name,
    description: null,
    latitude: lat,
    longitude: lon,
    wheelchair_boarding: 1,
    location_type: 1,
    platform_code: null,
    platform_name: null,
  },
  relationships: {},
});

const makeRoute = (id: string, type: MbtaRoute["attributes"]["type"]): MbtaRoute => ({
  id,
  type: "route",
  attributes: {
    short_name: id,
    long_name: id,
    description: null,
    type,
    color: "DA291C",
    text_color: "FFFFFF",
    sort_order: 1,
  },
  relationships: {},
});

const makePrediction = (departure_time: string): MbtaPrediction => ({
  id: "pred-1",
  type: "prediction",
  attributes: {
    arrival_time: null,
    departure_time,
    status: null,
    direction_id: 0,
    stop_sequence: 1,
  },
  relationships: {
    trip: { data: { id: "trip-1", type: "trip" } },
  },
});

const makeSchedule = (arrival_time: string): MbtaSchedule => ({
  id: "sched-1",
  type: "schedule",
  attributes: {
    arrival_time,
    departure_time: null,
    stop_sequence: 2,
    direction_id: 0,
  },
  relationships: {},
});

const buildClient = ({
  stops,
  routes,
  predictionTime,
  arrivalTime,
  includePrediction,
}: {
  stops: MbtaStop[];
  routes: MbtaRoute[];
  predictionTime: string;
  arrivalTime: string;
  includePrediction: boolean;
}): MbtaClient =>
  ({
    getRoutes: async () => ({ data: routes }),
    getStops: async () => ({ data: stops }),
    getRoutePatterns: async () => ({
      data: [
        {
          id: "pattern-1",
          type: "route_pattern",
          attributes: {
            name: "Test Pattern",
            direction_id: 0,
            canonical: true,
            typicality: 1,
          },
          relationships: {},
        },
      ],
    }),
    getTrips: async () => ({
      data: [
        {
          id: "trip-1",
          type: "trip",
          attributes: { headsign: "Test", direction_id: 0 },
          relationships: {
            stops: {
              data: stops.map((stop) => ({ id: stop.id, type: "stop" })),
            },
          },
        },
      ],
      included: stops,
    }),
    getPredictions: async () => ({
      data: includePrediction ? [makePrediction(predictionTime)] : [],
    }),
    getSchedules: async (params: Record<string, unknown>) => {
      if (typeof params["filter[trip]"] === "string") {
        return { data: [makeSchedule(arrivalTime)] };
      }
      return { data: [] };
    },
  }) as unknown as MbtaClient;

test("buildTripPlan returns a primary route with realtime confidence when predictions exist", async () => {
  const stopA = makeStop("place-a", "Stop A", 42.0, -71.0);
  const stopB = makeStop("place-b", "Stop B", 42.01, -71.01);
  const routes = [makeRoute("Red", 0)];

  const cache = new MbtaCache();
  cache.setRoutes(routes);
  cache.setStops([stopA, stopB]);

  const client = buildClient({
    stops: [stopA, stopB],
    routes,
    predictionTime: new Date().toISOString(),
    arrivalTime: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
    includePrediction: true,
  });

  const plan = await buildTripPlan(client, cache, {
    originLat: 42.0,
    originLon: -71.0,
    destLat: 42.01,
    destLon: -71.01,
    modes: ["subway"],
  });

  assert.ok(plan);
  assert.equal(plan.summary.confidence, "realtime");
  assert.ok(plan.primary.legs.length >= 2);
});

test("buildTripPlan falls back to schedule when predictions are missing", async () => {
  const stopA = makeStop("place-a", "Stop A", 42.0, -71.0);
  const stopB = makeStop("place-b", "Stop B", 42.01, -71.01);
  const routes = [makeRoute("Red", 0)];

  const cache = new MbtaCache();
  cache.setRoutes(routes);
  cache.setStops([stopA, stopB]);

  const client = buildClient({
    stops: [stopA, stopB],
    routes,
    predictionTime: new Date().toISOString(),
    arrivalTime: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
    includePrediction: false,
  });

  const plan = await buildTripPlan(client, cache, {
    originLat: 42.0,
    originLon: -71.0,
    destLat: 42.01,
    destLon: -71.01,
    modes: ["subway"],
  });

  assert.ok(plan);
  assert.equal(plan.summary.confidence, "fallback");
});

test("buildTripPlan returns per-walk polylines when multiple walk legs exist", async () => {
  const stopA = makeStop("place-a", "Stop A", 42.0, -71.0);
  const stopB = makeStop("place-b", "Stop B", 42.01, -71.01);
  const routes = [makeRoute("Red", 0)];

  const cache = new MbtaCache();
  cache.setRoutes(routes);
  cache.setStops([stopA, stopB]);

  const client = buildClient({
    stops: [stopA, stopB],
    routes,
    predictionTime: new Date().toISOString(),
    arrivalTime: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
    includePrediction: true,
  });

  const plan = await buildTripPlan(client, cache, {
    originLat: 42.0,
    originLon: -71.0,
    destLat: 42.01,
    destLon: -71.01,
    modes: ["subway"],
  });

  assert.ok(plan);
  const walkLegs = plan.primary.legs.filter((leg) => leg.mode === "walk");
  const walkPolylines = plan.primary.map.walkPolylines ?? [];
  assert.equal(walkPolylines.length, walkLegs.length);
  assert.equal(plan.primary.map.walkPolyline ?? null, null);
});

test("buildStationGraphFromDb maps platform stops to station ids", () => {
  const stops = [
    {
      id: "70067",
      name: "Harvard",
      lat: 42.374663,
      lon: -71.118814,
      parentStationId: "place-harsq",
      wheelchairBoarding: 1,
      locationType: 0,
    },
    {
      id: "70197",
      name: "Park Street",
      lat: 42.356395,
      lon: -71.062424,
      parentStationId: "place-pktrm",
      wheelchairBoarding: 1,
      locationType: 0,
    },
  ];
  const edges = [
    {
      fromStopId: "70067",
      toStopId: "70197",
      routeId: "Red",
      directionId: 0,
      weightMinutes: null,
    },
  ];
  const routes = [
    {
      id: "Red",
      shortName: "Red",
      longName: "Red Line",
      type: 0,
      color: "DA291C",
      textColor: "FFFFFF",
    },
  ];

  const { graph, stationStopMap } = buildStationGraphFromDb(edges, stops, routes, ["Red"]);
  const harvardEdges = graph.get("place-harsq") ?? [];
  assert.equal(harvardEdges.length, 1);
  assert.equal(harvardEdges[0]?.to, "place-pktrm");
  assert.equal(stationStopMap.get("place-harsq"), "70067");
  assert.equal(stationStopMap.get("place-pktrm"), "70197");
});

test("findWeightedPath prefers the better transfer station", () => {
  const edges = new Map<string, any[]>([
    [
      "place-a",
      [
        { to: "place-b", routeId: "R1", directionId: 0, weightMinutes: 5, mode: "subway" },
        { to: "place-c", routeId: "R1", directionId: 0, weightMinutes: 2, mode: "subway" },
      ],
    ],
    ["place-b", [{ to: "place-d", routeId: "R2", directionId: 0, weightMinutes: 5, mode: "subway" }]],
    ["place-c", [{ to: "place-d", routeId: "R2", directionId: 0, weightMinutes: 20, mode: "subway" }]],
  ]);

  const result = findWeightedPath(edges as Map<string, any>, "place-a", "place-d");
  const transferStops = result.path.map((hop) => hop.to);
  assert.equal(transferStops.includes("place-b"), true);
  assert.equal(transferStops.includes("place-c"), false);
});

test("findWeightedPath locks in a two-transfer path", () => {
  const edges = new Map<string, any[]>([
    ["place-a", [{ to: "place-x", routeId: "R1", directionId: 0, weightMinutes: 4, mode: "subway" }]],
    ["place-x", [{ to: "place-y", routeId: "R2", directionId: 0, weightMinutes: 4, mode: "subway" }]],
    ["place-y", [{ to: "place-d", routeId: "R3", directionId: 0, weightMinutes: 4, mode: "subway" }]],
  ]);

  const result = findWeightedPath(edges as Map<string, any>, "place-a", "place-d");
  assert.equal(result.path.length, 3);
  assert.equal(result.path[0]?.edge.routeId, "R1");
  assert.equal(result.path[1]?.edge.routeId, "R2");
  assert.equal(result.path[2]?.edge.routeId, "R3");
  assert.equal(result.path[1]?.from, "place-x");
  assert.equal(result.path[1]?.to, "place-y");
});
