import path from "node:path";
import { createMbtaClient } from "../../mbta/client";
import type { MbtaStop } from "../../models/mbta";
import { generateEtaReport } from "../../reports/etaReport";
import { buildStationMappingReport, type StationMappingOptions } from "../../reports/stationMappingReport";
import { ensureArray } from "../../utils/collections";
import {
  DEFAULT_BBOX_LIMIT,
  DEFAULT_STOP_IDS,
  fetchRouteStops,
  parseArgs,
  selectStopsInBoundingBox,
} from "./args";
import { writeDiagnosticsReports } from "./io";
import { buildSummaryMarkdown } from "./summary";

const OUTPUT_DIR = path.join(process.cwd(), "diagnostics");

export const runDiagnosticsCli = async (argv: string[]) => {
  const args = parseArgs(argv);
  const client = createMbtaClient();

  const stopsResponse = await client.getStops({
    "filter[route_type]": "0,1,2,3",
    "page[limit]": 5000,
  });
  const stops = ensureArray(stopsResponse.data) as MbtaStop[];
  const stopLookup = new Map(stops.map((stop) => [stop.id, stop]));

  const focusStopSet = new Set<string>(args.stopIds);

  const routeStops = await fetchRouteStops(args.routeIds, client);
  routeStops.forEach((stopId) => focusStopSet.add(stopId));

  const bboxLimit = args.limit ?? DEFAULT_BBOX_LIMIT;
  selectStopsInBoundingBox(stops, args.boundingBox, bboxLimit).forEach((stopId) => focusStopSet.add(stopId));

  const focusStops =
    focusStopSet.size > 0 ? Array.from(focusStopSet) : DEFAULT_STOP_IDS;

  console.log(
    `[diagnostics] generating reports for ${focusStops.join(", ")}${
      args.boundingBox ? ` within bbox (${args.boundingBox.north},${args.boundingBox.south},${args.boundingBox.east},${args.boundingBox.west})` : ""
    }`,
  );

  const etaOptions: Parameters<typeof generateEtaReport>[1] = {
    stopIds: focusStops,
    stopLookup,
  };
  if (typeof args.windowMinutes === "number") {
    etaOptions.windowMinutes = args.windowMinutes;
  }
  const etaReport = await generateEtaReport(client, etaOptions);

  const stationOptions: StationMappingOptions = {
    stopIds: focusStops,
  };
  if (typeof args.limit === "number") {
    stationOptions.limit = args.limit;
  }
  if (args.boundingBox) {
    stationOptions.boundingBox = args.boundingBox;
  }
  const stationReport = buildStationMappingReport(stops, stationOptions);

  const summaryMarkdown = buildSummaryMarkdown(args, etaReport, stationReport, focusStops);

  const { missingParentStations } = await writeDiagnosticsReports(
    OUTPUT_DIR,
    etaReport,
    stationReport,
    summaryMarkdown,
  );

  const totalDepartures = etaReport.stops
    .map((stop) => stop.departures.length)
    .reduce((sum, count) => sum + count, 0);

  console.log(
    `[diagnostics] reports written to ${OUTPUT_DIR}. Stops sampled: ${etaReport.stops.length}, departures: ${totalDepartures}, missing parent stations: ${missingParentStations.length}`,
  );
};
