import type { Logger, LogLevel } from '@nexipi/core';

export function createLogger(config: { name: string; version: string; logLevel: LogLevel; maxConcurrentTasks: number; taskTimeoutMs: number; shutdownTimeoutMs: number; enableTelemetry: boolean }): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[config.logLevel];

  const log = (messageLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (levels[messageLevel] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      if (config.logLevel === 'debug') {
        console.log(`[${timestamp}] [${messageLevel.toUpperCase()}] ${message}${metaStr}`);
      }
    }
  };

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  };
}