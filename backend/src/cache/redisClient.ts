import { createClient } from "redis";
import { config } from "../config";
import { logger } from "../utils/logger";

type RedisClientInstance = ReturnType<typeof createClient>;

export type RedisStatus = "disabled" | "connecting" | "ready" | "error";

export interface RedisManager {
  client: RedisClientInstance | null;
  status: RedisStatus;
  error: Error | undefined;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  getJson: <T>(key: string) => Promise<T | null>;
  setJson: <T>(key: string, value: T, ttlMs?: number) => Promise<void>;
}

const NOOP_MANAGER: RedisManager = {
  client: null,
  status: "disabled",
  error: undefined,
  connect: async () => {
    logger.info("Redis disabled; skipping connect");
  },
  disconnect: async () => {
    logger.info("Redis disabled; skipping disconnect");
  },
  getJson: async () => null,
  setJson: async () => undefined,
};

export const createRedisManager = (): RedisManager => {
  if (!config.redisUrl) {
    logger.info("Redis URL not configured; caching will remain in-memory");
    return NOOP_MANAGER;
  }

  const client = createClient({ url: config.redisUrl });
  let status: RedisStatus = "connecting";
  let connectionError: Error | undefined;

  client.on("error", (error) => {
    status = "error";
    connectionError = error instanceof Error ? error : new Error(String(error));
    logger.error("Redis connection error", { message: connectionError.message });
  });

  client.on("end", () => {
    status = "disabled";
    logger.info("Redis connection closed");
  });

  const connect = async () => {
    if (status === "ready") return;
    try {
      status = "connecting";
      await client.connect();
      status = "ready";
      connectionError = undefined;
      logger.info("Redis connection established");
    } catch (error) {
      status = "error";
      connectionError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to connect to Redis", { message: connectionError.message });
    }
  };

  const disconnect = async () => {
    if (status === "disabled" || status === "error") return;
    try {
      await client.disconnect();
      status = "disabled";
    } catch (error) {
      logger.warn("Failed to close Redis connection", { message: String(error) });
    }
  };

  const getJson = async <T>(key: string): Promise<T | null> => {
    if (status !== "ready") return null;
    try {
      const payload = await client.get(key);
      if (!payload) return null;
      return JSON.parse(payload) as T;
    } catch (error) {
      logger.warn("Redis getJson failed", { key, message: String(error) });
      return null;
    }
  };

  const setJson = async <T>(key: string, value: T, ttlMs?: number) => {
    if (status !== "ready") return;
    try {
      const serialized = JSON.stringify(value);
      if (ttlMs && ttlMs > 0) {
        await client.set(key, serialized, { PX: ttlMs });
      } else {
        await client.set(key, serialized);
      }
    } catch (error) {
      logger.warn("Redis setJson failed", { key, message: String(error) });
    }
  };

  void connect();

  return {
    client,
    get status() {
      return status;
    },
    get error() {
      return connectionError;
    },
    connect,
    disconnect,
    getJson,
    setJson,
  };
};
