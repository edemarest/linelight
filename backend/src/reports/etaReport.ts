import type { MbtaClient } from "../mbta/client";
import type { MbtaStop } from "../models/mbta";
import {
  fetchBlendedDepartures,
  type BlendedDeparture,
  type BlendOptions,
} from "../services/etaBlender";

export interface StopEtaReport {
  stopId: string;
  stopName?: string;
  departures: BlendedDeparture[];
  summary: EtaReportSummary;
}

export interface EtaReportSummary {
  total: number;
  withPredictions: number;
  scheduleOnly: number;
  averageDelayMinutes: number | null;
  maximumDelayMinutes: number | null;
}

export interface EtaReportResult {
  generatedAt: string;
  stops: StopEtaReport[];
  csv: string;
  aggregateSummary: EtaAggregateSummary;
}

export interface EtaReportOptions {
  stopIds: string[];
  stopLookup?: Map<string, MbtaStop>;
  windowMinutes?: number;
  maxLookaheadMinutes?: number;
  minLookaheadMinutes?: number;
}

export interface StopCoverageSnapshot {
  stopId: string;
  stopName?: string;
  totalDepartures: number;
  predictionDepartures: number;
  predictionCoveragePct: number;
}

export interface EtaAggregateSummary {
  totalStops: number;
  totalDepartures: number;
  predictionDepartures: number;
  scheduleDepartures: number;
  predictionCoveragePct: number;
  averageDelayMinutes: number | null;
  maximumDelayMinutes: number | null;
  stopCoverage: StopCoverageSnapshot[];
  lowCoverageStops: StopCoverageSnapshot[];
}

const computeSummary = (rows: BlendedDeparture[]): EtaReportSummary => {
  const delays = rows
    .map((row) => row.discrepancyMinutes ?? null)
    .filter((value): value is number => value != null);
  const averageDelay =
    delays.length > 0 ? Number((delays.reduce((sum, value) => sum + value, 0) / delays.length).toFixed(1)) : null;
  const maximumDelay = delays.length > 0 ? Math.max(...delays) : null;
  const withPredictions = rows.filter((row) => row.etaSource === "prediction").length;
  const scheduleOnly = rows.filter((row) => row.etaSource === "schedule").length;

  return {
    total: rows.length,
    withPredictions,
    scheduleOnly,
    averageDelayMinutes: averageDelay,
    maximumDelayMinutes: maximumDelay,
  };
};

const toCsv = (rows: BlendedDeparture[]): string => {
  const header = [
    "stop_id",
    "stop_name",
    "route_id",
    "trip_id",
    "direction_id",
    "headsign",
    "scheduled_time",
    "prediction_time",
    "final_time",
    "eta_minutes",
    "eta_source",
    "status",
    "delay_minutes",
  ];
  const lines = rows.map((row) =>
    [
      row.stopId,
      row.stopName ?? "",
      row.routeId ?? "",
      row.tripId ?? "",
      row.directionId ?? "",
      row.headsign ?? "",
      row.scheduledTime ?? "",
      row.predictedTime ?? "",
      row.finalTime ?? "",
      row.etaMinutes ?? "",
      row.etaSource,
      row.status,
      row.discrepancyMinutes ?? "",
    ]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
};

export const generateEtaReport = async (
  client: MbtaClient,
  options: EtaReportOptions,
): Promise<EtaReportResult> => {
  const stopLookup = options.stopLookup ?? new Map<string, MbtaStop>();
  const stops = await Promise.all(
    options.stopIds.map(async (stopId) => {
      const stopName = stopLookup.get(stopId)?.attributes.name;
      const blendOptions: BlendOptions = {};
      if (typeof options.windowMinutes === "number") {
        blendOptions.windowMinutes = options.windowMinutes;
      }
      if (typeof options.maxLookaheadMinutes === "number") {
        blendOptions.maxLookaheadMinutes = options.maxLookaheadMinutes;
      }
      if (typeof options.minLookaheadMinutes === "number") {
        blendOptions.minLookaheadMinutes = options.minLookaheadMinutes;
      }
      if (stopName) {
        blendOptions.stopName = stopName;
      }
      const departures = await fetchBlendedDepartures(client, stopId, blendOptions);
      const stopReport: StopEtaReport = {
        stopId,
        departures,
        summary: computeSummary(departures),
      };
      if (stopName) {
        stopReport.stopName = stopName;
      }
      return stopReport;
    }),
  );

  const csv = toCsv(stops.flatMap((stop) => stop.departures));
  const aggregateSummary = buildAggregateSummary(stops);

  return {
    generatedAt: new Date().toISOString(),
    stops,
    csv,
    aggregateSummary,
  };
};

const LOW_COVERAGE_THRESHOLD = 0.4;

const buildAggregateSummary = (stops: StopEtaReport[]): EtaAggregateSummary => {
  const totals = stops.reduce(
    (acc, stop) => {
      acc.totalDepartures += stop.summary.total;
      acc.predictionDepartures += stop.summary.withPredictions;
      acc.scheduleDepartures += stop.summary.scheduleOnly;
      return acc;
    },
    {
      totalDepartures: 0,
      predictionDepartures: 0,
      scheduleDepartures: 0,
    },
  );

  const allDelays = stops
    .flatMap((stop) => stop.departures.map((dep) => dep.discrepancyMinutes ?? null))
    .filter((value): value is number => value != null);
  const averageDelay =
    allDelays.length > 0 ? Number((allDelays.reduce((sum, value) => sum + value, 0) / allDelays.length).toFixed(1)) : null;
  const maximumDelay = allDelays.length > 0 ? Math.max(...allDelays) : null;

  const stopCoverage = stops
    .map((stop) => {
      const coverage =
        stop.summary.total > 0 ? stop.summary.withPredictions / stop.summary.total : 0;
      const snapshot: StopCoverageSnapshot = {
        stopId: stop.stopId,
        totalDepartures: stop.summary.total,
        predictionDepartures: stop.summary.withPredictions,
        predictionCoveragePct: Number((coverage * 100).toFixed(1)),
      };
      if (stop.stopName) {
        snapshot.stopName = stop.stopName;
      }
      return snapshot;
    })
    .sort((a, b) => a.predictionCoveragePct - b.predictionCoveragePct);

  const lowCoverageStops = stopCoverage.filter(
    (snapshot) =>
      snapshot.totalDepartures > 0 &&
      snapshot.predictionCoveragePct / 100 < LOW_COVERAGE_THRESHOLD,
  );

  return {
    totalStops: stops.length,
    totalDepartures: totals.totalDepartures,
    predictionDepartures: totals.predictionDepartures,
    scheduleDepartures: totals.scheduleDepartures,
    predictionCoveragePct:
      totals.totalDepartures > 0
        ? Number(((totals.predictionDepartures / totals.totalDepartures) * 100).toFixed(1))
        : 0,
    averageDelayMinutes: averageDelay,
    maximumDelayMinutes: maximumDelay,
    stopCoverage,
    lowCoverageStops,
  };
};
