import type { JsonApiResponse } from "../models/jsonApi";
import type {
  MbtaAlert,
  MbtaLine,
  MbtaLiveFacility,
  MbtaPrediction,
  MbtaRoute,
  MbtaSchedule,
  MbtaShape,
  MbtaStop,
  MbtaTrip,
  MbtaVehicle,
} from "../models/mbta";
import { config } from "../config";
import { logger } from "../utils/logger";

type QueryParams = Record<string, string | number | boolean | Array<string | number | boolean>>;

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface MbtaTelemetryState {
  totalRequests: number;
  retryableResponses: number;
  failedRequests: number;
  totalRateLimitDelayMs: number;
  rateLimitDelayCount: number;
  lastRateLimitDelayMs: number | null;
  lastRateLimitDelayAt: string | null;
  last429At: string | null;
  last429Path: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  lastFailurePath: string | null;
  lastSuccessAt: string | null;
  lastSuccessPath: string | null;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const rateLimitConfig: RateLimitConfig = {
  windowMs: config.mbtaRateLimitWindowMs,
  maxRequests: config.mbtaRateLimitMaxRequests,
};

const maxRetries = config.mbtaMaxRetries;
const baseDelayMs = config.mbtaRetryBaseDelayMs;
const maxDelayMs = config.mbtaRetryMaxDelayMs;
const minSpacingMs = Math.max(50, Math.floor(rateLimitConfig.windowMs / rateLimitConfig.maxRequests));

const telemetryState: MbtaTelemetryState = {
  totalRequests: 0,
  retryableResponses: 0,
  failedRequests: 0,
  totalRateLimitDelayMs: 0,
  rateLimitDelayCount: 0,
  lastRateLimitDelayMs: null,
  lastRateLimitDelayAt: null,
  last429At: null,
  last429Path: null,
  lastFailureAt: null,
  lastFailureMessage: null,
  lastFailurePath: null,
  lastSuccessAt: null,
  lastSuccessPath: null,
};

export const getMbtaClientTelemetry = () => {
  const averageDelay =
    telemetryState.rateLimitDelayCount === 0
      ? 0
      : telemetryState.totalRateLimitDelayMs / telemetryState.rateLimitDelayCount;
  return {
    ...telemetryState,
    averageRateLimitDelayMs: Math.round(averageDelay),
  };
};

const requestTimestamps: number[] = [];
let nextAvailableTimestamp = Date.now();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const recordRateLimitDelay = (waitMs: number) => {
  telemetryState.totalRateLimitDelayMs += waitMs;
  telemetryState.rateLimitDelayCount += 1;
  telemetryState.lastRateLimitDelayMs = waitMs;
  telemetryState.lastRateLimitDelayAt = new Date().toISOString();
};

const acquireRateLimitSlot = async (path: string) => {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0) {
      const oldest = requestTimestamps[0];
      if (oldest !== undefined && now - oldest > rateLimitConfig.windowMs) {
        requestTimestamps.shift();
        continue;
      }
      break;
    }

    const windowWait =
      requestTimestamps.length >= rateLimitConfig.maxRequests && requestTimestamps[0] !== undefined
        ? Math.max(0, rateLimitConfig.windowMs - (now - requestTimestamps[0]!))
        : 0;
    const spacingWait = Math.max(0, nextAvailableTimestamp - now);
    const waitMs = Math.max(windowWait, spacingWait);

    if (waitMs <= 0) {
      requestTimestamps.push(now);
      nextAvailableTimestamp = now + minSpacingMs;
      return;
    }

    const jitter = Math.floor(Math.random() * Math.min(250, waitMs * 0.25 + 1));
    const totalWait = waitMs + jitter;
    logger.debug("MBTA rate limit in effect, delaying request", {
      path,
      waitMs: totalWait,
      pending: requestTimestamps.length,
    });
    recordRateLimitDelay(totalWait);
    await delay(totalWait);
  }
};

const computeBackoff = (attempt: number) => {
  const cappedAttempt = Math.min(attempt, 10);
  const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** cappedAttempt);
  const jitter = Math.floor(Math.random() * 0.3 * delayMs);
  return delayMs + jitter;
};

const recordRetryableResponse = (status: number | undefined, path: string) => {
  telemetryState.retryableResponses += 1;
  if (status === 429) {
    telemetryState.last429At = new Date().toISOString();
    telemetryState.last429Path = path;
  }
};

