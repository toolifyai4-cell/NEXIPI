import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { ChatService, createChatService } from './chat.js';
import { createProviderRegistry } from './registry.js';
import { PersistenceAdapter, createPersistenceAdapter } from './persistence-adapter.js';
import { PersistenceError } from '@nexipi/persistence';
import {
  createProviderId,
  createModelId,
  type ModelProvider,
  type ModelMetadata,
  type ProviderHealth,
} from './types.js';
import { EngineErrorCode } from './errors.js';
import {
  PersistenceFoundation,
  SqlJsConversationRepository,
  SqlJsMessageRepository,
  PersistencePortService,
  createPersistenceService,
} from '@nexipi/persistence';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

describe('ChatService - Persistence Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let persistenceAdapter: PersistenceAdapter;
  let providerRegistry: ReturnType<typeof createProviderRegistry>;
  let mockStreamingProvider: ModelProvider;
  const providerId = createProviderId('test-provider');
  const modelId = createModelId('test-model');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-chat-persistence-test-'));
    dbPath = path.join(tempDir, 'test.db');

    foundationService = new PersistenceFoundation({ dbPath });
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());

    persistenceAdapter = createPersistenceAdapter({
      persistencePort: createPersistenceService(
        conversationRepo,
        messageRepo,
        foundationService
      ),
      workspaceId: 'test-workspace',
    });

    providerRegistry = createProviderRegistry();
    mockStreamingProvider = createMockStreamingProvider({
      metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
    });
    providerRegistry.register(mockStreamingProvider);
  });

  afterEach(async () => {
    try {
      foundationService.save();
    } catch {
      // Ignore save errors in cleanup
    }
    foundationService.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Conversation persistence', () => {
    let chatService: ChatService;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should persist conversation creation', async () => {
      const conversation = chatService.createConversation('Persisted Conversation');

      expect(conversation.id).toBeDefined();
      expect(conversation.title).toBe('Persisted Conversation');

      // Verify it can be retrieved via async method (loads from persistence)
      const retrieved = await chatService.getConversationAsync(conversation.id);
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.id).toBe(conversation.id);
      expect(retrieved!.title).toBe('Persisted Conversation');
    });

    it('should persist conversation title updates', async () => {
      const conversation = chatService.createConversation('Original Title');
      await new Promise(resolve => setTimeout(resolve, 10));

      chatService.updateConversationTitle(conversation.id, 'Updated Title');

      const retrieved = await chatService.getConversationAsync(conversation.id);
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.title).toBe('Updated Title');
      expect(retrieved!.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt);
    });

    it('should persist conversation deletion', async () => {
      const conversation = chatService.createConversation('To Delete');

      const deleted = chatService.deleteConversation(conversation.id);
      expect(deleted).toBe(true);

      const retrieved = await chatService.getConversationAsync(conversation.id);
      expect(retrieved).toBeUndefined();
    });

    it('should list conversations from persistence', async () => {
      chatService.createConversation('Conversation 1');
      await new Promise(resolve => setTimeout(resolve, 10));
      chatService.createConversation('Conversation 2');
      await new Promise(resolve => setTimeout(resolve, 10));
      chatService.createConversation('Conversation 3');

      const conversations = await chatService.listConversationsAsync();
      expect(conversations).toHaveLength(3);
      expect(conversations[0].title).toBe('Conversation 3'); // Most recent first
      expect(conversations[1].title).toBe('Conversation 2');
      expect(conversations[2].title).toBe('Conversation 1');
    });

    it('should load conversations on initialize', async () => {
      // Create conversations with first service instance
      const service1 = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await service1.initialize();

      service1.createConversation('Pre-existing 1');
      await new Promise(resolve => setTimeout(resolve, 10));
      service1.createConversation('Pre-existing 2');

      await service1.dispose();

      // Create new service instance - should load existing conversations
      const service2 = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await service2.initialize();

      const conversations = await service2.listConversationsAsync();
      expect(conversations).toHaveLength(2);
      const titles = conversations.map(c => c.title).sort();
      expect(titles).toEqual(['Pre-existing 1', 'Pre-existing 2']);

      await service2.dispose();
    });
  });

  describe('Message persistence', () => {
    let chatService: ChatService;
    let conversationId: string;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();

      conversationId = chatService.createConversation('Message Test').id;
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should persist user messages', async () => {
      const message = chatService.addMessage(conversationId, 'user', 'Hello, world!', 'completed');
      expect(message).toBeDefined();
      expect(message!.role).toBe('user');
      expect(message!.content).toBe('Hello, world!');

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].content).toBe('Hello, world!');
      expect(retrieved[0].role).toBe('user');
      expect(retrieved[0].status).toBe('completed');
    });

    it('should persist assistant messages', async () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Hi there!', 'pending');
      expect(message).toBeDefined();
      expect(message!.role).toBe('assistant');
      expect(message!.status).toBe('pending');

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].content).toBe('Hi there!');
      expect(retrieved[0].role).toBe('assistant');
      expect(retrieved[0].status).toBe('pending');
    });

    it('should persist system messages', async () => {
      const message = chatService.addMessage(conversationId, 'system', 'System prompt', 'completed');
      expect(message).toBeDefined();
      expect(message!.role).toBe('system');

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].role).toBe('system');
      expect(retrieved[0].content).toBe('System prompt');
    });

    it('should persist message updates (content and status)', async () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Original', 'streaming');

      chatService.updateMessage(conversationId, message!.id, {
        content: 'Updated content',
        status: 'completed',
      });

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].content).toBe('Updated content');
      expect(retrieved[0].status).toBe('completed');
    });

    it('should persist message metadata updates', async () => {
      const message = chatService.addMessage(conversationId, 'assistant', 'Test', 'pending', {
        initial: true,
      });

      chatService.updateMessage(conversationId, message!.id, {
        metadata: { updated: true, tokens: 100 },
      });

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved[0].metadata).toEqual({
        initial: true,
        updated: true,
        tokens: 100,
      });
    });

    it('should persist message deletion', async () => {
      const message = chatService.addMessage(conversationId, 'user', 'To delete', 'completed');

      const deleted = chatService.deleteMessage(conversationId, message!.id);
      expect(deleted).toBe(true);

      const retrieved = await chatService.getMessagesAsync(conversationId);
      expect(retrieved).toHaveLength(0);
    });

    it('should maintain message ordering', async () => {
      chatService.addMessage(conversationId, 'user', 'First', 'completed');
      chatService.addMessage(conversationId, 'assistant', 'Second', 'completed');
      chatService.addMessage(conversationId, 'user', 'Third', 'completed');

      const messages = await chatService.getMessagesAsync(conversationId);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('should load messages on initialize with conversation', async () => {
      // Add messages to first service
      const service1 = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await service1.initialize();

      const convId = service1.createConversation('With Messages').id;
      service1.addMessage(convId, 'user', 'User message', 'completed');
      service1.addMessage(convId, 'assistant', 'Assistant response', 'completed');

      await service1.dispose();

      // Create new service - should load messages
      const service2 = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await service2.initialize();

      const messages = await service2.getMessagesAsync(convId);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('User message');
      expect(messages[1].content).toBe('Assistant response');

      await service2.dispose();
    });
  });

  describe('Streaming persistence', () => {
    let chatService: ChatService;
    let conversationId: string;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();

      conversationId = chatService.createConversation('Streaming Test').id;
      chatService.addMessage(conversationId, 'user', 'Hello', 'completed');
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should persist streaming deltas progressively', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 50));

      // Message should exist with streaming status
      const duringStream = await chatService.getMessageAsync(conversationId, assistantMessageId);
      expect(duringStream).toBeDefined();
      expect(duringStream!.status).toBe('streaming');
      expect(duringStream!.content).toBe('Start ');

      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Message should be completed after stream finishes
      const afterStream = await chatService.getMessageAsync(conversationId, assistantMessageId);
      expect(afterStream).toBeDefined();
      expect(afterStream!.status).toBe('completed');
      expect(afterStream!.content).toBe('Start ');
    });

    it('should persist completed message with usage metadata', async () => {
      const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield {
            type: 'stream:delta',
            conversationId: '',
            messageId: '',
            delta: 'Test response',
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
      await new Promise(resolve => setTimeout(resolve, 100));

      const message = await chatService.getMessageAsync(conversationId, assistantMessageId);
      expect(message).toBeDefined();
      expect(message!.status).toBe('completed');
      expect(message!.content).toBe('Test response');
      expect(message!.metadata?.usage).toEqual(usage);
    });

    it('should persist cancelled message status', async () => {
      let resolveComplete: () => void;
      const completePromise = new Promise<void>(resolve => {
        resolveComplete = resolve;
      });

      mockStreamingProvider.executeStream = createCompletableStreamingMock(completePromise);

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Test');
      await new Promise(resolve => setTimeout(resolve, 10));

      chatService.cancelMessage(assistantMessageId);
      resolveComplete!();
      await new Promise(resolve => setTimeout(resolve, 50));

      const message = await chatService.getMessageAsync(conversationId, assistantMessageId);
      expect(message).toBeDefined();
      expect(message!.status).toBe('cancelled');
    });

    it('should persist failed message status with error', async () => {
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
      await new Promise(resolve => setTimeout(resolve, 100));

      const message = await chatService.getMessageAsync(conversationId, assistantMessageId);
      expect(message).toBeDefined();
      expect(message!.status).toBe('failed');
      expect(message!.metadata?.error).toBeDefined();
    });
  });

  describe('Async persistence methods', () => {
    let chatService: ChatService;
    let conversationId: string;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();

      conversationId = chatService.createConversation('Async Test').id;
      chatService.addMessage(conversationId, 'user', 'Hello', 'completed');
      chatService.addMessage(conversationId, 'assistant', 'Hi', 'completed');
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should retrieve conversation via getConversationAsync', async () => {
      const conversation = await chatService.getConversationAsync(conversationId);
      expect(conversation).not.toBeUndefined();
      expect(conversation!.id).toBe(conversationId);
      expect(conversation!.title).toBe('Async Test');
    });

    it('should return undefined for non-existent conversation via getConversationAsync', async () => {
      const conversation = await chatService.getConversationAsync('non-existent' as any);
      expect(conversation).toBeUndefined();
    });

    it('should list conversations via listConversationsAsync', async () => {
      chatService.createConversation('Conversation 2');
      await new Promise(resolve => setTimeout(resolve, 10));
      chatService.createConversation('Conversation 3');

      const conversations = await chatService.listConversationsAsync();
      expect(conversations).toHaveLength(3);
      expect(conversations[0].title).toBe('Conversation 3');
    });

    it('should retrieve messages via getMessagesAsync', async () => {
      const messages = await chatService.getMessagesAsync(conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Hello');
      expect(messages[1].content).toBe('Hi');
    });

    it('should return empty array for non-existent conversation via getMessagesAsync', async () => {
      const messages = await chatService.getMessagesAsync('non-existent' as any);
      expect(messages).toEqual([]);
    });

    it('should retrieve specific message via getMessageAsync', async () => {
      const messages = await chatService.getMessagesAsync(conversationId);
      const messageId = messages[0].id;

      const message = await chatService.getMessageAsync(conversationId, messageId);
      expect(message).not.toBeUndefined();
      expect(message!.id).toBe(messageId);
      expect(message!.content).toBe('Hello');
    });

    it('should return undefined for non-existent message via getMessageAsync', async () => {
      const message = await chatService.getMessageAsync(conversationId, 'non-existent' as any);
      expect(message).toBeUndefined();
    });

    it('should get conversation state via getConversationStateAsync', async () => {
      const state = await chatService.getConversationStateAsync(conversationId);
      expect(state).not.toBeUndefined();
      expect(state!.conversation.id).toBe(conversationId);
      expect(state!.messages).toHaveLength(2);
      expect(state!.isLoading).toBe(false);
    });

    it('should return undefined for non-existent conversation via getConversationStateAsync', async () => {
      const state = await chatService.getConversationStateAsync('non-existent' as any);
      expect(state).toBeUndefined();
    });
  });

  describe('Persistence error handling', () => {
    let chatService: ChatService;
    let conversationId: string;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();

      conversationId = chatService.createConversation('Error Test').id;
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should emit persistence:error event on persistence failure', async () => {
      const errorListener = vi.fn();
      chatService.on('persistence:error', errorListener);

      // Force a persistence error by closing the foundation
      foundationService.close();

      // Try to create a conversation - should fail persistence
      const conversation = chatService.createConversation('Should Fail Persist');

      // In-memory creation still succeeds
      expect(conversation).toBeDefined();

      // Wait for async persistence to attempt
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have emitted persistence error
      expect(errorListener).toHaveBeenCalled();
      const errorEvent = errorListener.mock.calls[0][0];
      expect(errorEvent.error).toBeInstanceOf(PersistenceError);
      expect(errorEvent.operation).toBe('createConversation');
    });

    it('should not lose in-memory data on persistence failure', async () => {
      // Close foundation to cause persistence errors
      foundationService.close();

      const conversation = chatService.createConversation('In-Memory Only');
      chatService.addMessage(conversation.id, 'user', 'Test message', 'completed');

      // In-memory operations should still work
      const cachedConversation = chatService.getConversation(conversation.id);
      expect(cachedConversation).toBeDefined();
      expect(cachedConversation!.title).toBe('In-Memory Only');

      const messages = chatService.getMessages(conversation.id);
      expect(messages).toHaveLength(1); // Only the new user message (different conversation)
    });
  });

  describe('Full streaming lifecycle with persistence', () => {
    let chatService: ChatService;
    let conversationId: string;

    beforeEach(async () => {
      chatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
      });
      await chatService.initialize();

      conversationId = chatService.createConversation('Full Lifecycle').id;
      chatService.addMessage(conversationId, 'user', 'Tell me a story', 'completed');
    });

    afterEach(async () => {
      await chatService.dispose();
    });

    it('should persist complete message lifecycle: user -> assistant streaming -> completed', async () => {
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'Once ', timestamp: Date.now() };
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'upon ', timestamp: Date.now() };
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'a time...', timestamp: Date.now() };
          yield { type: 'stream:complete', conversationId: '', messageId: '', finishReason: 'stop', timestamp: Date.now() };
        })()
      );

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Tell me a story');
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify full conversation persisted
      const messages = await chatService.getMessagesAsync(conversationId);
      expect(messages).toHaveLength(3); // user message from beforeEach + user message from sendMessage + assistant message
      // Find the assistant message (the last one)
      const assistantMsg = messages.find(m => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe('Once upon a time...');
      expect(assistantMsg!.status).toBe('completed');
      // Verify user messages exist
      const userMessages = messages.filter(m => m.role === 'user');
      expect(userMessages).toHaveLength(2);
    });

    it('should handle retry of failed message with persistence', async () => {
      // First, create a failed message
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'Error ', timestamp: Date.now() };
          yield { type: 'stream:error', conversationId: '', messageId: '', error: { code: 'ERROR', message: 'Failed', retryable: true }, timestamp: Date.now() };
        })()
      );

      const failedMessageId = await chatService.sendMessage(conversationId, 'First attempt');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check in-memory message status first (should be immediate)
      const inMemoryFailedMessage = chatService.getMessage(conversationId, failedMessageId);
      expect(inMemoryFailedMessage).toBeDefined();
      expect(inMemoryFailedMessage!.status).toBe('failed');

      // Also check via async method (loads from persistence)
      let failedMessage = await chatService.getMessageAsync(conversationId, failedMessageId);
      expect(failedMessage!.status).toBe('failed');

      // Now retry with success - retryMessage resets the original message to 'pending' and creates a new one
      mockStreamingProvider.executeStream = vi.fn().mockReturnValue(
        (async function* () {
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'Success!', timestamp: Date.now() };
          yield { type: 'stream:complete', conversationId: '', messageId: '', finishReason: 'stop', timestamp: Date.now() };
        })()
      );

      const retryMessageId = await chatService.retryMessage(conversationId, failedMessageId);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Original message should now be 'pending' (reset for retry)
      failedMessage = await chatService.getMessageAsync(conversationId, failedMessageId);
      expect(failedMessage!.status).toBe('pending');
      expect(failedMessage!.content).toBe('');

      // New retry message should be completed
      const retryMessage = await chatService.getMessageAsync(conversationId, retryMessageId!);
      expect(retryMessage).toBeDefined();
      expect(retryMessage!.status).toBe('completed');
      expect(retryMessage!.content).toBe('Success!');

      // Verify both messages persisted (user from beforeEach + user from first attempt + original pending + user from retry + retry)
      const allMessages = await chatService.getMessagesAsync(conversationId);
      expect(allMessages).toHaveLength(5); // beforeEach user + first attempt user + original (now pending) + retry user + retry
    });
  });

  describe('Concurrency policies with persistence', () => {
    it('should persist messages correctly under allow-all policy', async () => {
      const allowAllService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        persistenceAdapter,
        workspaceId: 'test-workspace',
        concurrencyPolicy: 'allow-all',
      });
      await allowAllService.initialize();

      const conversationId = allowAllService.createConversation('Allow All Persistence').id;

      let resolveFirst: () => void;
      let resolveSecond: () => void;
      const firstPromise = new Promise<void>(resolve => { resolveFirst = resolve; });
      const secondPromise = new Promise<void>(resolve => { resolveSecond = resolve; });

      let requestCount = 0;
      mockStreamingProvider.executeStream = vi.fn().mockImplementation(async function* () {
        const thisRequest = ++requestCount;
        if (thisRequest === 1) {
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'First ', timestamp: Date.now() };
          await firstPromise;
          yield { type: 'stream:complete', conversationId: '', messageId: '', finishReason: 'stop', timestamp: Date.now() };
        } else {
          yield { type: 'stream:delta', conversationId: '', messageId: '', delta: 'Second ', timestamp: Date.now() };
          await secondPromise;
          yield { type: 'stream:complete', conversationId: '', messageId: '', finishReason: 'stop', timestamp: Date.now() };
        }
      });

      const msgId1 = await allowAllService.sendMessage(conversationId, 'First');
      const msgId2 = await allowAllService.sendMessage(conversationId, 'Second');
      await new Promise(resolve => setTimeout(resolve, 10));

      resolveFirst!();
      await new Promise(resolve => setTimeout(resolve, 10));
      resolveSecond!();
      await new Promise(resolve => setTimeout(resolve, 10));

      const messages = await allowAllService.getMessagesAsync(conversationId);
      expect(messages).toHaveLength(4); // 2 user messages (from sendMessage) + 2 assistant messages
      const userMessages = messages.filter(m => m.role === 'user');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(userMessages).toHaveLength(2);
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].content).toBe('First ');
      expect(assistantMessages[1].content).toBe('Second ');

      await allowAllService.dispose();
    });
  });
});