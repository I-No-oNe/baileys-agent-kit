import pino, { type LevelWithSilent, type Logger } from "pino";

const LEVELS = new Set<LevelWithSilent>(["silent", "fatal", "error", "warn", "info", "debug", "trace"]);

export function baileysLogLevel(value = process.env.WA_BAILEYS_LOG_LEVEL): LevelWithSilent {
  const level = (value?.trim().toLowerCase() || "silent") as LevelWithSilent;
  if (!LEVELS.has(level)) {
    throw new Error("WA_BAILEYS_LOG_LEVEL must be silent, fatal, error, warn, info, debug, or trace.");
  }
  return level;
}

export function createBaileysLogger(value?: string): Logger {
  return pino({ level: baileysLogLevel(value), base: undefined });
}
