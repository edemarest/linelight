// LineLight API entrypoint: wires routes, shared helpers, and polling-backed caches.
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { Pool } from "pg";
import { buildPgSslConfig } from "./utils/dbSsl";
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
import { buildTripPlan } from "./services/tripPlanner";
import { logger } from "./utils/logger";
import { validateTripPlannerResponse } from "@linelight/core";
import { ensureArray } from "./utils/collections";
import { getDonationBoardRecent, getDonationBoardSummary, getDonationBoardTop } from "./db";
import {
  constructStripeEvent,
  createDonationCheckout,
  getDonationConfig,
  handleStripeWebhookEvent,
} from "./services/donations";

const GEOCODE_CACHE_TTL_MS = 5 * 60_000;
const GEOCODE_MAX_RESULTS = 8;
const GEOCODE_RADIUS_KM = 25;
const DEFAULT_VIEWBOX = "-73.7,43.9,-69.7,41.0";
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org";
const PHOTON_BASE_URL = process.env.PHOTON_BASE_URL ?? "https://photon.komoot.io";
const CENSUS_BASE_URL = process.env.CENSUS_BASE_URL ?? "https://geocoding.geo.census.gov";
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL;
const CARTO_STYLE_BASE_URL = "https://basemaps.cartocdn.com/gl";
const CARTO_TILE_BASE_URL = "https://tiles.basemaps.cartocdn.com";
const CARTO_STYLE_IDS = new Set(["dark-matter-gl-style", "positron-gl-style"]);
const CARTO_ALLOWED_PREFIXES = [CARTO_STYLE_BASE_URL, CARTO_TILE_BASE_URL];
const CARTO_CACHE_MAX_ENTRIES = 300;
const CARTO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const CARTO_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const geocodeCache = new Map<string, { timestamp: number; results: Array<{ id: string; label: string; lat: number; lon: number }> }>();
const reverseGeocodeCache = new Map<string, { timestamp: number; label: string; lat: number; lon: number }>();

const app = express();
app.set("trust proxy", true);

app.use(cors());
app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  res.locals.requestId = requestId;
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (req.originalUrl === "/api/health") return;
    const meta = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
    };
    if (res.statusCode >= 500) {
      logger.error("HTTP request failed", meta);
    } else if (res.statusCode >= 400) {
      logger.warn("HTTP request completed with client error", meta);
    } else {
      logger.debug("HTTP request completed", meta);
    }
  });
  next();
});
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["stripe-signature"];
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Invalid webhook payload" });
      return;
    }
    const event = constructStripeEvent(req.body, Array.isArray(signature) ? signature[0] : signature);
    await handleStripeWebhookEvent(event);
    res.status(200).json({ received: true });
  } catch (error) {
    logger.warn("Stripe webhook failed", { message: String(error) });
    res.status(400).json({ error: "Webhook error" });
  }
});
app.use(express.json());

const polling = initializePolling();

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "linelight-backend", timestamp: new Date().toISOString() });
});

app.get("/api/donations/config", (_req, res) => {
  res.json(getDonationConfig());
});

app.post("/api/donations/checkout", async (req, res) => {
  try {
    const amountRaw = req.body?.amount;
    const amount = typeof amountRaw === "string" ? Number(amountRaw) : amountRaw;
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const email = typeof req.body?.email === "string" ? req.body.email : undefined;
    const origin = (req.headers.origin as string | undefined) ?? process.env.SITE_URL ?? "http://localhost:3000";
    const result = await createDonationCheckout({
      amount,
      name,
      email,
      successUrl: origin,
      cancelUrl: origin,
      requestId: res.locals.requestId,
    });
    res.status(200).json(result);
  } catch (error) {
    logger.warn("Donation checkout failed", { message: String(error) });
    res.status(400).json({ error: "Donation checkout failed" });
  }
});

