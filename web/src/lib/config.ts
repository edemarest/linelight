// Browser-safe config loader with local defaults and NEXT_PUBLIC overrides.
const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getDefaultApiBase = () => {
  if (typeof window !== "undefined") {
    const origin = window.location?.origin;
    // When running the web app on a different port (e.g., 3000/3001), we still want API calls to hit the backend on 4000.
    if (origin && /localhost:300\d/.test(origin)) return "http://localhost:4000";
    if (origin) return origin;
  }
  return "http://localhost:4000";
};

const normalizeUrl = (value?: string) => {
  if (!value) return "";
  return value.replace(/\/+$/, "");
};

const DEFAULT_LANDMARKS_BASE_URL = "https://linelight-landmarks-621331805208.s3.amazonaws.com";

export const envConfig = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? getDefaultApiBase(),
  landmarksBaseUrl: normalizeUrl(process.env.NEXT_PUBLIC_LANDMARKS_BASE_URL) || DEFAULT_LANDMARKS_BASE_URL,
  tripPlannerTimeoutMs: parseNumber(process.env.NEXT_PUBLIC_TRIP_PLANNER_TIMEOUT_MS, 12_000),
  defaultMap: {
    lat: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_LAT, 42.3601),
    lng: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_LNG, -71.0589),
    zoom: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_ZOOM, 11),
  },
} as const;

export type EnvConfig = typeof envConfig;
