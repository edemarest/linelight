// Frontend API wrapper that targets the configured backend base URL.
import { envConfig } from "@/lib/config";
import type { ModeFilter } from "@/lib/modes";
import {
  fetchHome as coreFetchHome,
  fetchStationBoard as coreFetchStationBoard,
  fetchTripTrack as coreFetchTripTrack,
  fetchLines as coreFetchLines,
  fetchLineOverview as coreFetchLineOverview,
  fetchSystemInsights as coreFetchSystemInsights,
  fetchLineShapes as coreFetchLineShapes,
  type HomeResponse,
  type GetStationBoardResponse,
  type TripTrackResponse,
  type LineSummary,
  type LineOverview,
  type SystemInsights,
  type LineShapeResponse,
  type TripPlannerRequest,
  type TripPlannerResponse,
  validateTripPlannerResponse,
} from "@linelight/core";

const API_BASE_URL = envConfig.apiBaseUrl;
const HOME_COORD_PRECISION = 0.01;
const HOME_RADIUS_INCREMENT = 250;

const buildUrl = (path: string): string => {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
};

const quantizeCoordinate = (value: number) =>
  Number((Math.round(value / HOME_COORD_PRECISION) * HOME_COORD_PRECISION).toFixed(4));

const quantizeRadius = (meters: number) =>
  Math.max(HOME_RADIUS_INCREMENT, Math.round(meters / HOME_RADIUS_INCREMENT) * HOME_RADIUS_INCREMENT);

export interface HealthResponse {
  status: string;
  timestamp: string;
  mbtaApiBaseUrl?: string;
}

