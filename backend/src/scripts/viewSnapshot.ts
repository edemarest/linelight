import fs from "node:fs";
import path from "node:path";
import { createMbtaCache } from "../cache/mbtaCache";
import { createMbtaClient } from "../mbta/client";
import { buildLineSummaries } from "../services/lineSummaries";
import { buildLineOverview } from "../services/lineOverview";
import { buildStationBoard } from "../services/stationBoard";
import { buildSystemInsights } from "../services/systemInsights";
import { extractFirstRelationshipId } from "../utils/jsonApi";

const ensureArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const ROUTES = ["Red", "Orange", "Blue", "Green-B", "Green-C", "Green-D", "Green-E", "Mattapan"];
const SAMPLE_LINE = "line-Red";

const main = async () => {
  const client = createMbtaClient();
  const cache = createMbtaCache();

  const [routes, lines, stops, predictions, vehicles, alerts, trips] = await Promise.all([
    client.getRoutes(),
    client.getLines({ include: "routes" }),
    client.getStops({ "filter[route_type]": "0,1", "page[limit]": 5000 }),
    client.getPredictions({
      "filter[route]": ROUTES,
      include: "route,stop,trip",
      "page[limit]": 500,
    }),
    client.getVehicles({ "filter[route]": ROUTES }),
    client.getAlerts(),
    client.getTrips({ "filter[route]": ROUTES, "page[limit]": 500 }),
  ]);

  cache.setRoutes(ensureArray(routes.data));
  cache.setLines(ensureArray(lines.data));
  cache.setStops(ensureArray(stops.data));
  cache.setPredictions(ensureArray(predictions.data));
  cache.setVehicles(ensureArray(vehicles.data));
  cache.setAlerts(ensureArray(alerts.data));
  cache.setTrips(ensureArray(trips.data));

  const summaries = buildLineSummaries(cache);
  const activeLineId =
    summaries.lines.find((line) => line.vehicleCount > 0)?.lineId ?? SAMPLE_LINE;
  const overview = buildLineOverview(cache, activeLineId);
  const predictionSample = cache.getPredictions()?.data[0];
  const sampleStop = predictionSample
    ? extractFirstRelationshipId(predictionSample.relationships?.stop)
    : null;
  const stationBoard = sampleStop ? buildStationBoard(cache, sampleStop) : null;
  const insights = buildSystemInsights(cache);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    lineSummaryReady: summaries.ready,
    sampleLineId: activeLineId,
    sampleOverviewVehicles: overview?.activeVehicles ?? null,
    sampleSegments: overview?.segments.slice(0, 3) ?? [],
    stationBoard: stationBoard
      ? {
          stopId: stationBoard.stopId,
          departures: stationBoard.departuresByLine.map((group) => ({
            lineId: group.lineId,
            count: group.departures.length,
          })),
        }
      : null,
    systemTroubleCount: insights.topTroubleSegments.length,
  };

  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const samplesDir = path.join(projectRoot, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  const outputPath = path.join(samplesDir, "backend-view-check.json");
  fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
  console.log(`Backend view snapshot saved to ${outputPath}`);
};

main().catch((error) => {
  console.error("View snapshot failed", error);
  process.exit(1);
});
