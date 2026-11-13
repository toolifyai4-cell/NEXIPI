import { EngineError, EngineErrorCode, createEngineError, type EngineErrorOptions } from '@nexipi/core';

export enum ModelProviderErrorCode {
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  UNSUPPORTED_MODEL = 'UNSUPPORTED_MODEL',
  INVALID_REQUEST = 'INVALID_REQUEST',
  CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  PROVIDER_NOT_INITIALIZED = 'PROVIDER_NOT_INITIALIZED',
  CREDENTIALS_NOT_FOUND = 'CREDENTIALS_NOT_FOUND',
  CREDENTIALS_INVALID = 'CREDENTIALS_INVALID',
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  TIMEOUT = 'TIMEOUT',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  CONTENT_FILTERED = 'CONTENT_FILTERED',
}

const PROVIDER_ERROR_CODE_MAP: Record<string, ModelProviderErrorCode> = {
  'authentication failed': ModelProviderErrorCode.AUTHENTICATION_FAILED,
  'invalid api key': ModelProviderErrorCode.INVALID_API_KEY,
  'unauthorized': ModelProviderErrorCode.AUTHENTICATION_FAILED,
  'rate limit': ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
  'too many requests': ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
  'network': ModelProviderErrorCode.NETWORK_ERROR,
  'connection': ModelProviderErrorCode.NETWORK_ERROR,
  'econnrefused': ModelProviderErrorCode.NETWORK_ERROR,
  'etimedout': ModelProviderErrorCode.TIMEOUT,
  'timeout': ModelProviderErrorCode.TIMEOUT,
  'unavailable': ModelProviderErrorCode.PROVIDER_UNAVAILABLE,
  'service unavailable': ModelProviderErrorCode.PROVIDER_UNAVAILABLE,
  'unsupported model': ModelProviderErrorCode.UNSUPPORTED_MODEL,
  'model not found': ModelProviderErrorCode.MODEL_NOT_FOUND,
  'invalid request': ModelProviderErrorCode.INVALID_REQUEST,
  'bad request': ModelProviderErrorCode.INVALID_REQUEST,
  'context length': ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  'max tokens': ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  'quota': ModelProviderErrorCode.QUOTA_EXCEEDED,
  'content filter': ModelProviderErrorCode.CONTENT_FILTERED,
  'content policy': ModelProviderErrorCode.CONTENT_FILTERED,
};

export class ModelProviderError extends EngineError {
  public readonly providerId: string;
  public readonly modelId: string | undefined;
  public readonly retryable: boolean;
  public readonly providerErrorCode: string | undefined;

  constructor(
    code: ModelProviderErrorCode,
    message: string,
    options: {
      providerId: string;
      modelId?: string;
      cause?: Error;
      context?: Record<string, unknown>;
      retryable?: boolean;
      providerErrorCode?: string;
    }
  ) {
    super(code, message, { cause: options.cause, context: options.context } as EngineErrorOptions);
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.retryable = options.retryable ?? this.isRetryableByDefault(code);
    this.providerErrorCode = options.providerErrorCode;

    Object.setPrototypeOf(this, ModelProviderError.prototype);
  }

  private isRetryableByDefault(code: ModelProviderErrorCode): boolean {
    switch (code) {
      case ModelProviderErrorCode.RATE_LIMIT_EXCEEDED:
      case ModelProviderErrorCode.NETWORK_ERROR:
      case ModelProviderErrorCode.PROVIDER_UNAVAILABLE:
      case ModelProviderErrorCode.TIMEOUT:
        return true;
      default:
        return false;
    }
  }

  override get name(): string {
    return 'ModelProviderError';
  }

