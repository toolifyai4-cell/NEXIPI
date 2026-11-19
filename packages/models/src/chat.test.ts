import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatService, createChatService } from './chat.js';
import { createProviderRegistry } from './registry.js';
import {
  createProviderId,
  createModelId,
  type ModelProvider,
  type ModelMetadata,
  type ProviderHealth,
} from './types.js';
import { EngineErrorCode, isEngineError } from './errors.js';
import type { StreamEvent } from '@nexipi/core';

function createMockStreamingProvider(
  overrides: {
    metadata?: { id: string; name: string; version: string };
    models?: ModelMetadata[];
    health?: ProviderHealth;
    executeStream?: ModelProvider['execute'];
  } = {}
): ModelProvider {
  const providerId = createProviderId(overrides.metadata?.id ?? 'test-provider');
  const modelId = createModelId('test-model');

  const defaultModel: ModelMetadata = {
    providerId,
    modelId,
    displayName: 'Test Model',
    contextWindow: 4096,
    capabilities: {
      streaming: true,
      toolCalling: false,
      vision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
  };

  const defaultModels = overrides.models ?? [defaultModel];

  return {
    metadata: {
      id: providerId,
      name: overrides.metadata?.name ?? 'Test Provider',
      version: overrides.metadata?.version ?? '1.0.0',
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockReturnValue(defaultModels),
    getModel: vi.fn().mockImplementation((id: string) => defaultModels.find(m => m.modelId === id)),
    validateRequest: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    execute: vi.fn(),
    executeStream: overrides.executeStream ?? vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(
      overrides.health ?? {
        status: 'healthy',
        lastChecked: Date.now(),
        latencyMs: 100,
      }
    ),
  };
}

function createMockNonStreamingProvider(
  overrides: {
    metadata?: { id: string; name: string; version: string };
    models?: ModelMetadata[];
    health?: ProviderHealth;
    execute?: ModelProvider['execute'];
  } = {}
): ModelProvider {
  const providerId = createProviderId(overrides.metadata?.id ?? 'test-provider');
  const modelId = createModelId('test-model');

  const defaultModel: ModelMetadata = {
    providerId,
    modelId,
    displayName: 'Test Model',
    contextWindow: 4096,
    capabilities: {
      streaming: false,
      toolCalling: false,
      vision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
  };

  const defaultModels = overrides.models ?? [defaultModel];

  return {
    metadata: {
      id: providerId,
      name: overrides.metadata?.name ?? 'Test Provider',
      version: overrides.metadata?.version ?? '1.0.0',
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockReturnValue(defaultModels),
    getModel: vi.fn().mockImplementation((id: string) => defaultModels.find(m => m.modelId === id)),
    validateRequest: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    execute: overrides.execute ?? vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(
      overrides.health ?? {
        status: 'healthy',
        lastChecked: Date.now(),
        latencyMs: 100,
      }
    ),
  };
}

// Helper to create a streaming mock that properly handles AbortSignal
// Yields initial delta, then polls for abort signal, then throws AbortError
function createAbortableStreamingMock(onAbort?: () => void): ModelProvider['executeStream'] {
  return vi.fn().mockImplementation(async function* (request, signal) {
    // Yield first delta
    yield {
      type: 'stream:delta',
      conversationId: '',
      messageId: '',
      delta: 'Start ',
      timestamp: Date.now(),
    };

    // Poll for abort signal - keeps generator alive until abort
    while (!signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    if (onAbort) onAbort();
    // Throw Error with AbortError name - more reliably caught than DOMException
    const error = new Error('Aborted');
    error.name = 'AbortError';
    throw error;
  });
}

// Helper to create a streaming mock that completes after a promise resolves
function createCompletableStreamingMock(
  completePromise: Promise<void>,
  shouldError = false
): ModelProvider['executeStream'] {
  return vi.fn().mockReturnValue(
    (async function* () {
      yield {
        type: 'stream:delta',
        conversationId: '',
        messageId: '',
        delta: 'Start ',
        timestamp: Date.now(),
      };
      await completePromise;
      if (shouldError) {
        yield {
          type: 'stream:error',
          conversationId: '',
          messageId: '',
          error: { code: 'ERROR', message: 'Failed', retryable: true },
          timestamp: Date.now(),
        };
      } else {
        yield {
          type: 'stream:complete',
          conversationId: '',
          messageId: '',
          finishReason: 'stop',
          timestamp: Date.now(),
        };
      }
    })()
  );
}

// Helper for mocks that yield multiple deltas then complete
function createMultiDeltaMock(
  deltas: string[],
  completePromise: Promise<void>
): ModelProvider['executeStream'] {
  return vi.fn().mockReturnValue(
    (async function* () {
      for (const delta of deltas) {
        yield {
          type: 'stream:delta',
          conversationId: '',
          messageId: '',
          delta,
          timestamp: Date.now(),
        };
      }
      await completePromise;
      yield {
        type: 'stream:complete',
        conversationId: '',
        messageId: '',
        finishReason: 'stop',
        timestamp: Date.now(),
      };
    })()
  );
}

// Helper for mocks that wait for abort after each yield
function createAbortCheckingMock(
  deltas: string[],
  completePromise: Promise<void>
): ModelProvider['executeStream'] {
  return vi.fn().mockImplementation(async function* (request, signal) {
    for (const delta of deltas) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      yield {
        type: 'stream:delta',
        conversationId: '',
        messageId: '',
        delta,
        timestamp: Date.now(),
      };
      // Check abort after each yield
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    await completePromise;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    yield {
      type: 'stream:complete',
      conversationId: '',
      messageId: '',
      finishReason: 'stop',
      timestamp: Date.now(),
    };
  });
}

describe('ChatService', () => {
  let chatService: ChatService;
  let providerRegistry: ReturnType<typeof createProviderRegistry>;
  let mockStreamingProvider: ModelProvider;
  let mockNonStreamingProvider: ModelProvider;
  const providerId = createProviderId('test-provider');
  const modelId = createModelId('test-model');

  beforeEach(() => {
    providerRegistry = createProviderRegistry();
    mockStreamingProvider = createMockStreamingProvider({
      metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
    });
    mockNonStreamingProvider = createMockNonStreamingProvider({
      metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
    });

    chatService = createChatService({
      providerRegistry,
      defaultProvider: providerId,
      defaultModel: modelId,
    });
  });

  afterEach(async () => {
    await chatService.dispose();
  });

  describe('Conversation management', () => {
    it('should create a conversation', () => {
      const conversation = chatService.createConversation('Test Chat');

      expect(conversation.id).toBeDefined();
      expect(conversation.title).toBe('Test Chat');
      expect(conversation.createdAt).toBeGreaterThan(0);
      expect(conversation.updatedAt).toBe(conversation.createdAt);
    });

    it('should create conversation with default title', () => {
      const conversation = chatService.createConversation();

      expect(conversation.title).toBe('New Conversation');
    });

    it('should get a conversation by ID', () => {
      const created = chatService.createConversation('Test');
      const found = chatService.getConversation(created.id);

      expect(found).toEqual(created);
    });

    it('should return undefined for non-existent conversation', () => {
      const found = chatService.getConversation('non-existent' as any);
      expect(found).toBeUndefined();
    });

    it('should list conversations sorted by updatedAt descending', async () => {
      const conv1 = chatService.createConversation('First');
      await new Promise(resolve => setTimeout(resolve, 10));
      const conv2 = chatService.createConversation('Second');

      const list = chatService.listConversations();

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(conv2.id);
      expect(list[1].id).toBe(conv1.id);
    });

    it('should update conversation title', async () => {
      const conversation = chatService.createConversation('Original');
      await new Promise(resolve => setTimeout(resolve, 10));
      const updated = chatService.updateConversationTitle(conversation.id, 'Updated');

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated');
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt);
    });

    it('should return undefined when updating non-existent conversation', () => {
      const updated = chatService.updateConversationTitle('non-existent' as any, 'New Title');
      expect(updated).toBeUndefined();
    });

    it('should delete a conversation', () => {
      const conversation = chatService.createConversation('To Delete');
      const deleted = chatService.deleteConversation(conversation.id);

      expect(deleted).toBe(true);
      expect(chatService.getConversation(conversation.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent conversation', () => {
      const deleted = chatService.deleteConversation('non-existent' as any);
      expect(deleted).toBe(false);
    });

    it('should emit conversation events', () => {
      const createdListener = vi.fn();
      const updatedListener = vi.fn();
      const deletedListener = vi.fn();

      chatService.on('conversation:created', createdListener);
      chatService.on('conversation:updated', updatedListener);
      chatService.on('conversation:deleted', deletedListener);

      const conversation = chatService.createConversation('Event Test');
      chatService.updateConversationTitle(conversation.id, 'Updated');
      chatService.deleteConversation(conversation.id);

      expect(createdListener).toHaveBeenCalledOnce();
      expect(updatedListener).toHaveBeenCalledOnce();
      expect(deletedListener).toHaveBeenCalledOnce();
    });
  });

  describe('Message management', () => {
    let conversationId: any;

    beforeEach(() => {
      conversationId = chatService.createConversation('Message Test').id;
    });

    it('should add a user message', () => {
      const message = chatService.addMessage(conversationId, 'user', 'Hello', 'completed');

      expect(message).toBeDefined();
      expect(message?.role).toBe('user');
      expect(message?.content).toBe('Hello');
      expect(message?.status).toBe('completed');
    });

    it('should add an assistant message', () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Hi there', 'pending');

      expect(message?.role).toBe('assistant');
      expect(message?.status).toBe('pending');
    });

    it('should return undefined for non-existent conversation', () => {
      const message = chatService.addMessage('non-existent' as any, 'user', 'Hello');
      expect(message).toBeUndefined();
    });

    it('should get messages for conversation', () => {
      chatService.addMessage(conversationId, 'user', 'First');
      chatService.addMessage(conversationId, 'assistant', 'Second');
      chatService.addMessage(conversationId, 'user', 'Third');

      const messages = chatService.getMessages(conversationId);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('should return empty array for non-existent conversation', () => {
      const messages = chatService.getMessages('non-existent' as any);
      expect(messages).toEqual([]);
    });

    it('should get a specific message', () => {
      const message = chatService.addMessage(conversationId, 'user', 'Find me');
      const found = chatService.getMessage(conversationId, message!.id);

      expect(found).toEqual(message);
    });

    it('should return undefined for non-existent message', () => {
      const found = chatService.getMessage(conversationId, 'non-existent' as any);
      expect(found).toBeUndefined();
    });

    it('should update a message', () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Original', 'streaming');
      const updated = chatService.updateMessage(conversationId, message!.id, {
        content: 'Updated',
        status: 'completed',
      });

      expect(updated).toBeDefined();
      expect(updated?.content).toBe('Updated');
      expect(updated?.status).toBe('completed');
    });

    it('should merge metadata when updating', () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Test', 'pending', {
        a: 1,
      });
      const updated = chatService.updateMessage(conversationId, message!.id, {
        metadata: { b: 2 },
      });

      expect(updated?.metadata).toEqual({ a: 1, b: 2 });
    });

    it('should delete a message', () => {
      const message = chatService.addMessage(conversationId, 'user', 'Delete me');
      const deleted = chatService.deleteMessage(conversationId, message!.id);

      expect(deleted).toBe(true);
      expect(chatService.getMessage(conversationId, message!.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent message', () => {
      const deleted = chatService.deleteMessage(conversationId, 'non-existent' as any);
      expect(deleted).toBe(false);
    });

    it('should emit message events', () => {
      const createdListener = vi.fn();
      const updatedListener = vi.fn();
      const deletedListener = vi.fn();

      chatService.on('message:created', createdListener);
      chatService.on('message:updated', updatedListener);
      chatService.on('message:deleted', deletedListener);

      const message = chatService.addMessage(conversationId, 'user', 'Event Test');
      chatService.updateMessage(conversationId, message!.id, { content: 'Updated' });
      chatService.deleteMessage(conversationId, message!.id);

      expect(createdListener).toHaveBeenCalledOnce();
      expect(updatedListener).toHaveBeenCalledOnce();
      expect(deletedListener).toHaveBeenCalledOnce();
    });
  });

  describe('Conversation state', () => {
    it('should return conversation state', () => {
      const conversation = chatService.createConversation('State Test');
      chatService.addMessage(conversation.id, 'user', 'Hello');
      chatService.addMessage(conversation.id, 'assistant', 'Generating...', 'streaming');

      const state = chatService.getConversationState(conversation.id);

      expect(state).toBeDefined();
      expect(state?.conversation.id).toBe(conversation.id);
      expect(state?.messages).toHaveLength(2);
      expect(state?.activeMessageId).toBeDefined();
      expect(state?.isLoading).toBe(true);
    });

    it('should return undefined for non-existent conversation', () => {
      const state = chatService.getConversationState('non-existent' as any);
      expect(state).toBeUndefined();
    });

    it('should detect loading state correctly', () => {
      const conversation = chatService.createConversation('Loading Test');
      chatService.addMessage(conversation.id, 'user', 'Hello', 'completed');

      let state = chatService.getConversationState(conversation.id);
      expect(state?.isLoading).toBe(false);

      chatService.addMessage(conversation.id, 'assistant', '', 'pending');
      state = chatService.getConversationState(conversation.id);
      expect(state?.isLoading).toBe(true);

      chatService.updateMessage(conversation.id, state!.activeMessageId!, { status: 'completed' });
      state = chatService.getConversationState(conversation.id);
      expect(state?.isLoading).toBe(false);
    });

    it('should capture error from failed message', () => {
      const conversation = chatService.createConversation('Error Test');
      chatService.addMessage(conversation.id, 'user', 'Hello');
      const failedMsg = chatService.addMessage(
        conversation.id,
        'assistant',
        'Error occurred',
        'failed',
        {
          error: { code: 'TEST', message: 'Test error', retryable: false },
        }
      );

      const state = chatService.getConversationState(conversation.id);

      expect(state?.error).toBe('Error occurred');
    });
  });

  describe('Streaming with streaming provider', () => {
    let conversationId: any;
    let messageId: any;

    beforeEach(() => {
      providerRegistry.register(mockStreamingProvider);
      conversationId = chatService.createConversation('Stream Test').id;
      messageId = chatService.addMessage(conversationId, 'user', 'Hello')!.id;
    });

    it('should send message and return assistant message ID', async () => {
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Hello',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: ' world',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Hello');

      expect(assistantMessageId).toBeDefined();
      expect(typeof assistantMessageId).toBe('string');
    });

    it('should stream deltas and update message content progressively', async () => {
      const deltas = ['Hello', ' ', 'world', '!'];
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          for (const delta of deltas) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta,
              timestamp: Date.now(),
            };
          }
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');

      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.content).toBe('Hello world!');
      expect(finalMessage?.status).toBe('completed');
    });

    it('should emit stream events', async () => {
      const streamEventListener = vi.fn();
      chatService.on('stream:event', streamEventListener);

      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Test',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(streamEventListener).toHaveBeenCalled();
      const eventTypes = streamEventListener.mock.calls.map((call: any) => call[0].event.type);
      expect(eventTypes).toContain('stream:start');
      expect(eventTypes).toContain('stream:delta');
      expect(eventTypes).toContain('stream:complete');
    });

    it('should handle stream error', async () => {
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Partial',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:error',
            conversationId: '',
            messageId: '',
            error: { code: 'RATE_LIMIT', message: 'Rate limited', retryable: true },
            timestamp: Date.now(),
          };
        })()
      );

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('failed');
      expect(finalMessage?.metadata?.error).toBeDefined();
    });

    it('should include usage in completed message metadata', async () => {
      const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Test',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            usage,
            timestamp: Date.now(),
          };
        })()
      );

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.metadata?.usage).toEqual(usage);
    });
  });

  describe('Non-streaming provider fallback', () => {
    let conversationId: any;

    beforeEach(() => {
      providerRegistry.register(mockNonStreamingProvider);
      conversationId = chatService.createConversation('NonStream Test').id;
    });

    it('should work with non-streaming provider', async () => {
      mockNonStreamingProvider.execute = vi.fn().mockResolvedValue({
        id: 'response-1',
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Non-streaming response' },
            finishReason: 'stop',
          },
        ],
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        finishReason: 'stop',
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.content).toBe('Non-streaming response');
      expect(finalMessage?.status).toBe('completed');
      expect(finalMessage?.metadata?.usage).toEqual({
        promptTokens: 5,
        completionTokens: 10,
        totalTokens: 15,
      });
    });
  });

  describe('Cancellation', () => {
    let conversationId: any;

    beforeEach(() => {
      providerRegistry.register(mockStreamingProvider);
      conversationId = chatService.createConversation('Cancel Test').id;
    });

    it('should cancel active stream', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      chatService.cancelActiveStream(conversationId);
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });

    it('should cancel specific message', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      const cancelled = chatService.cancelMessage(assistantMessageId);
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(cancelled).toBe(true);
      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });

    it('should return false when cancelling non-active message', () => {
      const cancelled = chatService.cancelMessage('non-existent' as any);
      expect(cancelled).toBe(false);
    });

    it('should emit stream:cancel event on cancellation', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      const cancelListener = vi.fn();
      chatService.on('stream:event', cancelListener);

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      chatService.cancelMessage(assistantMessageId);
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const cancelEvents = cancelListener.mock.calls
        .map((call: any) => call[0].event)
        .filter((e: StreamEvent) => e.type === 'stream:cancel');
      expect(cancelEvents).toHaveLength(1);
    });
  });

  describe('Retry', () => {
    let conversationId: any;

    beforeEach(() => {
      providerRegistry.register(mockStreamingProvider);
      conversationId = chatService.createConversation('Retry Test').id;
      chatService.addMessage(conversationId, 'user', 'Original question');
    });

    it('should retry failed message', async () => {
      const failedMessage = chatService.addMessage(conversationId, 'assistant', 'Error', 'failed');
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Retry',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      const newMessageId = await chatService.retryMessage(conversationId, failedMessage!.id);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(newMessageId).toBeDefined();
      const newMessage = chatService.getMessage(conversationId, newMessageId!);
      expect(newMessage?.status).toBe('completed');
      expect(newMessage?.content).toBe('Retry');
    });

    it('should retry cancelled message', async () => {
      const cancelledMessage = chatService.addMessage(
        conversationId,
        'assistant',
        'Cancelled',
        'cancelled'
      );
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Retry',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      const newMessageId = chatService.retryMessage(conversationId, cancelledMessage!.id);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(newMessageId).toBeDefined();
    });

    it('should return undefined for completed message', async () => {
      const completedMessage = chatService.addMessage(
        conversationId,
        'assistant',
        'Done',
        'completed'
      );
      const newMessageId = await chatService.retryMessage(conversationId, completedMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for streaming message', async () => {
      const streamingMessage = chatService.addMessage(
        conversationId,
        'assistant',
        'Generating',
        'streaming'
      );
      const newMessageId = await chatService.retryMessage(conversationId, streamingMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for user message', async () => {
      const userMessage = chatService.addMessage(conversationId, 'user', 'Question');
      const newMessageId = await chatService.retryMessage(conversationId, userMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for non-existent message', async () => {
      const newMessageId = await chatService.retryMessage(conversationId, 'non-existent' as any);
      expect(newMessageId).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should throw when conversation not found', async () => {
      await expect(chatService.sendMessage('non-existent' as any, 'Test')).rejects.toThrow();
    });

    it('should handle missing provider', async () => {
      const service = createChatService({ defaultModel: modelId });
      const testConvId = service.createConversation('Test').id;
      const assistantMessageId = await service.sendMessage(testConvId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = service.getMessages(testConvId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle missing model', async () => {
      const service = createChatService({ defaultProvider: providerId });
      const testConvId = service.createConversation('Test').id;
      const assistantMessageId = await service.sendMessage(testConvId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = service.getMessages(testConvId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle provider not found', async () => {
      providerRegistry.register(mockStreamingProvider);
      const service = createChatService({
        providerRegistry,
        defaultProvider: createProviderId('non-existent'),
        defaultModel: modelId,
      });
      const testConvId = service.createConversation('Test').id;
      const assistantMessageId = await service.sendMessage(testConvId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = service.getMessages(testConvId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle model not found in provider', async () => {
      providerRegistry.register(mockStreamingProvider);
      const service = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: createModelId('non-existent-model'),
      });
      const testConvId = service.createConversation('Test').id;
      const assistantMessageId = await service.sendMessage(testConvId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = service.getMessages(testConvId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('failed');
    });
  });

  describe('History building', () => {
    let conversationId: any;

    beforeEach(() => {
      providerRegistry.register(mockStreamingProvider);
      conversationId = chatService.createConversation('History Test').id;
    });

    it('should build model messages from conversation history', async () => {
      chatService.addMessage(conversationId, 'user', 'First', 'completed');
      chatService.addMessage(conversationId, 'assistant', 'First response', 'completed');
      chatService.addMessage(conversationId, 'user', 'Second', 'completed');
      chatService.addMessage(conversationId, 'assistant', 'Second response', 'completed');
      chatService.addMessage(conversationId, 'user', 'Third', 'completed');

      let capturedRequest: any;
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Response',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      await chatService.sendMessage(conversationId, 'Third');
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockStreamingProvider.executeStream).toHaveBeenCalled();
      const call = mockStreamingProvider.executeStream.mock.calls[0];
      capturedRequest = call[0];
      expect(capturedRequest.messages).toHaveLength(7);
    });

    it('should respect maxHistoryLength', async () => {
      const service = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        maxHistoryLength: 2,
      });
      const testConvId = service.createConversation('History Test').id;

      for (let i = 0; i < 10; i++) {
        service.addMessage(testConvId, 'user', `Question ${i}`, 'completed');
        service.addMessage(testConvId, 'assistant', `Answer ${i}`, 'completed');
      }

      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Response',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      await service.sendMessage(testConvId, 'Final');
      await new Promise(resolve => setTimeout(resolve, 50));

      const call = mockStreamingProvider.executeStream.mock.calls[0];
      const request = call[0];
      expect(request.messages.length).toBeLessThanOrEqual(5);
    });

    it('should include system prompt when provided', async () => {
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Response',
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        })()
      );

      await chatService.sendMessage(conversationId, 'Test', {
        systemPrompt: 'You are a helpful assistant',
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      const call = mockStreamingProvider.executeStream.mock.calls[0];
      const request = call[0];
      expect(request.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant',
      });
    });
  });

  describe('Dispose', () => {
    beforeEach(() => {
      providerRegistry.register(mockStreamingProvider);
    });

    it('should cancel all active streams on dispose', async () => {
      let abortTriggered = false;
      mockStreamingProvider.executeStream = createAbortableStreamingMock(() => {
        abortTriggered = true;
      });

      const conversationId = chatService.createConversation('Dispose Test').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      await chatService.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
      expect(abortTriggered).toBe(true);
    });

    it('should handle disposal while stream is active (regression test 1)', async () => {
      let abortTriggered = false;
      mockStreamingProvider.executeStream = createAbortableStreamingMock(() => {
        abortTriggered = true;
      });

      const conversationId = chatService.createConversation('Dispose Active').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
      expect(abortTriggered).toBe(true);
    });

    it('should handle provider throwing AbortError after disposal begins (regression test 2)', async () => {
      let abortTriggered = false;
      mockStreamingProvider.executeStream = createAbortableStreamingMock(() => {
        abortTriggered = true;
      });

      const conversationId = chatService.createConversation('Dispose AbortError').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
      expect(abortTriggered).toBe(true);
    });

    it('should handle provider throwing unrelated error after disposal begins (regression test 3)', async () => {
      let disposalStarted = false;
      let disposalComplete = false;

      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Start',
            timestamp: Date.now(),
          };
          // Wait for disposal to start
          await new Promise<void>(resolve => {
            const checkDisposal = () => {
              if (disposalStarted) {
                disposalComplete = true;
                resolve();
              } else {
                setTimeout(checkDisposal, 10);
              }
            };
            checkDisposal();
          });
          // This error occurs AFTER disposal has marked the message cancelled
          throw new Error('Late provider error after disposal');
        })()
      );

      const conversationId = chatService.createConversation('Dispose Late Error').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      disposalStarted = true;
      await chatService.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      // Late error after disposal should not overwrite cancelled status
      expect(finalMessage?.status).toBe('cancelled');
      expect(disposalComplete).toBe(true);
    });

    it('should handle provider resolving after cancellation (regression test 4)', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const conversationId = chatService.createConversation('Dispose Late Complete').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });

    it('should handle repeated disposal (regression test 5)', async () => {
      let abortTriggered = false;
      mockStreamingProvider.executeStream = createAbortableStreamingMock(() => {
        abortTriggered = true;
      });

      const conversationId = chatService.createConversation('Repeated Dispose').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      await chatService.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
      expect(chatService.isDisposed()).toBe(true);
    });

    it('should handle multiple active requests during disposal (regression test 6)', async () => {
      const service = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        concurrencyPolicy: 'allow-all',
      });

      let requestCount = 0;
      let abortTriggered1 = false;
      let abortTriggered2 = false;

      mockStreamingProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };

          while (!signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }

          if (thisRequest === 1) abortTriggered1 = true;
          else abortTriggered2 = true;
          const error = new Error('Aborted');
          error.name = 'AbortError';
          throw error;
        });

      const conversationId = service.createConversation('Multi Request Dispose').id;
      const msgId1 = await service.sendMessage(conversationId, 'Test 1');
      const msgId2 = await service.sendMessage(conversationId, 'Test 2');
      await new Promise(resolve => setTimeout(resolve, 10));

      await service.dispose();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage1 = service.getMessage(conversationId, msgId1);
      const finalMessage2 = service.getMessage(conversationId, msgId2);
      expect(finalMessage1?.status).toBe('cancelled');
      expect(finalMessage2?.status).toBe('cancelled');
      expect(service.isDisposed()).toBe(true);

      await service.dispose();
    });

    it('should distinguish genuine provider error from intentional cancellation during disposal', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Start',
            timestamp: Date.now(),
          };
          await completePromise;
          throw new Error('Genuine provider error after dispose');
        })()
      );

      const conversationId = chatService.createConversation('Dispose Genuine Error').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 50));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });
  });

  describe('Concurrency Policy: allow-all', () => {
    let allowAllService: ChatService;
    let allowAllRegistry: ReturnType<typeof createProviderRegistry>;
    let allowAllProvider: ModelProvider;

    beforeEach(() => {
      allowAllRegistry = createProviderRegistry();
      allowAllProvider = createMockStreamingProvider({
        metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
      });
      allowAllRegistry.register(allowAllProvider);

      allowAllService = createChatService({
        providerRegistry: allowAllRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        concurrencyPolicy: 'allow-all',
      });
    });

    afterEach(async () => {
      await allowAllService.dispose();
    });

    it('should allow multiple concurrent requests in same conversation', async () => {
      const conversationId = allowAllService.createConversation('Allow All Test').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      allowAllProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          if (thisRequest === 1) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'First ',
              timestamp: Date.now(),
            };
            await firstPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } else {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Second ',
              timestamp: Date.now(),
            };
            await secondPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          }
        });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      const msg1 = allowAllService.getMessage(conversationId, msgId1);
      const msg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(msg1?.status).toBe('streaming');
      expect(msg2?.status).toBe('streaming');

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg1 = allowAllService.getMessage(conversationId, msgId1);
      const finalMsg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(finalMsg1?.status).toBe('completed');
      expect(finalMsg2?.status).toBe('completed');
      expect(finalMsg1?.content).toBe('First ');
      expect(finalMsg2?.content).toBe('Second ');
    });

    it('should retain independent request IDs, message IDs, and cancellation controllers', async () => {
      const conversationId = allowAllService.createConversation('Independent Requests').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      allowAllProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          if (thisRequest === 1) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'First ',
              timestamp: Date.now(),
            };
            await firstPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } else {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Second ',
              timestamp: Date.now(),
            };
            await secondPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          }
        });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(msgId1).not.toBe(msgId2);

      const msg1 = allowAllService.getMessage(conversationId, msgId1);
      const msg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(msg1?.status).toBe('streaming');
      expect(msg2?.status).toBe('streaming');

      allowAllService.cancelMessage(msgId1);
      await new Promise(resolve => setTimeout(resolve, 10));

      const cancelledMsg1 = allowAllService.getMessage(conversationId, msgId1);
      const stillStreamingMsg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(cancelledMsg1?.status).toBe('cancelled');
      expect(stillStreamingMsg2?.status).toBe('streaming');

      resolveFirst!();
      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(finalMsg2?.status).toBe('completed');
    });

    it('should not mistake stream deltas from one request for another', async () => {
      const conversationId = allowAllService.createConversation('Delta Isolation').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      allowAllProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          if (thisRequest === 1) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Request1-Part1 ',
              timestamp: Date.now(),
            };
            await firstPromise;
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Request1-Part2',
              timestamp: Date.now(),
            };
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } else {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Request2-Part1 ',
              timestamp: Date.now(),
            };
            await secondPromise;
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Request2-Part2',
              timestamp: Date.now(),
            };
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          }
        });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg1 = allowAllService.getMessage(conversationId, msgId1);
      const finalMsg2 = allowAllService.getMessage(conversationId, msgId2);

      expect(finalMsg1?.content).toBe('Request1-Part1 Request1-Part2');
      expect(finalMsg2?.content).toBe('Request2-Part1 Request2-Part2');
    });

    it('should not invalidate other active requests when one completes', async () => {
      const conversationId = allowAllService.createConversation('Completion Isolation').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      allowAllProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          if (thisRequest === 1) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'First ',
              timestamp: Date.now(),
            };
            await firstPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } else {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Second ',
              timestamp: Date.now(),
            };
            await secondPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          }
        });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const msg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(msg2?.status).toBe('streaming');

      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg1 = allowAllService.getMessage(conversationId, msgId1);
      const finalMsg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(finalMsg1?.status).toBe('completed');
      expect(finalMsg2?.status).toBe('completed');
    });

    it('should not overwrite another request message status on error', async () => {
      const conversationId = allowAllService.createConversation('Error Isolation').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      allowAllProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          const thisRequest = ++requestCount;
          if (thisRequest === 1) {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'First ',
              timestamp: Date.now(),
            };
            await firstPromise;
            yield {
              type: 'stream:error',
              conversationId: '',
              messageId: '',
              error: { code: 'ERROR', message: 'Failed', retryable: true },
              timestamp: Date.now(),
            };
          } else {
            yield {
              type: 'stream:delta',
              conversationId: '',
              messageId: '',
              delta: 'Second ',
              timestamp: Date.now(),
            };
            await secondPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          }
        });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg1 = allowAllService.getMessage(conversationId, msgId1);
      const finalMsg2 = allowAllService.getMessage(conversationId, msgId2);
      expect(finalMsg1?.status).toBe('failed');
      expect(finalMsg2?.status).toBe('completed');
    });
  });

  describe('Concurrency Policy: queue', () => {
    let queueService: ChatService;
    let queueRegistry: ReturnType<typeof createProviderRegistry>;
    let queueProvider: ModelProvider;

    beforeEach(() => {
      queueRegistry = createProviderRegistry();
      queueProvider = createMockStreamingProvider({
        metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
      });
      queueRegistry.register(queueProvider);

      queueService = createChatService({
        providerRegistry: queueRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        concurrencyPolicy: 'queue',
      });
    });

    afterEach(async () => {
      await queueService.dispose();
    });

    it('should execute requests sequentially in submission order', async () => {
      const conversationId = queueService.createConversation('Queue Order').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      let resolveThird: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });
      const thirdPromise = new Promise<void>(resolve => {
        resolveThird = resolve;
      });

      const executionOrder: number[] = [];
      let requestCount = 0;

      queueProvider.executeStream = vi.fn().mockImplementation(async function* (request, signal) {
        const thisRequest = ++requestCount;
        executionOrder.push(thisRequest);
        if (thisRequest === 1) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };
          await firstPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        } else if (thisRequest === 2) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };
          await secondPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        } else {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };
          await thirdPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        }
      });

      // First request executes immediately
      const msgId1 = await queueService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(queueService.getMessage(conversationId, msgId1)?.status).toBe('streaming');

      // Second request gets queued
      const p2 = queueService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Third request gets queued
      const p3 = queueService.sendMessage(conversationId, 'Third');
      await new Promise(resolve => setTimeout(resolve, 10));

      // At this point, only first message exists (streaming), others are queued
      const messages = queueService.getMessages(conversationId);
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBe(1); // Only first assistant message created so far

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second request should now be executing
      const messagesAfterFirst = queueService.getMessages(conversationId);
      const assistantMessagesAfterFirst = messagesAfterFirst.filter(m => m.role === 'assistant');
      expect(assistantMessagesAfterFirst.length).toBe(2);
      const msgId2 = assistantMessagesAfterFirst[1].id;
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('streaming');

      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Third request should now be executing
      const messagesAfterSecond = queueService.getMessages(conversationId);
      const assistantMessagesAfterSecond = messagesAfterSecond.filter(m => m.role === 'assistant');
      expect(assistantMessagesAfterSecond.length).toBe(3);
      const msgId3 = assistantMessagesAfterSecond[2].id;
      expect(queueService.getMessage(conversationId, msgId3)?.status).toBe('streaming');

      resolveThird!();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(queueService.getMessage(conversationId, msgId1)?.status).toBe('completed');
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('completed');
      expect(queueService.getMessage(conversationId, msgId3)?.status).toBe('completed');
      expect(executionOrder).toEqual([1, 2, 3]);

      await p2;
      await p3;
    });

    it('should allow cancellation of a queued request', async () => {
      const conversationId = queueService.createConversation('Queue Cancel').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      let resolveThird: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });
      const thirdPromise = new Promise<void>(resolve => {
        resolveThird = resolve;
      });

      let requestCount = 0;
      queueProvider.executeStream = vi.fn().mockImplementation(async function* (request, signal) {
        const thisRequest = ++requestCount;
        if (thisRequest === 1) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'First ',
            timestamp: Date.now(),
          };
          await firstPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        } else if (thisRequest === 2) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Second ',
            timestamp: Date.now(),
          };
          await secondPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        } else {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Third ',
            timestamp: Date.now(),
          };
          await thirdPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        }
      });

      const msgId1 = await queueService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(queueService.getMessage(conversationId, msgId1)?.status).toBe('streaming');

      // Queue second request
      const p2 = queueService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Third request also queued
      const p3 = queueService.sendMessage(conversationId, 'Third');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Only first assistant message exists
      const messages = queueService.getMessages(conversationId);
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBe(1);

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second request now executing
      const messagesAfterFirst = queueService.getMessages(conversationId);
      const assistantMessagesAfterFirst = messagesAfterFirst.filter(m => m.role === 'assistant');
      expect(assistantMessagesAfterFirst.length).toBe(2);
      const msgId2 = assistantMessagesAfterFirst[1].id;
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('streaming');

      // Cancel the second request (now executing)
      const cancelled = queueService.cancelMessage(msgId2);
      expect(cancelled).toBe(true);
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('cancelled');
      expect(queueService.getMessage(conversationId, msgId1)?.status).toBe('completed');

      // Third request should now execute
      await new Promise(resolve => setTimeout(resolve, 10));
      const messagesAfterSecond = queueService.getMessages(conversationId);
      const assistantMessagesAfterSecond = messagesAfterSecond.filter(m => m.role === 'assistant');
      expect(assistantMessagesAfterSecond.length).toBe(3);
      const msgId3 = assistantMessagesAfterSecond[2].id;
      expect(queueService.getMessage(conversationId, msgId3)?.status).toBe('streaming');

      // Complete third
      resolveThird!();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(queueService.getMessage(conversationId, msgId3)?.status).toBe('completed');

      // Clean up
      resolveSecond!(); // In case it's still pending
      await p2;
      await p3;
    });

    it('should not permanently block queue on failed request', async () => {
      const conversationId = queueService.createConversation('Queue Failed').id;

      let resolveSecond: () => void;
      const secondPromise = new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

      let requestCount = 0;
      queueProvider.executeStream = vi.fn().mockImplementation(async function* (request, signal) {
        const thisRequest = ++requestCount;
        if (thisRequest === 1) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };
          yield {
            type: 'stream:error',
            conversationId: '',
            messageId: '',
            error: { code: 'ERROR', message: 'Failed', retryable: true },
            timestamp: Date.now(),
          };
        } else {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: `Req${thisRequest} `,
            timestamp: Date.now(),
          };
          await secondPromise;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          yield {
            type: 'stream:complete',
            conversationId: '',
            messageId: '',
            finishReason: 'stop',
            timestamp: Date.now(),
          };
        }
      });

      const msgId1 = await queueService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      const p2 = queueService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      await new Promise(resolve => setTimeout(resolve, 50));

      const failedMsg = queueService.getMessage(conversationId, msgId1);
      expect(failedMsg?.status).toBe('failed');

      // Second request should now be executing
      const messages = queueService.getMessages(conversationId);
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBe(2);
      const msgId2 = assistantMessages[1].id;
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('streaming');

      // Complete second
      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(queueService.getMessage(conversationId, msgId2)?.status).toBe('completed');

      await p2;
    });
  });

  describe('Concurrency Policy: cancel-previous', () => {
    let cancelPreviousService: ChatService;
    let cancelPreviousRegistry: ReturnType<typeof createProviderRegistry>;
    let cancelPreviousProvider: ModelProvider;

    beforeEach(() => {
      cancelPreviousRegistry = createProviderRegistry();
      cancelPreviousProvider = createMockStreamingProvider({
        metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
      });
      cancelPreviousRegistry.register(cancelPreviousProvider);

      cancelPreviousService = createChatService({
        providerRegistry: cancelPreviousRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        concurrencyPolicy: 'cancel-previous',
      });
    });

    afterEach(async () => {
      await cancelPreviousService.dispose();
    });

    it('should cancel previous request before replacement updates conversation', async () => {
      const conversationId = cancelPreviousService.createConversation('Cancel Previous').id;

      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      let firstCompleted = false;

      cancelPreviousProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'First ',
            timestamp: Date.now(),
          };
          try {
            await firstPromise;
            firstCompleted = true;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } catch {
            throw new DOMException('Aborted', 'AbortError');
          }
        });

      const msgId1 = await cancelPreviousService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      const msgId2 = await cancelPreviousService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(cancelPreviousService.getMessage(conversationId, msgId1)?.status).toBe('cancelled');
      expect(cancelPreviousService.getMessage(conversationId, msgId2)?.status).toBe('streaming');
      expect(firstCompleted).toBe(false);
    });

    it('should ignore late chunks from previous request', async () => {
      const conversationId = cancelPreviousService.createConversation('Late Chunks').id;

      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      cancelPreviousProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'First-Part1 ',
            timestamp: Date.now(),
          };
          try {
            await firstPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            // This late chunk should not be processed because request was cancelled
            if (!signal.aborted) {
              yield {
                type: 'stream:delta',
                conversationId: '',
                messageId: '',
                delta: 'First-Part2-LATE ',
                timestamp: Date.now(),
              };
            }
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } catch {
            throw new DOMException('Aborted', 'AbortError');
          }
        });

      const msgId1 = await cancelPreviousService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      const msgId2 = await cancelPreviousService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const finalMsg1 = cancelPreviousService.getMessage(conversationId, msgId1);
      expect(finalMsg1?.status).toBe('cancelled');
      expect(finalMsg1?.content).toBe('First-Part1 ');
    });

    it('should handle conversation deletion during execution', async () => {
      const conversationId = cancelPreviousService.createConversation('Delete During Exec').id;

      let resolveFirst: () => void;
      const firstPromise = new Promise<void>(resolve => {
        resolveFirst = resolve;
      });

      cancelPreviousProvider.executeStream = vi
        .fn()
        .mockImplementation(async function* (request, signal) {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'First ',
            timestamp: Date.now(),
          };
          try {
            await firstPromise;
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            yield {
              type: 'stream:complete',
              conversationId: '',
              messageId: '',
              finishReason: 'stop',
              timestamp: Date.now(),
            };
          } catch {
            throw new DOMException('Aborted', 'AbortError');
          }
        });

      const msgId1 = await cancelPreviousService.sendMessage(conversationId, 'First');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Delete conversation while request is executing
      const deleted = cancelPreviousService.deleteConversation(conversationId);
      expect(deleted).toBe(true);

      // The stream should be cancelled
      await new Promise(resolve => setTimeout(resolve, 10));
      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Conversation should be gone
      expect(cancelPreviousService.getConversation(conversationId)).toBeUndefined();
    });
  });
});
