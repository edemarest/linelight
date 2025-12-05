import cors from "cors";
import express from "express";
import { config } from "./config";
import { getMbtaClientTelemetry } from "./mbta/client";
import { initializePolling } from "./polling/startPolling";
import { buildLineSummaries } from "./services/lineSummaries";
import { buildLineOverview } from "./services/lineOverview";
import { buildSystemInsights } from "./services/systemInsights";
import { buildStationSummaries } from "./services/stationSummaries";
import { buildVehicleSnapshots } from "./services/vehicles";
import { isMode } from "./utils/routeMode";
import { generateEtaReport } from "./reports/etaReport";
import { buildStationMappingReport, type StationMappingOptions } from "./reports/stationMappingReport";
import { buildLineShapes } from "./services/lineShapes";
import { buildHomeSnapshot } from "./services/homeSnapshot";
import { buildStationBoardV2 } from "./services/stationBoardV2";
import { buildTripTrack } from "./services/tripTrack";
import { logger } from "./utils/logger";

const app = express();

app.use(cors());
app.use(express.json());

const polling = initializePolling();

const parseNumberParam = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseStringList = (value: unknown): string[] => {
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
};

app.get("/api/home", async (req, res) => {
  const lat = parseNumberParam(req.query.lat);
  const lng = parseNumberParam(req.query.lng);
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "bad_request", message: "lat and lng are required" });
  }
  const radius = Math.min(5000, Math.max(100, parseNumberParam(req.query.radius) ?? 1200));
  const limit = Math.min(20, Math.max(1, parseNumberParam(req.query.limit) ?? 10));
  const favoriteStopIds = parseStringList(req.query.favorites);
  try {
    const response = await buildHomeSnapshot(polling.cache, polling.client, {
      lat,
      lng,
      radiusMeters: radius,
      limit,
      favoriteStopIds: favoriteStopIds.filter(Boolean),
    });
    return res.json(response);
  } catch (error) {
    logger.error("Failed to build home snapshot", { message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to build home snapshot" });
  }
});

app.get("/api/health", (_req, res) => {
  const routes = polling.cache.getRoutes();
  const redisStatus = polling.redis?.status ?? "disabled";
  const redisError = polling.redis?.error ? polling.redis?.error.message : null;
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mbtaApiBaseUrl: config.mbtaApiBaseUrl,
    cachedRoutes: routes ? routes.data.length : 0,
    cacheHealth: polling.cache.getHealth(),
    mbtaTelemetry: getMbtaClientTelemetry(),
    redis: {
      status: redisStatus,
      error: redisError,
      healthy: redisStatus === "ready" && !redisError,
    },
  });
});

app.get("/api/lines", (req, res) => {
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const modeFilter = modeParam && isMode(modeParam) ? modeParam : undefined;
  const summary = buildLineSummaries(polling.cache, { mode: modeFilter });
  res.json(summary);
});

app.get("/api/lines/:lineId/overview", (req, res) => {
  const overview = buildLineOverview(polling.cache, req.params.lineId);
  if (!overview) {
    return res.status(404).json({
      error: "Line not found or data not ready",
    });
  }
  return res.json({ line: overview });
});

app.get("/api/raw/routes", (_req, res) => {
  const routes = polling.cache.getRoutes();
  res.json({
    routes: routes?.data ?? [],
    fetchedAt: routes?.fetchedAt ?? null,
  });
});

