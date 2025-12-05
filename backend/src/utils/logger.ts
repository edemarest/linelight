import { config } from "../config";

type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const formatMessage = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  return `${base} ${JSON.stringify(meta)}`;
};

const shouldLog = (level: LogLevel): boolean => {
  const configured = config.logLevel ?? "info";
  return levelPriority[level] >= levelPriority[configured];
};

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  if (!shouldLog(level)) return;
  const line = formatMessage(level, message, meta);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "debug") {
    console.debug(line);
    return;
  }
  console.log(line);
};

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
};

export type Logger = typeof logger;