export interface StationPlatformMarker {
  stopId: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface StationSummary {
  stopId: string;
  name: string;
  latitude: number;
  longitude: number;
  routesServing: string[];
  modesServed: ModeFilter[];
  platformStopIds: string[];
  platformMarkers: StationPlatformMarker[];
}

export interface VehicleSnapshot {
  vehicleId: string;
  routeId: string | null;
  lineId: string | null;
  mode: ModeFilter;
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  updatedAt: string;
}

const buildModeQuery = (mode?: ModeFilter) => {
  if (!mode || mode === "all") return "";
  return `mode=${encodeURIComponent(mode)}`;
};

export const fetchHealth = async (): Promise<HealthResponse> => {
  const response = await fetch(buildUrl("/api/health"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
};

export const fetchStations = async (mode?: ModeFilter, limit = 900): Promise<StationSummary[]> => {
  const params = [`limit=${Math.max(1, Math.min(1200, limit))}`];
  const modeQuery = buildModeQuery(mode);
  if (modeQuery) params.push(modeQuery);
  const response = await fetch(buildUrl(`/api/stations?${params.join("&")}`), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Stations request failed: ${response.status}`);
  }
  const payload = (await response.json()) as { stations: StationSummary[] };
  return payload.stations;
};

export const fetchVehicles = async (mode?: ModeFilter): Promise<{
  vehicles: VehicleSnapshot[];
  generatedAt: string;
}> => {
  const modeQuery = buildModeQuery(mode);
  const response = await fetch(buildUrl(`/api/vehicles${modeQuery ? `?${modeQuery}` : ""}`), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Vehicles request failed: ${response.status}`);
  }
  return (await response.json()) as {
    vehicles: VehicleSnapshot[];
    generatedAt: string;
  };
};

export const fetchHome = (params: {
  lat: number;
  lng: number;
  radiusMeters?: number;
  limit?: number;
}): Promise<HomeResponse> => {
  const normalized: {
    lat: number;
    lng: number;
    radiusMeters?: number;
    limit?: number;
  } = {
    ...params,
    lat: quantizeCoordinate(params.lat),
    lng: quantizeCoordinate(params.lng),
  };
  if (typeof params.radiusMeters === "number") {
    normalized.radiusMeters = quantizeRadius(params.radiusMeters);
  }
  return coreFetchHome(API_BASE_URL, normalized);
};

export const fetchStationBoard = (
  stopId: string,
  params?: { lat?: number; lng?: number; includeAlerts?: boolean; includeFacilities?: boolean },
): Promise<GetStationBoardResponse> => coreFetchStationBoard(API_BASE_URL, stopId, params);

export const fetchTripTrack = (tripId: string): Promise<TripTrackResponse> =>
  coreFetchTripTrack(API_BASE_URL, tripId);

export const fetchLines = (): Promise<LineSummary[]> => coreFetchLines(API_BASE_URL);

export const fetchLineOverview = (lineId: string): Promise<LineOverview> =>
  coreFetchLineOverview(API_BASE_URL, lineId);

export const fetchSystemInsights = (): Promise<SystemInsights> =>
  coreFetchSystemInsights(API_BASE_URL);

export const fetchLineShapes = (lineId: string): Promise<LineShapeResponse> =>
  coreFetchLineShapes(API_BASE_URL, lineId);

export interface DonationBoardEntry {
  name: string;
  amount: number;
  amountCents: number;
  currency: string;
  createdAt: string;
}

export interface DonationBoardResponse {
  top: DonationBoardEntry[];
  recent: DonationBoardEntry[];
  summary?: {
    supporterCount: number;
    totalAmountCents: number;
  };
  updatedAt: string;
}

export const fetchDonationBoard = async (limit = 18): Promise<DonationBoardResponse> => {
  const response = await fetch(buildUrl(`/api/donations/board?limit=${limit}`), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Donation board request failed: ${response.status}`);
  }
  return (await response.json()) as DonationBoardResponse;
};

export const fetchTripPlanner = async (
  params: TripPlannerRequest,
  init?: RequestInit,
): Promise<TripPlannerResponse> => {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Number(envConfig.tripPlannerTimeoutMs ?? 12_000);
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (init?.signal) {
    init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const query = new URLSearchParams({
    originLat: params.originLat.toString(),
    originLon: params.originLon.toString(),
    destLat: params.destLat.toString(),
    destLon: params.destLon.toString(),
  });
  if (params.departAt) query.set("departAt", params.departAt);
  if (params.modes?.length) query.set("modes", params.modes.join(","));
  if (typeof params.maxWalkMinutes === "number") query.set("maxWalkMinutes", params.maxWalkMinutes.toString());
  if (typeof params.maxTransfers === "number") query.set("maxTransfers", params.maxTransfers.toString());

  try {
    const response = await fetch(buildUrl(`/api/trip-planner?${query.toString()}`), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      let payload: { error?: string; message?: string } | null = null;
      try {
        payload = (await response.json()) as { error?: string; message?: string };
      } catch {
        payload = null;
      }
      if (payload?.error === "no_route") {
        const err = new Error(payload.message ?? "No valid route found.");
        err.name = "trip_planner_no_route";
        throw err;
      }
      const err = new Error(payload?.message ?? `Trip planner request failed: ${response.status}`);
      err.name = "trip_planner_request_failed";
      throw err;
    }
    const payload = (await response.json()) as TripPlannerResponse;
    const validation = validateTripPlannerResponse(payload);
    if (!validation.ok) {
      throw new Error(`Trip planner response invalid: ${validation.errors.join(", ")}`);
    }
    return payload;
  } catch (error) {
    if ((error as Error).name === "AbortError" && timedOut) {
      throw new Error("trip_planner_timeout");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

export interface StopLookupEntry {
  stopId: string;
  name: string;
  latitude: number;
  longitude: number;
}

export const fetchStopLookup = async (stopIds: string[]): Promise<StopLookupEntry[]> => {
  const unique = Array.from(new Set(stopIds.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return [];
  const response = await fetch(buildUrl(`/api/stops/lookup?ids=${encodeURIComponent(unique.join(","))}`), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Stop lookup request failed: ${response.status}`);
  }
  const payload = (await response.json()) as { ready: boolean; stops: StopLookupEntry[] };
  return payload.stops ?? [];
};

export interface DonationConfig {
  enabled: boolean;
  mode: "test" | "live";
  publishableKey?: string;
}

export interface DonationCheckoutPayload {
  amount: number;
  name?: string;
  email?: string;
}

export interface DonationCheckoutResponse {
  sessionId: string;
  checkoutUrl: string | null;
  amountCents: number;
}

export const fetchDonationConfig = async (): Promise<DonationConfig> => {
  const response = await fetch(buildUrl("/api/donations/config"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Donation config failed: ${response.status}`);
  }
  return (await response.json()) as DonationConfig;
};

export const createDonationCheckout = async (
  payload: DonationCheckoutPayload,
): Promise<DonationCheckoutResponse> => {
  const response = await fetch(buildUrl("/api/donations/checkout"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Donation checkout failed: ${response.status}`);
  }
  return (await response.json()) as DonationCheckoutResponse;
};

export type {
  HomeResponse,
  GetStationBoardResponse,
  TripTrackResponse,
  LineSummary,
  LineOverview,
  SystemInsights,
  LineShapeResponse,
  TripPlannerRequest,
  TripPlannerResponse,
};
