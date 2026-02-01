type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

export const logger = {
  debug: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.debug) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.error) console.error(...args);
  },
};
