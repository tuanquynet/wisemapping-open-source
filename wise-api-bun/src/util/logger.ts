import { config, type LogLevel } from "../config.ts";

const rank: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  const threshold = rank[config.logLevel];
  if (rank[level] > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}`;
  if (level === "error" || level === "warn") {
    console.error(line, ...args);
  } else {
    console.log(line, ...args);
  }
}

export const logger = {
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
};
