import type { RequestInitWithSignal } from "./types";
import type { HomeResponse } from "../models/home";
import type { GetStationBoardResponse } from "../models/stationBoard";
import type { TripTrackResponse } from "../models/tripTrack";
import type {
  LineOverview,
  LineSummary,
  LineShapeResponse,
  SystemInsights,
} from "../models/lines";
import type { LatLng } from "../models/common";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const ensureLeadingSlash = (value: string) => (value.startsWith("/") ? value : `/${value}`);

const buildUrl = (baseUrl: string, path: string, query?: Record<string, string | number | undefined>) => {
  const url = new URL(`${trimTrailingSlash(baseUrl)}${ensureLeadingSlash(path)}`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
};

const handleJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`LineLight API request failed (${response.status})`);
  }
  return (await response.json()) as T;
};

export interface FetchHomeParams extends LatLng {
  radiusMeters?: number;
  limit?: number;
}

export const fetchHome = async (
  baseUrl: string,
  params: FetchHomeParams,
  init?: RequestInitWithSignal,
): Promise<HomeResponse> => {
  const url = buildUrl(baseUrl, "/api/home", {
    lat: params.lat,
    lng: params.lng,
    radius: params.radiusMeters,
    limit: params.limit,
  });
  const response = await fetch(url, { ...init });
  return handleJson<HomeResponse>(response);
};

export const fetchStationBoard = async (
  baseUrl: string,
  stopId: string,
  params?: Partial<LatLng>,
  init?: RequestInitWithSignal,
): Promise<GetStationBoardResponse> => {
  const url = buildUrl(baseUrl, `/api/stations/${stopId}/board`, params);
  const response = await fetch(url, { ...init });
  return handleJson<GetStationBoardResponse>(response);
};

export const fetchTripTrack = async (
  baseUrl: string,
  tripId: string,
  init?: RequestInitWithSignal,
): Promise<TripTrackResponse> => {
  const url = buildUrl(baseUrl, `/api/trips/${tripId}/track`);
  const response = await fetch(url, { ...init });
  return handleJson<TripTrackResponse>(response);
};

export const fetchLines = async (
  baseUrl: string,
  init?: RequestInitWithSignal,
): Promise<LineSummary[]> => {
  const url = buildUrl(baseUrl, "/api/lines");
  const response = await fetch(url, { ...init });
  return handleJson<LineSummary[]>(response);
};

export const fetchLineOverview = async (
  baseUrl: string,
  lineId: string,
  init?: RequestInitWithSignal,
): Promise<LineOverview> => {
  const url = buildUrl(baseUrl, `/api/lines/${lineId}/overview`);
  const response = await fetch(url, { ...init });
  return handleJson<LineOverview>(response);
};

export const fetchSystemInsights = async (
  baseUrl: string,
  init?: RequestInitWithSignal,
): Promise<SystemInsights> => {
  const url = buildUrl(baseUrl, "/api/system/insights");
  const response = await fetch(url, { ...init });
  return handleJson<SystemInsights>(response);
};

export const fetchLineShapes = async (
  baseUrl: string,
  lineId: string,
  init?: RequestInitWithSignal,
): Promise<LineShapeResponse> => {
  const url = buildUrl(baseUrl, `/api/lines/${lineId}/shapes`);
  const response = await fetch(url, { ...init });
  return handleJson<LineShapeResponse>(response);
};