app.get("/api/donations/board", async (req, res) => {
  try {
    const rawLimit = parseNumberParam(req.query.limit) ?? 18;
    const limit = Math.max(3, Math.min(50, rawLimit));
    const onlyLive = process.env.NODE_ENV === "production";
    const [top, recent, summary] = await Promise.all([
      getDonationBoardTop(limit, onlyLive),
      getDonationBoardRecent(limit, onlyLive),
      getDonationBoardSummary(onlyLive),
    ]);
    const sanitizeName = (value: string | null) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed.slice(0, 64) : "Anon";
    };
    const formatEntry = (entry: { amountCents: number; currency: string; donorName: string | null; createdAt: string }) => {
      const amountCents = Number(entry.amountCents);
      if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
      return {
        amount: amountCents / 100,
        amountCents,
        currency: entry.currency ?? "usd",
        name: sanitizeName(entry.donorName),
        createdAt: entry.createdAt,
      };
    };
    const normalizeList = (entries: typeof top) =>
      entries
        .map(formatEntry)
        .filter((entry): entry is NonNullable<ReturnType<typeof formatEntry>> => Boolean(entry));

    res.json({
      top: normalizeList(top),
      recent: normalizeList(recent),
      summary,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn("Donation board fetch failed", { message: String(error) });
    res.status(500).json({ error: "Donation board unavailable" });
  }
});

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

const buildViewbox = (lat: number, lon: number): string => {
  const latDelta = GEOCODE_RADIUS_KM / 111;
  const lonDelta = GEOCODE_RADIUS_KM / (111 * Math.max(0.3, Math.cos((lat * Math.PI) / 180)));
  const minLon = lon - lonDelta;
  const maxLon = lon + lonDelta;
  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;
  return `${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)},${minLat.toFixed(5)}`;
};

const parseViewbox = (viewbox: string): { minLon: number; maxLat: number; maxLon: number; minLat: number } | null => {
  const parts = viewbox.split(",").map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [minLon, maxLat, maxLon, minLat] = parts as [number, number, number, number];
  return { minLon, maxLat, maxLon, minLat };
};

const DEFAULT_BOUNDS = parseViewbox(DEFAULT_VIEWBOX);

const isWithinBounds = (lat: number, lon: number, bounds: { minLon: number; maxLat: number; maxLon: number; minLat: number }) =>
  lat <= bounds.maxLat && lat >= bounds.minLat && lon >= bounds.minLon && lon <= bounds.maxLon;

const encodeProxyUrl = (targetUrl: string) =>
  encodeURIComponent(targetUrl).replace(/%7B/g, "{").replace(/%7D/g, "}");

const buildCartoProxyUrl = (targetUrl: string, baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, "")}/api/map/carto/proxy?url=${encodeProxyUrl(targetUrl)}`;

const rewriteCartoStyle = (style: {
  sprite?: string;
  glyphs?: string;
  sources?: Record<string, { url?: string; tiles?: string[] }>;
}, baseUrl: string) => {
  const next = { ...style };
  if (next.sprite) {
    next.sprite = buildCartoProxyUrl(next.sprite, baseUrl);
  }
  if (next.glyphs) {
    next.glyphs = buildCartoProxyUrl(next.glyphs, baseUrl);
  }
  if (next.sources) {
    const rewritten: Record<string, { url?: string; tiles?: string[] }> = {};
    Object.entries(next.sources).forEach(([key, source]) => {
      const updated = { ...source };
      if (updated.url && CARTO_ALLOWED_PREFIXES.some((prefix) => updated.url?.startsWith(prefix))) {
        updated.url = buildCartoProxyUrl(updated.url, baseUrl);
      }
      if (updated.tiles) {
        updated.tiles = updated.tiles.map((tile) =>
          CARTO_ALLOWED_PREFIXES.some((prefix) => tile.startsWith(prefix)) ? buildCartoProxyUrl(tile, baseUrl) : tile,
        );
      }
      rewritten[key] = updated;
    });
    next.sources = rewritten;
  }
  return next;
};

type CartoCacheEntry = {
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  size: number;
};

class LruCache {
  private map = new Map<string, CartoCacheEntry>();
  private totalBytes = 0;

  constructor(private maxEntries: number, private maxBytes: number) {}

  get(key: string): CartoCacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, value: CartoCacheEntry): void {
    if (this.map.has(key)) {
      const existing = this.map.get(key);
      if (existing) {
        this.totalBytes -= existing.size;
      }
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.totalBytes += value.size;

    while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.map.get(oldestKey);
      if (oldest) {
        this.totalBytes -= oldest.size;
      }
      this.map.delete(oldestKey);
    }
  }
}

const cartoProxyCache = new LruCache(CARTO_CACHE_MAX_ENTRIES, CARTO_CACHE_MAX_BYTES);

const clampViewbox = (
  input: { minLon: number; maxLat: number; maxLon: number; minLat: number },
  bounds: { minLon: number; maxLat: number; maxLon: number; minLat: number },
): { minLon: number; maxLat: number; maxLon: number; minLat: number } | null => {
  const minLon = Math.max(input.minLon, bounds.minLon);
  const maxLon = Math.min(input.maxLon, bounds.maxLon);
  const minLat = Math.max(input.minLat, bounds.minLat);
  const maxLat = Math.min(input.maxLat, bounds.maxLat);
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return { minLon, maxLat, maxLon, minLat };
};

app.get("/api/home", async (req, res) => {
  const lat = parseNumberParam(req.query.lat);
  const lng = parseNumberParam(req.query.lng);
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "bad_request", message: "lat and lng are required" });
  }
  const radius = Math.min(50000, Math.max(100, parseNumberParam(req.query.radius) ?? 1200));
  const limit = Math.min(100, Math.max(1, parseNumberParam(req.query.limit) ?? 10));
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

app.get("/api/geocode", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) {
    return res.status(400).json({ error: "bad_request", message: "q is required" });
  }
  const centerLat = parseNumberParam(req.query.centerLat);
  const centerLon = parseNumberParam(req.query.centerLon);
  const minLat = parseNumberParam(req.query.minLat);
  const maxLat = parseNumberParam(req.query.maxLat);
  const minLon = parseNumberParam(req.query.minLon);
  const maxLon = parseNumberParam(req.query.maxLon);
  const limitParam = parseNumberParam(req.query.limit);
  const limit = Math.min(Math.max(1, limitParam ?? GEOCODE_MAX_RESULTS), 10);
  let viewbox = DEFAULT_VIEWBOX;
  if (minLat !== undefined && maxLat !== undefined && minLon !== undefined && maxLon !== undefined) {
    const candidate = { minLon, maxLat, maxLon, minLat };
    const clamped = DEFAULT_BOUNDS ? clampViewbox(candidate, DEFAULT_BOUNDS) : candidate;
    if (clamped) {
      viewbox = `${clamped.minLon.toFixed(5)},${clamped.maxLat.toFixed(5)},${clamped.maxLon.toFixed(5)},${clamped.minLat.toFixed(5)}`;
    }
  } else if (centerLat !== undefined && centerLon !== undefined) {
    const candidate = parseViewbox(buildViewbox(centerLat, centerLon));
    const clamped = candidate && DEFAULT_BOUNDS ? clampViewbox(candidate, DEFAULT_BOUNDS) : candidate;
    if (clamped) {
      viewbox = `${clamped.minLon.toFixed(5)},${clamped.maxLat.toFixed(5)},${clamped.maxLon.toFixed(5)},${clamped.minLat.toFixed(5)}`;
    }
  }
  const cacheKey = `${query.toLowerCase()}|${viewbox}|${limit}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GEOCODE_CACHE_TTL_MS) {
    return res.json({ results: cached.results });
  }

  const fetchNominatim = async (options: { bounded: boolean; viewbox?: string; timeoutMs: number; limitOverride?: number }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const requestLimit = options.limitOverride ?? limit;
      const url = new URL("/search", NOMINATIM_BASE_URL);
      url.searchParams.set("format", "json");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("countrycodes", "us");
      url.searchParams.set("limit", String(requestLimit));
      url.searchParams.set("q", query);
      if (options.bounded && options.viewbox) {
        url.searchParams.set("bounded", "1");
        url.searchParams.set("viewbox", options.viewbox);
      }
      if (NOMINATIM_EMAIL) {
        url.searchParams.set("email", NOMINATIM_EMAIL);
      }

      const response = await fetch(url.toString(), {
        headers: {
          "Accept-Language": "en-US",
          "User-Agent": "LineLight/1.0 (+https://linelight.app)",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn("Geocode request failed", { status: response.status, query, bounded: options.bounded });
        return null;
      }

      const payload = (await response.json()) as Array<{ place_id: number; display_name: string; lat: string; lon: string }>;
      const results = payload
        .map((entry) => ({
          id: String(entry.place_id),
          label: entry.display_name,
          lat: Number(entry.lat),
          lon: Number(entry.lon),
        }))
        .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon))
        .filter((entry) => (DEFAULT_BOUNDS ? isWithinBounds(entry.lat, entry.lon, DEFAULT_BOUNDS) : true));
      return results.slice(0, limit);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        logger.warn("Geocode request failed", { message: String(error), bounded: options.bounded });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const fetchPhoton = async (options: { bounded: boolean; viewbox?: string; timeoutMs: number; limitOverride?: number }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const requestLimit = options.limitOverride ?? limit;
      const url = new URL("/api", PHOTON_BASE_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(requestLimit));
      if (centerLat !== undefined && centerLon !== undefined) {
        url.searchParams.set("lat", String(centerLat));
        url.searchParams.set("lon", String(centerLon));
      }
      if (options.bounded && options.viewbox) {
        const bounds = parseViewbox(options.viewbox);
        if (bounds) {
          url.searchParams.set("bbox", `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`);
        }
      }
      const response = await fetch(url.toString(), {
        headers: {
          "Accept-Language": "en-US",
          "User-Agent": "LineLight/1.0 (+https://linelight.app)",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn("Photon request failed", { status: response.status, query, bounded: options.bounded });
        return null;
      }
      const payload = (await response.json()) as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: { name?: string; housenumber?: string; street?: string; city?: string; state?: string; country?: string };
        }>;
      };
      const features = payload.features ?? [];
      const results = features
        .map((feature, index) => {
          const coords = feature.geometry?.coordinates;
          if (!coords || coords.length < 2) return null;
          const [lon, lat] = coords;
          const props = feature.properties ?? {};
          const label = [props.name, props.housenumber, props.street, props.city, props.state, props.country]
            .filter(Boolean)
            .join(" ");
          return {
            id: `photon-${index}`,
            label: label || `${lat}, ${lon}`,
            lat,
            lon,
          };
        })
        .filter((entry): entry is { id: string; label: string; lat: number; lon: number } => !!entry && Number.isFinite(entry.lat))
        .filter((entry) => (DEFAULT_BOUNDS ? isWithinBounds(entry.lat, entry.lon, DEFAULT_BOUNDS) : true));
      return results.slice(0, limit);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        logger.warn("Photon request failed", { message: String(error), bounded: options.bounded });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const fetchCensus = async (options: { timeoutMs: number; limitOverride?: number }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const requestLimit = options.limitOverride ?? limit;
      const url = new URL("/geocoder/locations/onelineaddress", CENSUS_BASE_URL);
      url.searchParams.set("address", query);
      url.searchParams.set("benchmark", "Public_AR_Census2020");
      url.searchParams.set("format", "json");
      const response = await fetch(url.toString(), {
        headers: {
          "Accept-Language": "en-US",
          "User-Agent": "LineLight/1.0 (+https://linelight.app)",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn("Census geocode request failed", { status: response.status, query });
        return null;
      }
      const payload = (await response.json()) as {
        result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x?: number; y?: number } }> };
      };
      const matches = payload.result?.addressMatches ?? [];
      const results = matches
        .map((entry, index) => {
          const lon = entry.coordinates?.x;
          const lat = entry.coordinates?.y;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return {
            id: `census-${index}`,
            label: entry.matchedAddress ?? `${lat}, ${lon}`,
            lat: Number(lat),
            lon: Number(lon),
          };
        })
        .filter((entry): entry is { id: string; label: string; lat: number; lon: number } => !!entry)
        .filter((entry) => (DEFAULT_BOUNDS ? isWithinBounds(entry.lat, entry.lon, DEFAULT_BOUNDS) : true));
      return results.slice(0, requestLimit);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        logger.warn("Census geocode request failed", { message: String(error) });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const boundedResults = await fetchNominatim({ bounded: true, viewbox, timeoutMs: 1500 });
  if (boundedResults && boundedResults.length > 0) {
    geocodeCache.set(cacheKey, { timestamp: Date.now(), results: boundedResults });
    return res.json({ results: boundedResults });
  }

  const expandedLimit = DEFAULT_BOUNDS ? Math.max(limit, 25) : limit;
  const unboundedResults = await fetchNominatim({ bounded: false, timeoutMs: 1500, limitOverride: expandedLimit });
  if (unboundedResults && unboundedResults.length > 0) {
    geocodeCache.set(cacheKey, { timestamp: Date.now(), results: unboundedResults });
    return res.json({ results: unboundedResults });
  }

  const photonResults =
    (await fetchPhoton({ bounded: true, viewbox, timeoutMs: 2000 })) ??
    (await fetchPhoton({ bounded: false, timeoutMs: 2000, limitOverride: expandedLimit }));
  if (photonResults && photonResults.length > 0) {
    geocodeCache.set(cacheKey, { timestamp: Date.now(), results: photonResults });
    return res.json({ results: photonResults });
  }

  const censusResults = await fetchCensus({ timeoutMs: 2000, limitOverride: expandedLimit });
  if (censusResults && censusResults.length > 0) {
    geocodeCache.set(cacheKey, { timestamp: Date.now(), results: censusResults });
    return res.json({ results: censusResults });
  }

  logger.debug("Geocode returned no matches", { query, viewbox });
  return res.json({ results: [] });
});

