import type { MbtaCache } from "../cache/mbtaCache";
import type { SystemInsights, LineInsight, SegmentTroubleSummary } from "../models/domain";
import { buildLineSummaries } from "./lineSummaries";

const computePainScore = (line: LineInsight) => {
  const alertPenalty = line.activeAlerts > 0 ? 30 : 0;
  const vehiclePenalty = Math.max(0, 10 - Math.min(line.activeVehicles, 10));
  return Math.min(100, 40 + alertPenalty + vehiclePenalty);
};

export const buildSystemInsights = (cache: MbtaCache): SystemInsights => {
  const lineSummaryView = buildLineSummaries(cache);
  const lines: LineInsight[] = lineSummaryView.lines.map((line) => ({
    lineId: line.lineId,
    displayName: line.displayName,
    mode: line.mode,
    painScore: 0,
    averageDelayMinutes: null,
    headwayVarianceMinutes: null,
    activeAlerts: line.hasAlerts ? 1 : 0,
    activeVehicles: line.vehicleCount,
  }));

  lines.forEach((line) => {
    line.painScore = computePainScore(line);
  });

  const troubleSegments: SegmentTroubleSummary[] = lines
    .filter((line) => line.activeAlerts > 0)
    .map((line) => ({
      lineId: line.lineId,
      summary: `${line.displayName} has active alerts`,
      severity: Math.min(10, Math.round(line.painScore / 10)),
    }))
    .slice(0, 5);

  return {
    generatedAt: lineSummaryView.generatedAt,
    lines,
    topTroubleSegments: troubleSegments,
  };
};

