import fs from "node:fs/promises";
import path from "node:path";
import { createMbtaClient } from "../mbta/client";
import type { MbtaStop } from "../models/mbta";
import { generateEtaReport } from "../reports/etaReport";
import { buildStationMappingReport, type StationMappingOptions } from "../reports/stationMappingReport";

const ensureArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const DEFAULT_STOP_IDS = ["place-davis", "place-harsq"];
const DEFAULT_BBOX_LIMIT = 10;
const OUTPUT_DIR = path.join(process.cwd(), "diagnostics");

interface DiagnosticsArgs {
  stopIds: string[];
  routeIds: string[];
  boundingBox?: { north: number; south: number; east: number; west: number };
  limit?: number;
  windowMinutes?: number;
}

const parseArgs = (argv: string[]): DiagnosticsArgs => {
  const args: DiagnosticsArgs = {
    stopIds: [],
    routeIds: [],
  };

  argv.forEach((arg) => {
    if (!arg.startsWith("--")) {
      args.stopIds.push(arg);
      return;
    }

    const [key, rawValue] = arg.slice(2).split("=");
    const value = rawValue ?? "";
    switch (key) {
      case "stops":
        args.stopIds.push(
          ...value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "routes":
        args.routeIds.push(
          ...value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        break;
      case "bbox": {
        const parts = value.split(",").map((entry) => Number(entry.trim()));
        const [north, south, east, west] = parts;
        if (
          parts.length === 4 &&
          Number.isFinite(north) &&
          Number.isFinite(south) &&
          Number.isFinite(east) &&
          Number.isFinite(west)
        ) {
          args.boundingBox = {
            north: north!,
            south: south!,
            east: east!,
            west: west!,
          };
        }
        break;
      }
      case "limit": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          args.limit = parsed;
        }
        break;
      }
      case "window": {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          args.windowMinutes = parsed;
        }
        break;
      }
      default:
        break;
    }
  });

  return args;
};

const isBoardableStop = (stop: MbtaStop): boolean => {
  const locationType = stop.attributes.location_type ?? 0;
  return locationType === 0 || locationType === 1 || locationType === 4;
};

const selectStopsInBoundingBox = (
  stops: MbtaStop[],
  bbox: DiagnosticsArgs["boundingBox"],
  limit: number,
): string[] => {
  if (!bbox) return [];
  return stops
    .filter(
      (stop) =>
        isBoardableStop(stop) &&
        stop.attributes.latitude <= bbox.north &&
        stop.attributes.latitude >= bbox.south &&
        stop.attributes.longitude >= bbox.west &&
        stop.attributes.longitude <= bbox.east,
    )
    .slice(0, limit)
    .map((stop) => stop.id);
};

const fetchRouteStops = async (routeIds: string[], client = createMbtaClient()): Promise<string[]> => {
  if (routeIds.length === 0) return [];
  const results = await Promise.all(
    routeIds.map((routeId) =>
      client
        .getStops({
          "filter[route]": routeId,
          "page[limit]": 500,
        })
        .then((response) => ensureArray(response.data).map((stop) => stop.id)),
    ),
  );
  return Array.from(new Set(results.flat()));
};

const formatPercentage = (value: number): string => `${value.toFixed(1)}%`;

