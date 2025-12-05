import fs from "node:fs";
import path from "node:path";
import { createMbtaClient } from "../mbta/client";
import { extractRelationshipIds } from "../utils/jsonApi";

const SAMPLE_ROUTES = ["Red", "Orange", "Blue"];

const toArray = <T>(value: T | T[] | undefined | null): T[] => {
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

const main = async () => {
  const client = createMbtaClient();
  const start = Date.now();

  const [
    routesResponse,
    predictionsResponse,
    vehiclesResponse,
    linesResponse,
    alertsResponse,
    tripsResponse,
    stopsResponse,
  ] =
    await Promise.all([
      client.getRoutes(),
      client.getPredictions({
        "filter[route]": SAMPLE_ROUTES,
        "page[limit]": 50,
      }),
      client.getVehicles({
        "filter[route]": SAMPLE_ROUTES,
      }),
      client.getLines({ include: "routes" }),
      client.getAlerts({ "page[limit]": 5 }),
      client.getTrips({
        "filter[route]": SAMPLE_ROUTES,
        "page[limit]": 50,
      }),
      client.getStops({
        "filter[route_type]": "0,1",
        include: "parent_station",
        "page[limit]": 200,
      }),
    ]);

  const predictionRoutesByStop = new Map<string, Set<string>>();
  toArray(predictionsResponse.data).forEach((prediction) => {
    const stopId = prediction.relationships?.stop?.data && "id" in prediction.relationships.stop.data ? prediction.relationships.stop.data.id : null;
    const routeId = prediction.relationships?.route?.data && "id" in prediction.relationships.route.data ? prediction.relationships.route.data.id : null;
    if (!stopId || !routeId) return;
    const set = predictionRoutesByStop.get(stopId) ?? new Set<string>();
    set.add(routeId);
    predictionRoutesByStop.set(stopId, set);
  });

  const railRouteIds = toArray(routesResponse.data)
    .filter((route) => route.attributes.type === 0 || route.attributes.type === 1)
    .map((route) => route.id);
  const stopRoutesFromRouteApi = new Map<string, Set<string>>();
  const routeChunks = chunkArray(railRouteIds, 5);
  for (const chunk of routeChunks) {
    const results = await Promise.allSettled(
      chunk.map((routeId) =>
        client
          .getStops({
            "filter[route]": routeId,
            "page[limit]": 200,
          })
          .then((res) => ({ routeId, data: toArray(res.data) })),
      ),
    );
    results.forEach((result) => {
      if (result.status !== "fulfilled") {
        console.warn("[sampleQueries] failed to fetch stops for route", result.reason);
        return;
      }
      result.value.data.forEach((stop) => {
        const set = stopRoutesFromRouteApi.get(stop.id) ?? new Set<string>();
        set.add(result.value.routeId);
        stopRoutesFromRouteApi.set(stop.id, set);
      });
    });
  }

  const sampleData = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    counts: {
      routes: toArray(routesResponse.data).length,
      predictions: toArray(predictionsResponse.data).length,
      vehicles: toArray(vehiclesResponse.data).length,
      trips: toArray(tripsResponse.data).length,
    },
    sample: {
      routes: toArray(routesResponse.data)
        .slice(0, 3)
        .map((route) => ({
          id: route.id,
          long_name: route.attributes.long_name,
          type: route.attributes.type,
        })),
      predictions: toArray(predictionsResponse.data)
        .slice(0, 3)
        .map((prediction) => ({
          id: prediction.id,
          routeId: prediction.relationships?.route?.data && "id" in prediction.relationships.route.data
            ? prediction.relationships.route.data.id
            : null,
          arrival_time: prediction.attributes.arrival_time,
          departure_time: prediction.attributes.departure_time,
          status: prediction.attributes.status,
        })),
      vehicles: toArray(vehiclesResponse.data)
        .slice(0, 3)
        .map((vehicle) => ({
          id: vehicle.id,
          latitude: vehicle.attributes.latitude,
          longitude: vehicle.attributes.longitude,
          bearing: vehicle.attributes.bearing,
          updated_at: vehicle.attributes.updated_at,
        })),
      lines: toArray(linesResponse.data)
        .slice(0, 3)
        .map((line) => ({
          id: line.id,
          name: line.attributes.long_name,
          routeRefs: extractRelationshipIds(line.relationships?.routes),
        })),
      alerts: toArray(alertsResponse.data).map((alert) => ({
        id: alert.id,
        header: alert.attributes.header_text,
        routes: extractRelationshipIds(alert.relationships?.routes),
        stops: extractRelationshipIds(alert.relationships?.stops),
      })),
      trips: toArray(tripsResponse.data)
        .slice(0, 3)
        .map((trip) => ({
          id: trip.id,
          headsign: trip.attributes.headsign,
          direction_id: trip.attributes.direction_id,
        })),
      stops: toArray(stopsResponse.data)
        .slice(0, 10)
        .map((stop) => ({
          id: stop.id,
          name: stop.attributes.name,
          location_type: stop.attributes.location_type ?? null,
          latitude: stop.attributes.latitude,
          longitude: stop.attributes.longitude,
          parent_station: extractRelationshipIds(stop.relationships?.parent_station)[0] ?? null,
          platform_code: stop.attributes.platform_code ?? null,
          platform_name: stop.attributes.platform_name ?? null,
          routes_from_predictions: Array.from(predictionRoutesByStop.get(stop.id) ?? []),
          routes_from_route_api: Array.from(stopRoutesFromRouteApi.get(stop.id) ?? []),
        })),
      stopRouteCoverage: {
        totalRailRoutes: railRouteIds.length,
        routesSampled: stopRoutesFromRouteApi.size,
        sample: Array.from(stopRoutesFromRouteApi.entries())
          .slice(0, 5)
          .map(([stopId, routes]) => ({ stopId, routes: Array.from(routes) })),
      },
    },
  };

  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const samplesDir = path.join(projectRoot, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });

  const outputPath = path.join(samplesDir, "latest-mbta-sample.json");
  fs.writeFileSync(outputPath, JSON.stringify(sampleData, null, 2), "utf-8");

  console.log(
    [
      `Sample data saved to ${outputPath}`,
      `Routes captured: ${sampleData.counts.routes}`,
      `Predictions captured: ${sampleData.counts.predictions}`,
      `Vehicles captured: ${sampleData.counts.vehicles}`,
      `Trips captured: ${sampleData.counts.trips}`,
      `Stops sampled: ${toArray(stopsResponse.data).length}`,
      `Stop-route entries recorded: ${stopRoutesFromRouteApi.size}`,
    ].join("\n"),
  );
};

main().catch((error) => {
  console.error("Sample query failed", error);
  process.exit(1);
});