  static fromError(
    error: unknown,
    providerId: string,
    modelId?: string
  ): ModelProviderError {
    if (error instanceof ModelProviderError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = ModelProviderError.classifyError(message);

    const retryable = ModelProviderError.isRetryableError(code);
    const providerErrorCode = ModelProviderError.extractProviderErrorCode(error);

    return new ModelProviderError(code, message, {
      providerId,
      modelId,
      cause: error instanceof Error ? error : undefined,
      context: { originalMessage: message },
      retryable,
      providerErrorCode,
    });
  }

  private static classifyError(message: string): ModelProviderErrorCode {
    const lowerMessage = message.toLowerCase();

    for (const [pattern, code] of Object.entries(PROVIDER_ERROR_CODE_MAP)) {
      if (lowerMessage.includes(pattern)) {
        return code;
      }
    }

    return ModelProviderErrorCode.EXECUTION_FAILED;
  }

  private static isRetryableError(code: ModelProviderErrorCode): boolean {
    switch (code) {
      case ModelProviderErrorCode.RATE_LIMIT_EXCEEDED:
      case ModelProviderErrorCode.NETWORK_ERROR:
      case ModelProviderErrorCode.PROVIDER_UNAVAILABLE:
      case ModelProviderErrorCode.TIMEOUT:
        return true;
      default:
        return false;
    }
  }

  private static extractProviderErrorCode(error: unknown): string | undefined {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      if ('code' in err) {
        const code = err['code'];
        if (typeof code === 'string') {
          return code;
        }
      }
      if ('status' in err) {
        const status = err['status'];
        if (typeof status === 'number') {
          return `HTTP_${status}`;
        }
      }
    }
    return undefined;
  }

  override toJSON(): Record<string, unknown> {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      providerId: this.providerId,
      modelId: this.modelId,
      retryable: this.retryable,
      providerErrorCode: this.providerErrorCode,
    };
  }
}

export function createModelProviderError(
  code: ModelProviderErrorCode,
  message: string,
  options: {
    providerId: string;
    modelId?: string;
    cause?: Error;
    context?: Record<string, unknown>;
    retryable?: boolean;
    providerErrorCode?: string;
  }
): ModelProviderError {
  return new ModelProviderError(code, message, options);
}

export function isModelProviderError(error: unknown): error is ModelProviderError {
  return error instanceof ModelProviderError;
}

export function mapToEngineError(error: ModelProviderError): EngineError {
  let engineCode: EngineErrorCode;
  switch (error.code) {
    case ModelProviderErrorCode.AUTHENTICATION_FAILED:
    case ModelProviderErrorCode.INVALID_API_KEY:
    case ModelProviderErrorCode.CREDENTIALS_NOT_FOUND:
    case ModelProviderErrorCode.CREDENTIALS_INVALID:
      engineCode = EngineErrorCode.INVALID_CONFIGURATION;
      break;
    case ModelProviderErrorCode.RATE_LIMIT_EXCEEDED:
    case ModelProviderErrorCode.QUOTA_EXCEEDED:
      engineCode = EngineErrorCode.INTERNAL_ERROR;
      break;
    case ModelProviderErrorCode.NETWORK_ERROR:
    case ModelProviderErrorCode.PROVIDER_UNAVAILABLE:
    case ModelProviderErrorCode.TIMEOUT:
      engineCode = EngineErrorCode.INTERNAL_ERROR;
      break;
    case ModelProviderErrorCode.UNSUPPORTED_MODEL:
    case ModelProviderErrorCode.MODEL_NOT_FOUND:
      engineCode = EngineErrorCode.INVALID_CONFIGURATION;
      break;
    case ModelProviderErrorCode.INVALID_REQUEST:
    case ModelProviderErrorCode.VALIDATION_FAILED:
      engineCode = EngineErrorCode.INVALID_CONFIGURATION;
      break;
    case ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED:
      engineCode = EngineErrorCode.INTERNAL_ERROR;
      break;
    case ModelProviderErrorCode.CONTENT_FILTERED:
      engineCode = EngineErrorCode.INTERNAL_ERROR;
      break;
    default:
      engineCode = EngineErrorCode.INTERNAL_ERROR;
  }

  return createEngineError(engineCode, error.message, {
    cause: error.cause,
    context: {
      ...error.context,
      providerId: error.providerId,
      modelId: error.modelId,
      providerErrorCode: error.providerErrorCode,
      retryable: error.retryable,
    },
  });
}