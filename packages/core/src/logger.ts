import type { Logger as SharedLogger, LogLevel } from '@nexipi/shared';
import type { EngineConfig } from './config.js';

export type Logger = SharedLogger;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'token',
  'secret',
  'password',
  'auth',
  'credential',
  'accessToken',
  'refreshToken',
  'apikey',
];

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }
  const seen = new WeakSet<object>();

  function sanitize(value: unknown): unknown {
    if (value === null) {
      return null;
    }
    if (typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.some(s => lowerKey.includes(s))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitize(val);
      }
    }
    return sanitized;
  }

  return sanitize(meta) as Record<string, unknown>;
}

export function createLogger(config: EngineConfig): Logger {
  const currentLevel = LOG_LEVELS[config.logLevel];

  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LOG_LEVELS[level] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const sanitizedMeta = sanitizeMeta(meta);
      const metaStr = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : '';
      // eslint-disable-next-line no-console
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`);
    }
  };

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  };
}

export function createNoopLogger(): Logger {
  const noop = (): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

export { LOG_LEVELS, type LogLevel };
