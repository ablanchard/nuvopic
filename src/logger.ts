type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.debug)
      console.log(`[${timestamp()}] DEBUG`, ...args);
  },
  info: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.info)
      console.log(`[${timestamp()}] INFO `, ...args);
  },
  warn: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.warn)
      console.warn(`[${timestamp()}] WARN `, ...args);
  },
  error: (...args: unknown[]) => {
    if (levels[currentLevel] <= levels.error)
      console.error(`[${timestamp()}] ERROR`, ...args);
  },
};
