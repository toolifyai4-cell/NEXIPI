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

    it('should list conversations sorted by updatedAt descending', () => {
      const conv1 = chatService.createConversation('First');
      const conv2 = chatService.createConversation('Second');

      const list = chatService.listConversations();

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(conv2.id);
      expect(list[1].id).toBe(conv1.id);
    });

    it('should update conversation title', () => {
      const conversation = chatService.createConversation('Original');
      const updated = chatService.updateConversationTitle(conversation.id, 'Updated');

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated');
      expect(updated?.updatedAt).toBeGreaterThan(conversation.updatedAt);
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
      chatService.addMessage(conversation.id, 'user', 'Hello');

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
      let yieldCount = 0;
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

      // Wait for stream to complete
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
        content: 'Non-streaming response',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
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
        })()
      );

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

      const newMessageId = chatService.retryMessage(conversationId, failedMessage!.id);
      await new Promise(resolve => setTimeout(resolve, 50));

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

    it('should return undefined for completed message', () => {
      const completedMessage = chatService.addMessage(
        conversationId,
        'assistant',
        'Done',
        'completed'
      );
      const newMessageId = chatService.retryMessage(conversationId, completedMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for streaming message', () => {
      const streamingMessage = chatService.addMessage(
        conversationId,
        'assistant',
        'Generating',
        'streaming'
      );
      const newMessageId = chatService.retryMessage(conversationId, streamingMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for user message', () => {
      const userMessage = chatService.addMessage(conversationId, 'user', 'Question');
      const newMessageId = chatService.retryMessage(conversationId, userMessage!.id);
      expect(newMessageId).toBeUndefined();
    });

    it('should return undefined for non-existent message', () => {
      const newMessageId = chatService.retryMessage(conversationId, 'non-existent' as any);
      expect(newMessageId).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    let conversationId: any;

    beforeEach(() => {
      conversationId = chatService.createConversation('Error Test').id;
    });

    it('should throw when conversation not found', async () => {
      await expect(chatService.sendMessage('non-existent' as any, 'Test')).rejects.toThrow();
    });

    it('should handle missing provider', async () => {
      const service = createChatService({ defaultModel: modelId }); // No defaultProvider
      await expect(service.sendMessage(conversationId, 'Test')).rejects.not.toThrow();

      const messages = service.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle missing model', async () => {
      const service = createChatService({ defaultProvider: providerId }); // No defaultModel
      await expect(service.sendMessage(conversationId, 'Test')).rejects.not.toThrow();

      const messages = service.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle provider not found', async () => {
      providerRegistry.register(mockStreamingProvider);
      const service = createChatService({
        providerRegistry,
        defaultProvider: createProviderId('non-existent'),
        defaultModel: modelId,
      });

      await expect(service.sendMessage(conversationId, 'Test')).rejects.not.toThrow();

      const messages = service.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.status).toBe('failed');
    });

    it('should handle model not found in provider', async () => {
      providerRegistry.register(mockStreamingProvider);
      const service = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: createModelId('non-existent-model'),
      });

      await expect(service.sendMessage(conversationId, 'Test')).rejects.not.toThrow();

      const messages = service.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.role === 'assistant');
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
      chatService.addMessage(conversationId, 'user', 'First');
      chatService.addMessage(conversationId, 'assistant', 'First response', 'completed');
      chatService.addMessage(conversationId, 'user', 'Second');
      chatService.addMessage(conversationId, 'assistant', 'Second response', 'completed');
      chatService.addMessage(conversationId, 'user', 'Third');

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
      expect(capturedRequest.messages).toHaveLength(5); // system + 4 messages (2 user, 2 assistant)
    });

    it('should respect maxHistoryLength', async () => {
      const service = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        maxHistoryLength: 2,
      });

      for (let i = 0; i < 10; i++) {
        service.addMessage(conversationId, 'user', `Question ${i}`);
        service.addMessage(conversationId, 'assistant', `Answer ${i}`, 'completed');
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

      await service.sendMessage(conversationId, 'Final');
      await new Promise(resolve => setTimeout(resolve, 50));

      const call = mockStreamingProvider.executeStream.mock.calls[0];
      const request = call[0];
      // Should only include last 2 exchanges (4 messages) + system = 5
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
    it('should cancel all active streams on dispose', async () => {
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
        })()
      );

      const conversationId = chatService.createConversation('Dispose Test').id;
      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      await chatService.dispose();
      resolveComplete!();

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });
  });
});
