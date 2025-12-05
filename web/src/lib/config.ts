const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const envConfig = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000",
  defaultMap: {
    lat: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_LAT, 42.3601),
    lng: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_LNG, -71.0589),
    zoom: parseNumber(process.env.NEXT_PUBLIC_DEFAULT_MAP_ZOOM, 11),
  },
} as const;

export type EnvConfig = typeof envConfig;