const buildSummaryMarkdown = (
  args: DiagnosticsArgs,
  etaReport: Awaited<ReturnType<typeof generateEtaReport>>,
  stationReport: ReturnType<typeof buildStationMappingReport>,
  focusStops: string[],
): string => {
  const aggregate = etaReport.aggregateSummary;
  const lowCoverageList =
    aggregate.lowCoverageStops.length === 0
      ? "None"
      : aggregate.lowCoverageStops
          .map(
            (stop) =>
              `- ${stop.stopId}${stop.stopName ? ` (${stop.stopName})` : ""}: ${formatPercentage(stop.predictionCoveragePct)} (${stop.predictionDepartures}/${stop.totalDepartures})`,
          )
          .join("\n");

  const stationIssues = stationReport.rows.filter((row) => row.issues.length > 0);
  const missingParentStations = stationIssues.filter((row) => row.issues.includes("missing_parent_station"));
  const parentNotLoadedStations = stationIssues.filter((row) => row.issues.includes("parent_not_loaded"));
  const parentIssueList =
    stationIssues.length === 0
      ? "None"
      : stationIssues
          .slice(0, 10)
          .map(
            (row) =>
              `- ${row.stopId} (${row.name}): ${row.issues.join(", ")}`,
          )
          .join("\n");

  const boardableCount = stationReport.rows.filter((row) => row.isBoardable).length;
  const entranceCount = stationReport.rows.filter((row) => row.kind === "entrance").length;

  const bboxInfo = args.boundingBox
    ? `Bounding box north=${args.boundingBox.north}, south=${args.boundingBox.south}, east=${args.boundingBox.east}, west=${args.boundingBox.west}`
    : "Bounding box: not provided";

  return [
    `# Diagnostics Summary (${new Date().toISOString()})`,
    "",
    `Focus stops: ${focusStops.join(", ") || "(default)"}`,
    bboxInfo,
    `Route filters: ${args.routeIds.length > 0 ? args.routeIds.join(", ") : "none"}`,
    "",
    "## ETA Coverage",
    `- Stops analyzed: ${aggregate.totalStops}`,
    `- Total departures: ${aggregate.totalDepartures}`,
    `- Prediction coverage: ${formatPercentage(aggregate.predictionCoveragePct)} (${aggregate.predictionDepartures}/${aggregate.totalDepartures})`,
    `- Schedule fallbacks: ${aggregate.scheduleDepartures}`,
    `- Average delay: ${aggregate.averageDelayMinutes ?? "n/a"} min`,
    `- Max delay: ${aggregate.maximumDelayMinutes ?? "n/a"} min`,
    "",
    "### Low Coverage Stops (<40% realtime)",
    lowCoverageList,
    "",
    "## Station Mapping",
    `- Stops sampled: ${stationReport.rows.length}`,
    `- Boardable stops: ${boardableCount}`,
    `- Entrances/others filtered: ${entranceCount}`,
    `- Missing parent stations: ${missingParentStations.length}`,
    `- Parent records not loaded: ${parentNotLoadedStations.length}`,
    "",
    "### Notable Issues",
    parentIssueList,
    "",
    "_This summary is auto-generated from `npm run report:diagnostics`._",
  ].join("\n");
};

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

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT_DIR, "eta-report.json"),
    JSON.stringify(etaReport, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(OUTPUT_DIR, "eta-report.csv"), etaReport.csv, "utf8");

  await fs.writeFile(
    path.join(OUTPUT_DIR, "station-mapping.json"),
    JSON.stringify(stationReport, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(OUTPUT_DIR, "station-mapping.csv"), stationReport.csv, "utf8");
  const missingParentStations = stationReport.rows.filter((row) => row.issues.includes("missing_parent_station"));
  const parentNotLoadedStations = stationReport.rows.filter((row) => row.issues.includes("parent_not_loaded"));
  await fs.writeFile(
    path.join(OUTPUT_DIR, "station-parent-issues.json"),
    JSON.stringify(
      {
        generatedAt: stationReport.generatedAt,
        missingParentStations: missingParentStations.slice(0, 100),
        parentNotLoadedStations: parentNotLoadedStations.slice(0, 100),
        missingParentCount: missingParentStations.length,
        parentNotLoadedCount: parentNotLoadedStations.length,
      },
      null,
      2,
    ),
    "utf8",
  );

  const summaryMarkdown = buildSummaryMarkdown(args, etaReport, stationReport, focusStops);
  await fs.writeFile(path.join(OUTPUT_DIR, "diagnostic-summary.md"), summaryMarkdown, "utf8");

  const totalDepartures = etaReport.stops
    .map((stop) => stop.departures.length)
    .reduce((sum, count) => sum + count, 0);

  console.log(
    `[diagnostics] reports written to ${OUTPUT_DIR}. Stops sampled: ${etaReport.stops.length}, departures: ${totalDepartures}, missing parent stations: ${missingParentStations.length}`,
  );
};

if (require.main === module) {
  runDiagnosticsCli(process.argv.slice(2)).catch((error) => {
    console.error("[diagnostics] failed", error);
    process.exitCode = 1;
  });
}