app.get("/api/reverse-geocode", async (req, res) => {
  const lat = parseNumberParam(req.query.lat);
  const lon = parseNumberParam(req.query.lon);
  if (lat === undefined || lon === undefined) {
    return res.status(400).json({ error: "bad_request", message: "lat and lon are required" });
  }
  const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GEOCODE_CACHE_TTL_MS) {
    return res.json({ label: cached.label, lat: cached.lat, lon: cached.lon });
  }

  try {
    const url = new URL("/reverse", NOMINATIM_BASE_URL);
    url.searchParams.set("format", "json");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    if (NOMINATIM_EMAIL) {
      url.searchParams.set("email", NOMINATIM_EMAIL);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Accept-Language": "en-US",
        "User-Agent": "LineLight/1.0 (+https://linelight.app)",
      },
    });
    if (!response.ok) {
      logger.warn("Reverse geocode request failed", { status: response.status });
      throw new Error("reverse_geocode_failed");
    }

    const payload = (await response.json()) as { display_name?: string; lat?: string; lon?: string };
    const label = payload.display_name ?? `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const result = { label, lat, lon };
    reverseGeocodeCache.set(cacheKey, { timestamp: Date.now(), ...result });
    return res.json(result);
  } catch (error) {
    logger.warn("Reverse geocode request failed", { message: String(error) });
    try {
      const url = new URL("/reverse", PHOTON_BASE_URL);
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      const response = await fetch(url.toString(), {
        headers: {
          "Accept-Language": "en-US",
          "User-Agent": "LineLight/1.0 (+https://linelight.app)",
        },
      });
      if (!response.ok) {
        return res.status(502).json({ error: "geocode_failed", message: "Geocode provider unavailable" });
      }
      const payload = (await response.json()) as {
        features?: Array<{ properties?: { name?: string; street?: string; city?: string; state?: string; country?: string } }>;
      };
      const first = payload.features?.[0]?.properties;
      const label = [first?.name, first?.street, first?.city, first?.state, first?.country].filter(Boolean).join(", ");
      const result = { label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
      reverseGeocodeCache.set(cacheKey, { timestamp: Date.now(), ...result });
      return res.json(result);
    } catch (fallbackError) {
      logger.error("Reverse geocode request failed", { message: String(fallbackError) });
      return res.status(502).json({ error: "geocode_failed", message: "Geocode provider unavailable" });
    }
  }
});

app.get("/api/map/carto/style/:styleId", async (req, res) => {
  const styleId = req.params.styleId;
  if (!CARTO_STYLE_IDS.has(styleId)) {
    return res.status(404).json({ error: "not_found", message: "Unknown map style" });
  }
  try {
    const url = `${CARTO_STYLE_BASE_URL}/${styleId}/style.json`;
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en-US",
        "User-Agent": "LineLight/1.0 (+https://linelight.app)",
      },
    });
    if (!response.ok) {
      return res.status(502).json({ error: "map_style_failed", message: "Map style provider unavailable" });
    }
    const payload = (await response.json()) as {
      sprite?: string;
      glyphs?: string;
      sources?: Record<string, { url?: string; tiles?: string[] }>;
    };
    const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
    const host = req.get("host") ?? "";
    const isLocalHost = host.includes("localhost") || host.startsWith("127.0.0.1");
    const preferredProtocol = forwardedProto || req.protocol;
    const baseProtocol = !isLocalHost && preferredProtocol === "http" ? "https" : preferredProtocol;
    const baseUrl = `${baseProtocol}://${host}`;
    const rewritten = rewriteCartoStyle(payload, baseUrl);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.json(rewritten);
  } catch (error) {
    logger.warn("Map style request failed", { message: String(error) });
    return res.status(502).json({ error: "map_style_failed", message: "Map style provider unavailable" });
  }
});

