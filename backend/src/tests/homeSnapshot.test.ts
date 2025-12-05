import test from "node:test";
import assert from "node:assert/strict";
import { MbtaCache } from "../cache/mbtaCache";
import type { MbtaStop, MbtaRoute } from "../models/mbta";
import type { MbtaClient } from "../mbta/client";
import { buildHomeSnapshot } from "../services/homeSnapshot";
import type { StopEtaSnapshot } from "../services/etaService";
import type { BlendedDeparture } from "../services/etaBlender";

type StopOverrides = Omit<Partial<MbtaStop>, "attributes"> & {
  attributes?: Partial<MbtaStop["attributes"]>;
};

const makeStop = (overrides: StopOverrides): MbtaStop => ({
  id: overrides.id ?? "stop-id",
  type: overrides.type ?? "stop",
  attributes: {
    name: "Stop",
    description: null,
    latitude: 42.36,
    longitude: -71.06,
    wheelchair_boarding: 1,
    location_type: 0,
    platform_code: null,
    platform_name: null,
    ...overrides.attributes,
  },
  relationships: overrides.relationships ?? {},
});

const createDeparture = (routeId: string, directionId: 0 | 1, etaMinutes: number): BlendedDeparture => ({
  stopId: "any-stop",
  routeId,
  directionId,
  tripId: `${routeId}-${directionId}`,
  stopSequence: 5,
  scheduledTime: new Date().toISOString(),
  predictedTime: null,
  finalTime: new Date(Date.now() + etaMinutes * 60000).toISOString(),
  etaMinutes,
  etaSource: "prediction",
  status: "on_time",
  discrepancyMinutes: null,
});

const buildFixture = () => {
  const parentStation = makeStop({
    id: "place-gover",
    attributes: {
      name: "Government Center",
      latitude: 42.3597,
      longitude: -71.0592,
      location_type: 1,
    },
  });

  const inboundPlatform = makeStop({
    id: "70040",
    attributes: {
      name: "Government Center - Blue",
      latitude: 42.35971,
      longitude: -71.05925,
      location_type: 0,
    },
    relationships: {
      parent_station: { data: { id: parentStation.id, type: "stop" } },
    },
  });

  const outboundPlatform = makeStop({
    id: "70202",
    attributes: {
      name: "Government Center - Green",
      latitude: 42.35969,
      longitude: -71.05918,
      location_type: 0,
    },
    relationships: {
      parent_station: { data: { id: parentStation.id, type: "stop" } },
    },
  });

  const routes: MbtaRoute[] = [
    {
      id: "Green-B",
      type: "route",
      attributes: {
        short_name: "B",
        long_name: "Green Line B",
        description: null,
        type: 0,
        color: "00843D",
        text_color: "FFFFFF",
        sort_order: 100,
      },
      relationships: {},
    },
    {
      id: "Blue",
      type: "route",
      attributes: {
        short_name: "Blue",
        long_name: "Blue Line",
        description: null,
        type: 1,
        color: "003DA5",
        text_color: "FFFFFF",
        sort_order: 50,
      },
      relationships: {},
    },
  ];

  const snapshots = new Map<string, StopEtaSnapshot>();
  snapshots.set("70040", {
    stopId: "70040",
    generatedAt: new Date().toISOString(),
    departures: [
      { ...createDeparture("Blue", 0, 2), stopId: "70040" },
      { ...createDeparture("Blue", 1, 5), stopId: "70040" },
    ],
  });
  snapshots.set("70202", {
    stopId: "70202",
    generatedAt: new Date().toISOString(),
    departures: [
      { ...createDeparture("Green-B", 0, 3), stopId: "70202" },
      { ...createDeparture("Green-B", 1, 8), stopId: "70202" },
    ],
  });

  return {
    parentStation,
    inboundPlatform,
    outboundPlatform,
    routes,
    snapshots,
  };
};

const fakeClient = {} as MbtaClient;

test("buildHomeSnapshot merges platforms under one station and preserves direction metadata", async () => {
  const { parentStation, inboundPlatform, outboundPlatform, routes, snapshots } = buildFixture();
  const cache = new MbtaCache();
  cache.setStops([parentStation, inboundPlatform, outboundPlatform]);
  cache.setRoutes(routes);

  const result = await buildHomeSnapshot(
    cache,
    fakeClient,
    {
      lat: 42.3597,
      lng: -71.0592,
      radiusMeters: 500,
      limit: 5,
      favoriteStopIds: [inboundPlatform.id, outboundPlatform.id],
    },
    {
      fetchStopSnapshot: async (_client, stopId) => {
        const snapshot = snapshots.get(stopId);
        if (!snapshot) {
          return { stopId, generatedAt: new Date().toISOString(), departures: [] };
        }
        return snapshot;
      },
    },
  );

  assert.equal(result.nearby.length, 1);
  const station = result.nearby[0]!;
  assert.equal(station.stopId, parentStation.id);
  assert.ok(
    station.platformStopIds.includes(inboundPlatform.id) && station.platformStopIds.includes(outboundPlatform.id),
    "includes both platform stop IDs",
  );
  assert.equal(result.favorites.length, 1, "favorites deduplicate parent station");
  const routeWithDirection = station.routes.find((route) => route.routeId === "Green-B");
  assert(routeWithDirection, "Green-B route exists");
  assert.equal(routeWithDirection?.direction, "Inbound");
  assert.equal(routeWithDirection?.directionId, 0);
});