const recordFailure = (error: unknown, path: string) => {
  telemetryState.failedRequests += 1;
  telemetryState.lastFailureAt = new Date().toISOString();
  telemetryState.lastFailureMessage = safeErrorMessage(error);
  telemetryState.lastFailurePath = path;
};

const safeErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
};

export interface MbtaClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class MbtaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: MbtaClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? config.mbtaApiBaseUrl;
    this.apiKey = options.apiKey ?? config.mbtaApiKey;
  }

  async getRoutes(params?: QueryParams) {
    return this.get<MbtaRoute>("/routes", params);
  }

  async getLines(params?: QueryParams) {
    return this.get<MbtaLine>("/lines", params);
  }

  async getStops(params?: QueryParams) {
    return this.get<MbtaStop>("/stops", params);
  }

  async getPredictions(params?: QueryParams) {
    return this.get<MbtaPrediction>("/predictions", params);
  }

  async getSchedules(params?: QueryParams) {
    return this.get<MbtaSchedule>("/schedules", params);
  }

  async getVehicles(params?: QueryParams) {
    return this.get<MbtaVehicle>("/vehicles", params);
  }

  async getAlerts(params?: QueryParams) {
    return this.get<MbtaAlert>("/alerts", params);
  }

  async getLiveFacilities(params?: QueryParams) {
    return this.get<MbtaLiveFacility>("/live_facilities", params);
  }

  async getShapes(params?: QueryParams) {
    return this.get<MbtaShape>("/shapes", params);
  }

  async getTrips(params?: QueryParams) {
    return this.get<MbtaTrip>("/trips", params);
  }

  private async get<TResource>(path: string, params?: QueryParams) {
    await acquireRateLimitSlot(path);

    const searchParams = this.buildSearchParams(params);
    const url = `${this.baseUrl}${path}${searchParams ? `?${searchParams}` : ""}`;

    const headers = new Headers({
      "Content-Type": "application/json",
    });
    if (this.apiKey) {
      headers.set("x-api-key", this.apiKey);
    }

    const response = await this.fetchWithRetry(url, path, { headers });
    return (await response.json()) as JsonApiResponse<TResource>;
  }

  private async fetchWithRetry(url: string, path: string, init: RequestInit) {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(url, init);
        if (response.ok) {
          telemetryState.totalRequests += 1;
          telemetryState.lastSuccessAt = new Date().toISOString();
          telemetryState.lastSuccessPath = path;
          return response;
        }

        const body = await response.text().catch(() => "");
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
          const terminalError = new Error(
            `MBTA request failed (${response.status} ${response.statusText}) for ${path}${body ? ` - ${body}` : ""}`,
          );
          recordFailure(terminalError, path);
          throw terminalError;
        }

        recordRetryableResponse(response.status, path);
        lastError = new Error(
          `Retryable status ${response.status} for ${path}${body ? ` - ${body.slice(0, 180)}` : ""}`,
        );
        const waitMs = computeBackoff(attempt);
        logger.warn("MBTA request hit retryable status, backing off", {
          path,
          status: response.status,
          attempt,
          waitMs,
        });
        await delay(waitMs);
      } catch (error) {
        recordRetryableResponse(undefined, path);
        lastError = error;
        if (attempt === maxRetries) {
          break;
        }
        const waitMs = computeBackoff(attempt);
        logger.warn("MBTA request failed, retrying", {
          path,
          attempt,
          waitMs,
          message: safeErrorMessage(error),
        });
        await delay(waitMs);
      }
      attempt += 1;
    }

    recordFailure(lastError, path);
    throw new Error(`MBTA request exhausted retries for ${path}: ${safeErrorMessage(lastError)}`);
  }

  private buildSearchParams(params?: QueryParams) {
    if (!params) return "";
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((entry) => searchParams.append(key, String(entry)));
        return;
      }
      searchParams.set(key, String(value));
    });
    return searchParams.toString();
  }
}

export const createMbtaClient = () => {
  const options: MbtaClientOptions = {
    baseUrl: config.mbtaApiBaseUrl,
  };

  if (config.mbtaApiKey) {
    options.apiKey = config.mbtaApiKey;
  }

  return new MbtaClient(options);
};