const handleCartoProxy = async (req: Request, res: Response) => {
  const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!targetUrl) {
    return res.status(400).json({ error: "bad_request", message: "url is required" });
  }
  const spriteSuffixMatch = req.path.match(/proxy(?:@2x)?\.(json|png)$/);
  const spriteSuffix = spriteSuffixMatch
    ? `${req.path.includes("@2x") ? "@2x" : ""}.${spriteSuffixMatch[1]}`
    : "";
  const resolvedTargetUrl = spriteSuffix && !targetUrl.endsWith(spriteSuffix) ? `${targetUrl}${spriteSuffix}` : targetUrl;
  if (!CARTO_ALLOWED_PREFIXES.some((prefix) => resolvedTargetUrl.startsWith(prefix))) {
    return res.status(400).json({ error: "bad_request", message: "url is not allowed" });
  }
  const isCacheableResource = /\/fonts\//.test(resolvedTargetUrl) || /\/sprite/.test(resolvedTargetUrl) || /\/tiles\//.test(resolvedTargetUrl);
  if (isCacheableResource) {
    const cached = cartoProxyCache.get(resolvedTargetUrl);
    if (cached) {
      res.status(cached.status);
      Object.entries(cached.headers).forEach(([key, value]) => res.setHeader(key, value));
      return res.send(cached.buffer);
    }
  }
  try {
    const normalizedTargetUrl = encodeURI(resolvedTargetUrl);
    const response = await fetch(normalizedTargetUrl, {
      headers: {
        "Accept-Language": "en-US",
        "User-Agent": "LineLight/1.0 (+https://linelight.app)",
      },
    });
    res.status(response.status);
    const passthroughHeaders = ["content-type", "cache-control", "etag", "last-modified"];
    response.headers.forEach((value, key) => {
      if (passthroughHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    if (/\/fonts\//.test(resolvedTargetUrl) || /\/sprite/.test(resolvedTargetUrl)) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (
      isCacheableResource &&
      response.ok &&
      buffer.length <= CARTO_CACHE_MAX_ENTRY_BYTES
    ) {
      const cachedHeaders: Record<string, string> = {};
      const headerKeys = ["content-type", "cache-control", "etag", "last-modified"];
      headerKeys.forEach((key) => {
        const value = res.getHeader(key);
        if (typeof value === "string") {
          cachedHeaders[key] = value;
        }
      });
      cartoProxyCache.set(resolvedTargetUrl, {
        status: response.status,
        headers: cachedHeaders,
        buffer,
        size: buffer.length,
      });
    }
    return res.send(buffer);
  } catch (error) {
    logger.warn("Map tile proxy failed", { message: String(error) });
    return res.status(502).json({ error: "map_tile_failed", message: "Map tile provider unavailable" });
  }
};

app.get("/api/map/carto/proxy", handleCartoProxy);
app.get("/api/map/carto/proxy/", handleCartoProxy);
app.get(/^\/api\/map\/carto\/proxy(?:@2x)?\.(?:json|png)$/, handleCartoProxy);

app.get("/api/health", (_req, res) => {
  const routes = polling.cache.getRoutes();
  const redisStatus = polling.redis?.status ?? "disabled";
  const redisError = polling.redis?.error ? polling.redis?.error.message : null;
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mbtaApiBaseUrl: config.mbtaApiBaseUrl,
    mbtaApiKeyConfigured: Boolean(config.mbtaApiKey),
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
    const includeAlerts = req.query.includeAlerts !== "false";
    const includeFacilities = req.query.includeFacilities !== "false";
    const locationParams: { lat?: number; lng?: number } = {};
    if (latParam !== undefined) locationParams.lat = latParam;
    if (lngParam !== undefined) locationParams.lng = lngParam;
    const board = await buildStationBoardV2(polling.cache, polling.client, req.params.stopId, locationParams, {
      includeAlerts,
      includeFacilities,
    });
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

app.get("/api/trip-planner", async (req, res) => {
  const originLat = parseNumberParam(req.query.originLat);
  const originLon = parseNumberParam(req.query.originLon);
  const destLat = parseNumberParam(req.query.destLat);
  const destLon = parseNumberParam(req.query.destLon);

  if (
    originLat === undefined ||
    originLon === undefined ||
    destLat === undefined ||
    destLon === undefined
  ) {
    return res.status(400).json({ error: "invalid_request", message: "origin/destination coordinates required" });
  }

  const modes = parseStringList(req.query.modes);
  const maxWalkMinutes = parseNumberParam(req.query.maxWalkMinutes);
  const maxTransfers = parseNumberParam(req.query.maxTransfers);
  const departAt = typeof req.query.departAt === "string" ? req.query.departAt : undefined;

  try {
    const requestParams: Record<string, unknown> = {
      originLat,
      originLon,
      destLat,
      destLon,
    };

    if (departAt) requestParams.departAt = departAt;
    if (modes.length) requestParams.modes = modes;
    if (maxWalkMinutes !== undefined) requestParams.maxWalkMinutes = maxWalkMinutes;
    if (maxTransfers !== undefined) requestParams.maxTransfers = maxTransfers;

    const plan = await buildTripPlan(polling.client, polling.cache, requestParams as any);

    if (!plan) {
      return res.status(404).json({ error: "no_route", message: "No valid path found within constraints." });
    }

    const validation = validateTripPlannerResponse(plan);
    if (!validation.ok) {
      logger.error("Trip planner response failed validation", { errors: validation.errors });
      return res.status(500).json({ error: "internal_error", message: "Trip planner response invalid" });
    }

    return res.json(plan);
  } catch (error) {
    logger.error("Failed to build trip plan", { message: String(error) });
    return res.status(500).json({ error: "internal_error", message: "Unable to build trip plan" });
  }
});

app.get("/api/system/insights", (_req, res) => {
  const insights = buildSystemInsights(polling.cache);
  res.json({ insights });
});

app.get("/api/stations", async (req, res) => {
  const limit = Math.max(1, Math.min(1200, Number(req.query.limit) || 900));
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const modeFilter = modeParam && isMode(modeParam) ? modeParam : undefined;
  try {
    const stations = await buildStationSummaries(polling.cache, { limit, mode: modeFilter });
    res.json({ stations });
  } catch (error) {
    logger.error("Failed to build station summaries", { message: String(error) });
    res.status(500).json({ error: "internal_error", message: "Unable to load station summaries" });
  }
});

app.get("/api/stops/lookup", async (req, res) => {
  const ids = parseStringList(req.query.ids).slice(0, 200);

  const stopsEntry = polling.cache.getStops();
  if (!stopsEntry) {
    return res.json({ ready: false, stops: [] });
  }

  const stopLookup = new Map(stopsEntry.data.map((stop) => [stop.id, stop]));
  const missingIds = ids.filter((id) => !stopLookup.has(id));

  if (missingIds.length > 0) {
    const chunkSize = 80;
    for (let start = 0; start < missingIds.length; start += chunkSize) {
      const batch = missingIds.slice(start, start + chunkSize);
      try {
        const response = await polling.client.getStops({
          "filter[id]": batch.join(","),
          "page[limit]": Math.max(50, batch.length),
          include: "parent_station",
        });
        const fetched = [
          ...ensureArray(response.data),
          ...ensureArray(response.included).filter((resource) => resource.type === "stop"),
        ];
        fetched.forEach((stop) => {
          stopLookup.set((stop as any).id, stop as any);
        });
      } catch (error) {
        logger.warn("Stop lookup failed to fetch missing stops from MBTA", { message: String(error) });
      }
    }
  }

  const stops = ids
    .map((id) => stopLookup.get(id))
    .filter(Boolean)
    .map((stop) => ({
      stopId: stop!.id,
      name: stop!.attributes.name,
      latitude: stop!.attributes.latitude,
      longitude: stop!.attributes.longitude,
    }));

  return res.json({ ready: true, stops });
});

app.get("/api/vehicles", (req, res) => {
  const modeParam = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const modeFilter = modeParam && isMode(modeParam) ? modeParam : undefined;
  const snapshots = buildVehicleSnapshots(polling.cache, { mode: modeFilter });
  res.json(snapshots);
});

app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = res.locals.requestId ?? randomUUID();
  logger.error("Unhandled error during request", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    message: error.message,
    stack: error.stack,
  });
  if (res.headersSent) {
    return;
  }
  res.status(500).json({
    error: "internal_error",
    message: "Unexpected server error",
    requestId,
  });
});

const handleShapesRequest = async (
  res: Response,
  id: string,
  kind: "line" | "route",
) => {
  try {
    const payload = await buildLineShapes(polling.cache, polling.client, id);
    if (!payload) {
      return res.status(404).json({
        error: "shapes_unavailable",
        message: kind === "line" ? "Line shapes not available" : "Route shapes not available",
      });
    }
    logger.debug("Returning shapes payload", { [`${kind}Id`]: id, shapes: payload.shapes.length });
    return res.json(payload);
  } catch (error) {
    logger.error("Failed to fetch shapes", { [`${kind}Id`]: id, message: String(error) });
    return res.status(500).json({
      error: "internal_error",
      message: kind === "line" ? "Unable to fetch line shapes" : "Unable to fetch route shapes",
    });
  }
};

app.get("/api/lines/:lineId/shapes", (req, res) => handleShapesRequest(res, req.params.lineId, "line"));

app.get("/api/routes/:routeId/shapes", (req, res) => handleShapesRequest(res, req.params.routeId, "route"));

if (config.enableDiagnostics) {
  app.get("/api/dev/reports/eta", async (req, res) => {
    const stopIds = parseStringList(req.query.stopId);
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
      const normalized = parseStringList(req.query.stopId);
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

const waitForDatabase = async () => {
  if (process.env.SKIP_DB_CHECK === "true") {
    logger.warn("SKIP_DB_CHECK enabled; skipping database readiness check.");
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set; skipping database readiness check.");
    return;
  }

  const sslConfig = buildPgSslConfig(databaseUrl);

  const maxAttempts = 10;
  const delayMs = 1500;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const pool = new Pool({ connectionString: databaseUrl, ssl: sslConfig });
      await pool.query("select 1");
      await pool.end();
      logger.info("Database connection ready.");
      return;
    } catch (error) {
      logger.warn("Database not ready yet", { attempt, maxAttempts, message: String(error) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  logger.error("Database readiness check failed; continuing without DB.");
};

let server: ReturnType<typeof app.listen> | null = null;

const startServer = async () => {
  await waitForDatabase();
  server = app.listen(config.port, () => {
    logger.info(`Backend server listening on http://localhost:${config.port}`);
  });
};

const shutdown = () => {
  logger.info("Shutting down server...");
  polling.jobs.forEach((job) => {
    if (job.timer) clearInterval(job.timer);
  });
  if (polling.redis) {
    void polling.redis.disconnect();
  }
  if (server) {
    server.close(() => {
      process.exit(0);
    });
    return;
  }
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

startServer().catch((error) => {
  logger.error("Failed to start backend server", { message: String(error) });
  process.exit(1);
});