app.get("/api/stations/:stopId/board", async (req, res) => {
  try {
    const latParam = parseNumberParam(req.query.lat);
    const lngParam = parseNumberParam(req.query.lng);
    const locationParams: { lat?: number; lng?: number } = {};
    if (latParam !== undefined) locationParams.lat = latParam;
    if (lngParam !== undefined) locationParams.lng = lngParam;
    const board = await buildStationBoardV2(polling.cache, polling.client, req.params.stopId, locationParams);
    if (!board) {
      return res.status(404).json({ error: "not_found", message: "Station data unavailable" });
    }
    return res.json(board);
  } catch (error) {
    logger.error("Failed to build station board", { stopId: req.params.stopId, message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to build station board" });
  }
});

app.get("/api/trips/:tripId/track", async (req, res) => {
  try {
    const trip = await buildTripTrack(polling.client, polling.cache, req.params.tripId);
    if (!trip) {
      return res.status(404).json({ error: "not_found", message: "Trip data unavailable" });
    }
    return res.json(trip);
  } catch (error) {
    logger.error("Failed to build trip track", { tripId: req.params.tripId, message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to build trip track" });
  }
});

app.get("/api/system/insights", (_req, res) => {
  const insights = buildSystemInsights(polling.cache);
  res.json({ insights });
});

app.get("/api/stations", (req, res) => {
  const limit = Math.max(1, Math.min(1200, Number(req.query.limit) || 900));
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const modeFilter = modeParam && isMode(modeParam) ? modeParam : undefined;
  const stations = buildStationSummaries(polling.cache, { limit, mode: modeFilter });
  res.json({ stations });
});

app.get("/api/vehicles", (req, res) => {
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const modeFilter = modeParam && isMode(modeParam) ? modeParam : undefined;
  const snapshots = buildVehicleSnapshots(polling.cache, { mode: modeFilter });
  res.json(snapshots);
});

app.get("/api/lines/:lineId/shapes", async (req, res) => {
  try {
    const payload = await buildLineShapes(polling.cache, polling.client, req.params.lineId);
    if (!payload) {
      return res.status(404).json({ error: "shapes_unavailable", message: "Line shapes not available" });
    }
    return res.json(payload);
  } catch (error) {
    logger.error("Failed to fetch line shapes", { lineId: req.params.lineId, message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to fetch line shapes" });
  }
});

app.get("/api/routes/:routeId/shapes", async (req, res) => {
  try {
    const payload = await buildLineShapes(polling.cache, polling.client, req.params.routeId);
    if (!payload) {
      return res.status(404).json({ error: "shapes_unavailable", message: "Route shapes not available" });
    }
    return res.json(payload);
  } catch (error) {
    logger.error("Failed to fetch route shapes", { routeId: req.params.routeId, message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to fetch route shapes" });
  }
});

const normalizeStopQuery = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
};

if (config.enableDiagnostics) {
  app.get("/api/dev/reports/eta", async (req, res) => {
    const stopIds = normalizeStopQuery(req.query.stopId);
    if (stopIds.length === 0) {
      return res.status(400).json({ error: "missing_stop", message: "Provide at least one stopId query param" });
    }
    const stopsEntry = polling.cache.getStops();
    if (!stopsEntry) {
      return res.status(503).json({ error: "stops_unavailable", message: "Stops cache is not ready yet" });
    }

    try {
      const stopLookup = new Map(stopsEntry.data.map((stop) => [stop.id, stop]));
      const report = await generateEtaReport(polling.client, {
        stopIds,
        stopLookup,
      });
      return res.json(report);
    } catch (error) {
      logger.error("Diagnostics ETA report failed", { message: String(error) });
      return res.status(500).json({ error: "report_failed", message: String(error) });
    }
  });

  app.get("/api/dev/reports/stations", (req, res) => {
    const stopsEntry = polling.cache.getStops();
    if (!stopsEntry) {
      return res.status(503).json({ error: "stops_unavailable", message: "Stops cache is not ready yet" });
    }
    const stopIds = (() => {
      const normalized = normalizeStopQuery(req.query.stopId);
      return normalized.length > 0 ? normalized : undefined;
    })();
    const stationOptions: StationMappingOptions = {};
    if (stopIds) {
      stationOptions.stopIds = stopIds;
    }
    const report = buildStationMappingReport(stopsEntry.data, stationOptions);
    return res.json(report);
  });
}

const server = app.listen(config.port, () => {
  logger.info(`Backend server listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  logger.info("Shutting down server...");
  polling.jobs.forEach((job) => {
    if (job.timer) clearInterval(job.timer);
  });
  if (polling.redis) {
    void polling.redis.disconnect();
  }
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
