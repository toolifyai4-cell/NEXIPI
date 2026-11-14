import { describe, it, expect } from 'vitest';
import {
  ModelProviderErrorCode,
  ModelProviderError,
  createModelProviderError,
  isModelProviderError,
  mapToEngineError,
} from './errors.js';
import { EngineErrorCode, isEngineError, createEngineError } from '@nexipi/core';
import { createProviderId } from './types.js';

describe('ModelProviderErrorCode', () => {
  it('should have all required error codes', () => {
    expect(ModelProviderErrorCode.AUTHENTICATION_FAILED).toBe('AUTHENTICATION_FAILED');
    expect(ModelProviderErrorCode.INVALID_API_KEY).toBe('INVALID_API_KEY');
    expect(ModelProviderErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
    expect(ModelProviderErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ModelProviderErrorCode.PROVIDER_UNAVAILABLE).toBe('PROVIDER_UNAVAILABLE');
    expect(ModelProviderErrorCode.UNSUPPORTED_MODEL).toBe('UNSUPPORTED_MODEL');
    expect(ModelProviderErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED).toBe('CONTEXT_LENGTH_EXCEEDED');
    expect(ModelProviderErrorCode.EXECUTION_FAILED).toBe('EXECUTION_FAILED');
    expect(ModelProviderErrorCode.PROVIDER_NOT_INITIALIZED).toBe('PROVIDER_NOT_INITIALIZED');
    expect(ModelProviderErrorCode.CREDENTIALS_NOT_FOUND).toBe('CREDENTIALS_NOT_FOUND');
    expect(ModelProviderErrorCode.CREDENTIALS_INVALID).toBe('CREDENTIALS_INVALID');
    expect(ModelProviderErrorCode.MODEL_NOT_FOUND).toBe('MODEL_NOT_FOUND');
    expect(ModelProviderErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
    expect(ModelProviderErrorCode.TIMEOUT).toBe('TIMEOUT');
    expect(ModelProviderErrorCode.QUOTA_EXCEEDED).toBe('QUOTA_EXCEEDED');
    expect(ModelProviderErrorCode.CONTENT_FILTERED).toBe('CONTENT_FILTERED');
  });
});

describe('ModelProviderError', () => {
  const providerId = createProviderId('openai');
  const modelId = createProviderId('gpt-4');

  describe('constructor', () => {
    it('should create error with all properties', () => {
      const error = new ModelProviderError(
        ModelProviderErrorCode.AUTHENTICATION_FAILED,
        'Invalid API key',
        { providerId, modelId, retryable: false, providerErrorCode: 'AUTH_ERROR' }
      );

      expect(error.code).toBe(ModelProviderErrorCode.AUTHENTICATION_FAILED);
      expect(error.message).toBe('Invalid API key');
      expect(error.name).toBe('ModelProviderError');
      expect(error.providerId).toBe(providerId);
      expect(error.modelId).toBe(modelId);
      expect(error.retryable).toBe(false);
      expect(error.providerErrorCode).toBe('AUTH_ERROR');
    });

    it('should default retryable based on error code', () => {
      const rateLimitError = new ModelProviderError(
        ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
        'Rate limited',
        { providerId }
      );
      expect(rateLimitError.retryable).toBe(true);

      const networkError = new ModelProviderError(
        ModelProviderErrorCode.NETWORK_ERROR,
        'Network error',
        { providerId }
      );
      expect(networkError.retryable).toBe(true);

      const authError = new ModelProviderError(
        ModelProviderErrorCode.AUTHENTICATION_FAILED,
        'Auth failed',
        { providerId }
      );
      expect(authError.retryable).toBe(false);

      const invalidRequestError = new ModelProviderError(
        ModelProviderErrorCode.INVALID_REQUEST,
        'Bad request',
        { providerId }
      );
      expect(invalidRequestError.retryable).toBe(false);
    });

    it('should preserve cause and context', () => {
      const cause = new Error('Original error');
      const context = { requestId: 'req-123' };
      const error = new ModelProviderError(
        ModelProviderErrorCode.EXECUTION_FAILED,
        'Execution failed',
        { providerId, cause, context }
      );

      expect(error.cause).toBe(cause);
      expect(error.context).toEqual(context);
    });

    it('should serialize to JSON with all properties', () => {
      const error = new ModelProviderError(
        ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
        'Rate limited',
        { providerId, modelId, retryable: true, providerErrorCode: 'RATE_LIMIT' }
      );

      const json = error.toJSON();
      expect(json.name).toBe('ModelProviderError');
      expect(json.code).toBe(ModelProviderErrorCode.RATE_LIMIT_EXCEEDED);
      expect(json.message).toBe('Rate limited');
      expect(json.providerId).toBe(providerId);
      expect(json.modelId).toBe(modelId);
      expect(json.retryable).toBe(true);
      expect(json.providerErrorCode).toBe('RATE_LIMIT');
      expect(json.stack).toBeDefined();
    });
  });

  describe('createModelProviderError', () => {
    it('should create ModelProviderError instance', () => {
      const error = createModelProviderError(
        ModelProviderErrorCode.INVALID_API_KEY,
        'Invalid key',
        { providerId }
      );

      expect(error).toBeInstanceOf(ModelProviderError);
      expect(error.code).toBe(ModelProviderErrorCode.INVALID_API_KEY);
    });
  });

  describe('isModelProviderError', () => {
    it('should return true for ModelProviderError', () => {
      const error = new ModelProviderError(ModelProviderErrorCode.EXECUTION_FAILED, 'Failed', {
        providerId,
      });
      expect(isModelProviderError(error)).toBe(true);
    });

    it('should return false for EngineError', () => {
      const error = createEngineError(EngineErrorCode.INTERNAL_ERROR, 'Internal');
      expect(isModelProviderError(error)).toBe(false);
    });

    it('should return false for regular Error', () => {
      expect(isModelProviderError(new Error('test'))).toBe(false);
    });

    it('should return false for non-Error', () => {
      expect(isModelProviderError('string')).toBe(false);
      expect(isModelProviderError(null)).toBe(false);
      expect(isModelProviderError(undefined)).toBe(false);
      expect(isModelProviderError({})).toBe(false);
    });
  });

  describe('fromError', () => {
    it('should return same error if already ModelProviderError', () => {
      const original = new ModelProviderError(ModelProviderErrorCode.TIMEOUT, 'Timeout', {
        providerId,
      });
      const result = ModelProviderError.fromError(original, providerId);
      expect(result).toBe(original);
    });

    it('should classify authentication errors', () => {
      const error = new Error('Authentication failed: invalid credentials');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.AUTHENTICATION_FAILED);
      expect(result.providerId).toBe(providerId);
    });

    it('should classify invalid API key errors', () => {
      const error = new Error('Invalid API key provided');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.INVALID_API_KEY);
    });

    it('should classify rate limit errors', () => {
      const error = new Error('Rate limit exceeded');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.RATE_LIMIT_EXCEEDED);
      expect(result.retryable).toBe(true);
    });

    it('should classify network errors', () => {
      const error = new Error('Network connection failed');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.NETWORK_ERROR);
      expect(result.retryable).toBe(true);
    });

    it('should classify timeout errors', () => {
      const error = new Error('Request timed out');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.TIMEOUT);
      expect(result.retryable).toBe(true);
    });

    it('should classify provider unavailable errors', () => {
      const error = new Error('Service unavailable');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.PROVIDER_UNAVAILABLE);
      expect(result.retryable).toBe(true);
    });

    it('should classify unsupported model errors', () => {
      const error = new Error('Model not found: gpt-5');
      const result = ModelProviderError.fromError(error, providerId, modelId);

      expect(result.code).toBe(ModelProviderErrorCode.UNSUPPORTED_MODEL);
      expect(result.modelId).toBe(modelId);
    });

    it('should classify invalid request errors', () => {
      const error = new Error('Invalid request: missing required field');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.INVALID_REQUEST);
    });

    it('should classify context length errors', () => {
      const error = new Error('Context length exceeded maximum');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED);
    });

    it('should classify quota errors', () => {
      const error = new Error('Quota exceeded for this month');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.QUOTA_EXCEEDED);
    });

    it('should classify content filter errors', () => {
      const error = new Error('Content filtered due to policy violation');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.CONTENT_FILTERED);
    });

    it('should default to EXECUTION_FAILED for unknown errors', () => {
      const error = new Error('Some unknown error occurred');
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.code).toBe(ModelProviderErrorCode.EXECUTION_FAILED);
    });

    it('should extract provider error code from error object', () => {
      const error = new Error('Rate limited');
      (error as Record<string, unknown>).code = 'RATE_LIMIT_EXCEEDED';
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.providerErrorCode).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should extract HTTP status as provider error code', () => {
      const error = new Error('Bad request');
      (error as Record<string, unknown>).status = 400;
      const result = ModelProviderError.fromError(error, providerId);

      expect(result.providerErrorCode).toBe('HTTP_400');
    });

    it('should include modelId when provided', () => {
      const error = new Error('Model not found');
      const result = ModelProviderError.fromError(error, providerId, modelId);

      expect(result.modelId).toBe(modelId);
    });
  });
});

