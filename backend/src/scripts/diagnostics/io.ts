import fs from "node:fs/promises";
import path from "node:path";
import type { generateEtaReport } from "../../reports/etaReport";
import type { buildStationMappingReport } from "../../reports/stationMappingReport";

type EtaReport = Awaited<ReturnType<typeof generateEtaReport>>;
type StationReport = ReturnType<typeof buildStationMappingReport>;

export const writeDiagnosticsReports = async (
  outputDir: string,
  etaReport: EtaReport,
  stationReport: StationReport,
  summaryMarkdown: string,
) => {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "eta-report.json"),
    JSON.stringify(etaReport, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(outputDir, "eta-report.csv"), etaReport.csv, "utf8");

  await fs.writeFile(
    path.join(outputDir, "station-mapping.json"),
    JSON.stringify(stationReport, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(outputDir, "station-mapping.csv"), stationReport.csv, "utf8");

  const missingParentStations = stationReport.rows.filter((row) => row.issues.includes("missing_parent_station"));
  const parentNotLoadedStations = stationReport.rows.filter((row) => row.issues.includes("parent_not_loaded"));

  await fs.writeFile(
    path.join(outputDir, "station-parent-issues.json"),
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

  await fs.writeFile(path.join(outputDir, "diagnostic-summary.md"), summaryMarkdown, "utf8");

  return { missingParentStations, parentNotLoadedStations };
};
