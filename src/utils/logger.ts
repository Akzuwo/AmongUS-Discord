import { config } from "../config";

type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, scope: string | undefined, parts: unknown[]): void {
  if (level === "debug" && !config.debugMode) {
    return;
  }

  const prefix = scope ? `[${level.toUpperCase()}][${scope}]` : `[${level.toUpperCase()}]`;
  const method = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
  method(prefix, ...parts);
}

function scoped(scope: string) {
  return {
    debug: (...parts: unknown[]) => write("debug", scope, parts),
    info: (...parts: unknown[]) => write("info", scope, parts),
    warn: (...parts: unknown[]) => write("warn", scope, parts),
    error: (...parts: unknown[]) => write("error", scope, parts)
  };
}

export const logger = {
  debug: (...parts: unknown[]) => write("debug", undefined, parts),
  info: (...parts: unknown[]) => write("info", undefined, parts),
  warn: (...parts: unknown[]) => write("warn", undefined, parts),
  error: (...parts: unknown[]) => write("error", undefined, parts),
  scoped
};
