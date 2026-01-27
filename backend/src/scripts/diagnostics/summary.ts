import type { generateEtaReport } from "../../reports/etaReport";
import type { buildStationMappingReport } from "../../reports/stationMappingReport";
import type { DiagnosticsArgs } from "./args";

type EtaReport = Awaited<ReturnType<typeof generateEtaReport>>;
type StationReport = ReturnType<typeof buildStationMappingReport>;

const formatPercentage = (value: number): string => `${value.toFixed(1)}%`;

export const buildSummaryMarkdown = (
  args: DiagnosticsArgs,
  etaReport: EtaReport,
  stationReport: StationReport,
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
