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

export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public readonly cause?: Error;
  public readonly context?: Record<string, unknown>;

  constructor(
    code: EngineErrorCode,
    message: string,
    options?: { cause?: Error; context?: Record<string, unknown> }
  ) {
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
      context: this.context,
      stack: this.stack,
    };
  }
}

export function createEngineError(
  code: EngineErrorCode,
  message: string,
  options?: { cause?: Error; context?: Record<string, unknown> }
): EngineError {
  return new EngineError(code, message, options);
}

export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}

export function assertEngineError(error: unknown, code: EngineErrorCode): asserts error is EngineError {
  if (!isEngineError(error) || error.code !== code) {
    throw new EngineError(
      EngineErrorCode.INTERNAL_ERROR,
      `Expected EngineError with code ${code}, got ${error instanceof Error ? error.message : String(error)}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}