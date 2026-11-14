import { describe, it, expect } from 'vitest';
import {
  createStreamStartEvent,
  createStreamDeltaEvent,
  createStreamCompleteEvent,
  createStreamErrorEvent,
  createStreamCancelEvent,
  validateStreamEvent,
  safeValidateStreamEvent,
  isStreamingProvider,
  isNonStreamingProvider,
  type StreamEvent,
  type StreamingProvider,
  type NonStreamingProvider,
} from '@nexipi/shared';
import type { ModelId, UsageStatistics } from '@nexipi/models';

describe('streaming types', () => {
  const conversationId = 'conv-123';
  const messageId = 'msg-456';
  const modelId = 'test-model' as ModelId;

  describe('createStreamStartEvent', () => {
    it('should create a stream start event', () => {
      const event = createStreamStartEvent(conversationId, messageId, modelId);

      expect(event.type).toBe('stream:start');
      expect(event.conversationId).toBe(conversationId);
      expect(event.messageId).toBe(messageId);
      expect(event.model).toBe(modelId);
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  describe('createStreamDeltaEvent', () => {
    it('should create a stream delta event', () => {
      const event = createStreamDeltaEvent(conversationId, messageId, 'Hello');

      expect(event.type).toBe('stream:delta');
      expect(event.conversationId).toBe(conversationId);
      expect(event.messageId).toBe(messageId);
      expect(event.delta).toBe('Hello');
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  describe('createStreamCompleteEvent', () => {
    it('should create a stream complete event without usage', () => {
      const event = createStreamCompleteEvent(conversationId, messageId, 'stop');

      expect(event.type).toBe('stream:complete');
      expect(event.conversationId).toBe(conversationId);
      expect(event.messageId).toBe(messageId);
      expect(event.finishReason).toBe('stop');
      expect(event.usage).toBeUndefined();
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should create a stream complete event with usage', () => {
      const usage: UsageStatistics = {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      };
      const event = createStreamCompleteEvent(conversationId, messageId, 'length', usage);

      expect(event.usage).toEqual(usage);
    });
  });

  describe('createStreamErrorEvent', () => {
    it('should create a stream error event', () => {
      const error = {
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded',
        retryable: true,
        providerErrorCode: 'RL_001',
      };
      const event = createStreamErrorEvent(conversationId, messageId, error);

      expect(event.type).toBe('stream:error');
      expect(event.conversationId).toBe(conversationId);
      expect(event.messageId).toBe(messageId);
      expect(event.error).toEqual(error);
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('should create a stream error event without providerErrorCode', () => {
      const error = {
        code: 'NETWORK_ERROR',
        message: 'Connection failed',
        retryable: true,
      };
      const event = createStreamErrorEvent(conversationId, messageId, error);

      expect(event.error.providerErrorCode).toBeUndefined();
    });
  });

  describe('createStreamCancelEvent', () => {
    it('should create a stream cancel event', () => {
      const event = createStreamCancelEvent(conversationId, messageId);

      expect(event.type).toBe('stream:cancel');
      expect(event.conversationId).toBe(conversationId);
      expect(event.messageId).toBe(messageId);
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  describe('validateStreamEvent', () => {
    it('should validate stream:start event', () => {
      const event = createStreamStartEvent(conversationId, messageId, modelId);
      const validated = validateStreamEvent(event);

      expect(validated).toEqual(event);
    });

    it('should validate stream:delta event', () => {
      const event = createStreamDeltaEvent(conversationId, messageId, 'test');
      const validated = validateStreamEvent(event);

      expect(validated).toEqual(event);
    });

    it('should validate stream:complete event', () => {
      const event = createStreamCompleteEvent(conversationId, messageId, 'stop');
      const validated = validateStreamEvent(event);

      expect(validated).toEqual(event);
    });

    it('should validate stream:error event', () => {
      const event = createStreamErrorEvent(conversationId, messageId, {
        code: 'ERROR',
        message: 'Test error',
        retryable: false,
      });
      const validated = validateStreamEvent(event);

      expect(validated).toEqual(event);
    });

    it('should validate stream:cancel event', () => {
      const event = createStreamCancelEvent(conversationId, messageId);
      const validated = validateStreamEvent(event);

      expect(validated).toEqual(event);
    });

    it('should throw on invalid event type', () => {
      const invalid = { type: 'invalid', conversationId, messageId };
      expect(() => validateStreamEvent(invalid)).toThrow();
    });
  });

  describe('safeValidateStreamEvent', () => {
    it('should return success for valid event', () => {
      const event = createStreamDeltaEvent(conversationId, messageId, 'test');
      const result = safeValidateStreamEvent(event);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(event);
      }
    });

    it('should return failure for invalid event', () => {
      const result = safeValidateStreamEvent({ type: 'invalid' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });

  describe('isStreamingProvider', () => {
    it('should return true for streaming provider', () => {
      const provider: StreamingProvider = {
        executeStream: vi.fn().mockReturnValue(
          (async function* () {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: '',
              timestamp: 0,
            };
          })()
        ),
      };

      expect(isStreamingProvider(provider)).toBe(true);
    });

    it('should return false for non-streaming provider', () => {
      const provider: NonStreamingProvider = {
        execute: vi.fn().mockResolvedValue({
          content: 'test',
          finishReason: 'stop',
        }),
      };

      expect(isStreamingProvider(provider)).toBe(false);
    });

    it('should return false for object without executeStream', () => {
      expect(isStreamingProvider({})).toBe(false);
    });

    it('should return false for null', () => {
      expect(isStreamingProvider(null as any)).toBe(false);
    });
  });

  describe('isNonStreamingProvider', () => {
    it('should return true for non-streaming provider', () => {
      const provider: NonStreamingProvider = {
        execute: vi.fn().mockResolvedValue({
          content: 'test',
          finishReason: 'stop',
        }),
      };

      expect(isNonStreamingProvider(provider)).toBe(true);
    });

    it('should return false for streaming provider', () => {
      const provider: StreamingProvider = {
        executeStream: vi.fn().mockReturnValue(
          (async function* () {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: '',
              timestamp: 0,
            };
          })()
        ),
      };

      expect(isNonStreamingProvider(provider)).toBe(false);
    });

    it('should return false for object without execute', () => {
      expect(isNonStreamingProvider({})).toBe(false);
    });
  });
});

// Need to import vi for mocking
import { vi } from 'vitest';
