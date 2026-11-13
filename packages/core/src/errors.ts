export enum EngineErrorCode {
  INITIALIZATION_FAILED = 'INITIALIZATION_FAILED',
  ALREADY_INITIALIZED = 'ALREADY_INITIALIZED',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  ALREADY_STARTED = 'ALREADY_STARTED',
  NOT_STARTED = 'NOT_STARTED',
  ALREADY_STOPPED = 'ALREADY_STOPPED',
  INVALID_LIFECYCLE_TRANSITION = 'INVALID_LIFECYCLE_TRANSITION',
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',
  TASK_ALREADY_EXISTS = 'TASK_ALREADY_EXISTS',
  TASK_CANCELLED = 'TASK_CANCELLED',
  TASK_TIMEOUT = 'TASK_TIMEOUT',
  EVENT_EMISSION_FAILED = 'EVENT_EMISSION_FAILED',
  LISTENER_ERROR = 'LISTENER_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

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
  'clientSecret',
  'client_secret',
  'privateKey',
  'private_key',
  'authorization',
  'bearer',
];

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) {
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

  return sanitize(context) as Record<string, unknown>;
}

export type EngineErrorOptions = {
  cause?: Error | undefined;
  context?: Record<string, unknown> | undefined;
};

export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public override readonly cause?: Error | undefined;
  public readonly context?: Record<string, unknown> | undefined;

  constructor(code: EngineErrorCode, message: string, options?: EngineErrorOptions) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;

    Object.setPrototypeOf(this, EngineError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause: this.cause?.message,
      context: sanitizeContext(this.context),
      stack: this.stack,
    };
  }
}

export function createEngineError(
  code: EngineErrorCode,
  message: string,
  options?: EngineErrorOptions
): EngineError {
  return new EngineError(code, message, options);
}

export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}

export function assertEngineError(
  error: unknown,
  code: EngineErrorCode
): asserts error is EngineError {
  if (!isEngineError(error) || error.code !== code) {
    throw new EngineError(
      EngineErrorCode.INTERNAL_ERROR,
      `Expected EngineError with code ${code}, got ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}
