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
  params?: { lat?: number; lng?: number },
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

export const fetchRouteShapes = (routeId: string): Promise<LineShapeResponse> =>
  fetch(buildUrl(`/api/routes/${routeId}/shapes`)).then((res) => res.json());

export type { HomeResponse, GetStationBoardResponse, TripTrackResponse, LineSummary, LineOverview, SystemInsights, LineShapeResponse };
