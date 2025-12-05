import dotenv from "dotenv";

dotenv.config();

const DEFAULT_PORT = 4000;
const DEFAULT_MBTA_BASE_URL = "https://api-v3.mbta.com";
const DEFAULT_MBTA_RATE_LIMIT_WINDOW_MS = 10_000;
const DEFAULT_MBTA_RATE_LIMIT_MAX_REQUESTS = 6;
const DEFAULT_MBTA_MAX_RETRIES = 4;
const DEFAULT_MBTA_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_MBTA_RETRY_MAX_DELAY_MS = 7_500;
type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  port: number;
  mbtaApiBaseUrl: string;
  mbtaApiKey: string | undefined;
  redisUrl: string | undefined;
  logLevel: LogLevel;
  enableDiagnostics: boolean;
  mbtaRateLimitWindowMs: number;
  mbtaRateLimitMaxRequests: number;
  mbtaMaxRetries: number;
  mbtaRetryBaseDelayMs: number;
  mbtaRetryMaxDelayMs: number;
}

const normalizeLogLevel = (value?: string): LogLevel => {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "debug" || normalized === "warn" || normalized === "error") {
    return normalized as LogLevel;
  }
  return "info";
};

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
};

export const config: AppConfig = {
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  mbtaApiBaseUrl: process.env.MBTA_API_BASE_URL ?? DEFAULT_MBTA_BASE_URL,
  mbtaApiKey: process.env.MBTA_API_KEY,
  redisUrl: process.env.REDIS_URL,
  logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
  enableDiagnostics: process.env.ENABLE_DIAGNOSTICS === "true" || process.env.NODE_ENV !== "production",
  mbtaRateLimitWindowMs: parsePositiveNumber(
    process.env.MBTA_RATE_LIMIT_WINDOW_MS,
    DEFAULT_MBTA_RATE_LIMIT_WINDOW_MS,
  ),
  mbtaRateLimitMaxRequests: parsePositiveNumber(
    process.env.MBTA_RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_MBTA_RATE_LIMIT_MAX_REQUESTS,
  ),
  mbtaMaxRetries: parsePositiveNumber(process.env.MBTA_MAX_RETRIES, DEFAULT_MBTA_MAX_RETRIES),
  mbtaRetryBaseDelayMs: parsePositiveNumber(
    process.env.MBTA_RETRY_BASE_DELAY_MS,
    DEFAULT_MBTA_RETRY_BASE_DELAY_MS,
  ),
  mbtaRetryMaxDelayMs: parsePositiveNumber(
    process.env.MBTA_RETRY_MAX_DELAY_MS,
    DEFAULT_MBTA_RETRY_MAX_DELAY_MS,
  ),
};