describe('mapToEngineError', () => {
  const providerId = createProviderId('openai');
  const modelId = createProviderId('gpt-4');

  it('should map authentication errors to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.AUTHENTICATION_FAILED,
      'Auth failed',
      {
        providerId,
      }
    );
    const engineError = mapToEngineError(error);

    expect(isEngineError(engineError)).toBe(true);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map invalid API key to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.INVALID_API_KEY, 'Invalid key', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map rate limit to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.RATE_LIMIT_EXCEEDED,
      'Rate limited',
      {
        providerId,
      }
    );
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map network error to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.NETWORK_ERROR, 'Network error', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map provider unavailable to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.PROVIDER_UNAVAILABLE,
      'Unavailable',
      {
        providerId,
      }
    );
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map timeout to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.TIMEOUT, 'Timeout', { providerId });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map unsupported model to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.UNSUPPORTED_MODEL, 'Unsupported', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map model not found to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.MODEL_NOT_FOUND, 'Not found', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map invalid request to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.INVALID_REQUEST,
      'Invalid request',
      {
        providerId,
      }
    );
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map validation failed to INVALID_CONFIGURATION', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.VALIDATION_FAILED,
      'Validation failed',
      {
        providerId,
      }
    );
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
  });

  it('should map context length exceeded to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(
      ModelProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
      'Context too long',
      { providerId }
    );
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map content filtered to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.CONTENT_FILTERED, 'Filtered', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should map execution failed to INTERNAL_ERROR', () => {
    const error = new ModelProviderError(ModelProviderErrorCode.EXECUTION_FAILED, 'Failed', {
      providerId,
    });
    const engineError = mapToEngineError(error);
    expect(engineError.code).toBe(EngineErrorCode.INTERNAL_ERROR);
  });

  it('should preserve context and cause', () => {
    const cause = new Error('Original');
    const error = new ModelProviderError(ModelProviderErrorCode.NETWORK_ERROR, 'Network', {
      providerId,
      cause,
      context: { requestId: 'req-1' },
    });

    const engineError = mapToEngineError(error);
    expect(engineError.cause).toBe(cause);
    expect(engineError.context?.providerId).toBe(providerId);
    expect(engineError.context?.retryable).toBe(true);
  });
});
