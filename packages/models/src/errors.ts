import { EngineError, EngineErrorCode, createEngineError } from '@nexipi/core';

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
  unauthorized: ModelProviderErrorCode.AUTHENTICATION_FAILED,
  'rate limit': ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
  'too many requests': ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
  network: ModelProviderErrorCode.NETWORK_ERROR,
  connection: ModelProviderErrorCode.NETWORK_ERROR,
  econnrefused: ModelProviderErrorCode.NETWORK_ERROR,
  etimedout: ModelProviderErrorCode.TIMEOUT,
  timeout: ModelProviderErrorCode.TIMEOUT,
  'timed out': ModelProviderErrorCode.TIMEOUT,
  unavailable: ModelProviderErrorCode.PROVIDER_UNAVAILABLE,
  'service unavailable': ModelProviderErrorCode.PROVIDER_UNAVAILABLE,
  'unsupported model': ModelProviderErrorCode.UNSUPPORTED_MODEL,
  'model not found': ModelProviderErrorCode.UNSUPPORTED_MODEL,
  'invalid request': ModelProviderErrorCode.INVALID_REQUEST,
  'bad request': ModelProviderErrorCode.INVALID_REQUEST,
  'context length': ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  'max tokens': ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  quota: ModelProviderErrorCode.QUOTA_EXCEEDED,
  'content filter': ModelProviderErrorCode.CONTENT_FILTERED,
  'content policy': ModelProviderErrorCode.CONTENT_FILTERED,
};

export class ModelProviderError extends EngineError<ModelProviderErrorCode> {
  public readonly providerId: string;
  public readonly modelId?: string;
  public readonly retryable: boolean;
  public readonly providerErrorCode?: string;

  constructor(
    code: ModelProviderErrorCode,
    message: string,
    options: {
      providerId: string;
      modelId?: string;
      cause?: Error | undefined;
      context?: Record<string, unknown>;
      retryable?: boolean;
      providerErrorCode?: string;
    }
  ) {
    super(code, message, {
      cause: options.cause,
      context: options.context,
    });
    Object.setPrototypeOf(this, ModelProviderError.prototype);
    this.name = 'ModelProviderError';
    this.providerId = options.providerId;
    if (options.modelId !== undefined) {
      this.modelId = options.modelId;
    }
    this.retryable = options.retryable ?? this.isRetryableByDefault(code);
    if (options.providerErrorCode !== undefined) {
      this.providerErrorCode = options.providerErrorCode;
    }
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

  static fromError(error: unknown, providerId: string, modelId?: string): ModelProviderError {
    if (error instanceof ModelProviderError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = ModelProviderError.classifyError(message);

    const retryable = ModelProviderError.isRetryableError(code);
    const providerErrorCode = ModelProviderError.extractProviderErrorCode(error);

    const errorOptions: {
      providerId: string;
      modelId?: string;
      cause?: Error | undefined;
      context: Record<string, unknown>;
      retryable: boolean;
      providerErrorCode?: string;
    } = {
      providerId,
      cause: error instanceof Error ? error : undefined,
      context: { originalMessage: message },
      retryable,
    };
    if (modelId !== undefined) {
      errorOptions.modelId = modelId;
    }
    if (providerErrorCode !== undefined) {
      errorOptions.providerErrorCode = providerErrorCode;
    }

    return new ModelProviderError(code, message, errorOptions);
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
      name: 'ModelProviderError',
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

const MODEL_PROVIDER_ENGINE_CODE_MAP: Record<string, EngineErrorCode> = {
  [ModelProviderErrorCode.AUTHENTICATION_FAILED]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.INVALID_API_KEY]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.CREDENTIALS_NOT_FOUND]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.CREDENTIALS_INVALID]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.RATE_LIMIT_EXCEEDED]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.QUOTA_EXCEEDED]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.NETWORK_ERROR]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.PROVIDER_UNAVAILABLE]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.TIMEOUT]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.UNSUPPORTED_MODEL]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.MODEL_NOT_FOUND]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.INVALID_REQUEST]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.VALIDATION_FAILED]: EngineErrorCode.INVALID_CONFIGURATION,
  [ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.CONTENT_FILTERED]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.EXECUTION_FAILED]: EngineErrorCode.INTERNAL_ERROR,
  [ModelProviderErrorCode.PROVIDER_NOT_INITIALIZED]: EngineErrorCode.INTERNAL_ERROR,
};

export function mapToEngineError(error: ModelProviderError): EngineError {
  const engineCode = MODEL_PROVIDER_ENGINE_CODE_MAP[error.code] ?? EngineErrorCode.INTERNAL_ERROR;

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
