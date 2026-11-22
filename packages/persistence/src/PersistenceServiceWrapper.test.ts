import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { PersistenceService, createPersistenceService } from './PersistenceServiceWrapper.js';
import { SqlJsConversationRepository, SqlJsMessageRepository } from './repositories.js';
import { PersistenceService as FoundationPersistenceService } from './PersistenceService.js';
import { PersistenceError } from './PersistenceService.js';
import { ConversationId, MessageId, MessageRole, MessageStatus } from '@nexipi/shared';

describe('PersistenceService - Construction', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
  });

  afterEach(async () => {
    foundationService.close();
  });

  it('should create service with repository dependencies', () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    expect(service).toBeInstanceOf(PersistenceService);
  });

  it('should create service via factory function', () => {
    service = createPersistenceService(conversationRepo, messageRepo, foundationService);
    expect(service).toBeInstanceOf(PersistenceService);
  });

  it('should create service with auto-created foundation service', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    expect(service.isAvailable()).toBe(true);
    service.dispose();
  });

  it('should not require global singleton', () => {
    const service1 = new PersistenceService(conversationRepo, messageRepo, foundationService);
    const service2 = new PersistenceService(conversationRepo, messageRepo, foundationService);
    expect(service1).not.toBe(service2);
  });
});

describe('PersistenceService - Lifecycle', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
  });

  afterEach(async () => {
    foundationService.close();
  });

  it('should be available after initialize when owning foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    expect(service.isAvailable()).toBe(false);
    await service.initialize();
    expect(service.isAvailable()).toBe(true);
    service.dispose();
  });

  it('should be available after initialize with external foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    expect(service.isAvailable()).toBe(true);
    service.dispose();
  });

  it('should not be available after dispose', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    service.dispose();
    expect(service.isAvailable()).toBe(false);
  });

  it('should throw when operating after dispose', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    service.dispose();
    await expect(service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow(PersistenceError);
  });

  it('should throw when operating before initialize (when owning foundation)', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await expect(service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence not initialized');
  });

  it('should not close external foundation on dispose', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    service.dispose();
    expect(foundationService.isInitialized()).toBe(true);
  });

  it('should close owned foundation on dispose', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();
    // The foundation service is internal, we can't directly check it
    // but isAvailable should be false
    expect(service.isAvailable()).toBe(false);
  });

  it('should handle multiple dispose calls safely', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
    service.dispose();
    service.dispose(); // Should not throw
    expect(service.isAvailable()).toBe(false);
  });

  it('should not allow re-initialization after dispose', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();
    await expect(service.initialize()).rejects.toThrow('disposed');
  });
});

describe('PersistenceService - Owned Foundation Lifecycle (Scenario A)', () => {
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    // Create a foundation and repos for this test
    const foundation = new FoundationPersistenceService();
    await foundation.init();
    conversationRepo = new SqlJsConversationRepository(foundation.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundation.getRawDatabase());
  });

  afterEach(async () => {
    // Clean up any remaining foundation if service didn't dispose it
    if (service && service.isAvailable()) {
      service.dispose();
    }
  });

  it('should initialize owned foundation on initialize()', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    expect(service.isAvailable()).toBe(false);
    await service.initialize();
    expect(service.isAvailable()).toBe(true);
  });

  it('should close owned foundation on dispose()', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();
    expect(service.isAvailable()).toBe(false);
  });

  it('should handle multiple dispose() calls safely on owned foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();
    service.dispose(); // Second call should not throw
    expect(service.isAvailable()).toBe(false);
  });

  it('should prevent re-initialization after dispose on owned foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();
    await expect(service.initialize()).rejects.toThrow('disposed');
  });

  it('should allow operations after initialize and before dispose on owned foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();

    const result = await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    });
    expect(result.error).toBeNull();
    expect(result.conversation).not.toBeNull();

    service.dispose();
  });

  it('should throw when operating on disposed owned foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo);
    await service.initialize();
    service.dispose();

    await expect(service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence service has been disposed');
  });
});

describe('PersistenceService - External Foundation Lifecycle (Scenario B)', () => {
  let externalFoundation: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    externalFoundation = new FoundationPersistenceService();
    await externalFoundation.init();
    conversationRepo = new SqlJsConversationRepository(externalFoundation.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(externalFoundation.getRawDatabase());
  });

  afterEach(async () => {
    // External owner is responsible for closing
    externalFoundation.close();
  });

  it('should not initialize external foundation on construction', async () => {
    // Foundation is already initialized in beforeEach
    service = new PersistenceService(conversationRepo, messageRepo, externalFoundation);
    // Service should be available immediately since external foundation is initialized
    expect(service.isAvailable()).toBe(true);
  });

  it('should not call initialize() on external foundation', async () => {
    const uninitializedFoundation = new FoundationPersistenceService();
    // Initialize externally first
    await uninitializedFoundation.init();

    // Now create repos and service
    const uninitializedConvRepo = new SqlJsConversationRepository(uninitializedFoundation.getRawDatabase());
    const uninitializedMsgRepo = new SqlJsMessageRepository(uninitializedFoundation.getRawDatabase());
    service = new PersistenceService(uninitializedConvRepo, uninitializedMsgRepo, uninitializedFoundation);

    // Service should be available because external foundation was initialized externally
    expect(service.isAvailable()).toBe(true);

    // Calling initialize() on wrapper should not re-initialize the external foundation
    await service.initialize(); // Should not throw
    expect(service.isAvailable()).toBe(true);

    uninitializedFoundation.close();
  });

  it('should not close external foundation on dispose()', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, externalFoundation);
    service.dispose();

    // External foundation should remain open
    expect(externalFoundation.isInitialized()).toBe(true);
    expect(service.isAvailable()).toBe(false);
  });

  it('should handle multiple dispose() calls safely with external foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, externalFoundation);
    service.dispose();
    service.dispose(); // Second call should not throw
    expect(service.isAvailable()).toBe(false);
    expect(externalFoundation.isInitialized()).toBe(true);
  });

  it('should prevent re-initialization after dispose with external foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, externalFoundation);
    service.dispose();
    await expect(service.initialize()).rejects.toThrow('disposed');
  });

  it('should throw when operating on disposed service with external foundation', async () => {
    service = new PersistenceService(conversationRepo, messageRepo, externalFoundation);
    service.dispose();

    await expect(service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence service has been disposed');

    // External foundation should still be open
    expect(externalFoundation.isInitialized()).toBe(true);
  });

  it('should allow operations after external initialization and before dispose', async () => {
    const uninitializedFoundation = new FoundationPersistenceService();
    // Initialize externally first
    await uninitializedFoundation.init();

    // Now create repos and service
    const uninitializedConvRepo = new SqlJsConversationRepository(uninitializedFoundation.getRawDatabase());
    const uninitializedMsgRepo = new SqlJsMessageRepository(uninitializedFoundation.getRawDatabase());
    service = new PersistenceService(uninitializedConvRepo, uninitializedMsgRepo, uninitializedFoundation);

    // Service should be available
    expect(service.isAvailable()).toBe(true);

    // Operations should work
    const result = await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    });
    expect(result.error).toBeNull();

    service.dispose();
    uninitializedFoundation.close();
  });
});

describe('PersistenceService - Shared External Foundation Lifecycle (Scenario C)', () => {
  let sharedFoundation: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service1: PersistenceService;
  let service2: PersistenceService;

  beforeEach(async () => {
    sharedFoundation = new FoundationPersistenceService();
    await sharedFoundation.init();
    conversationRepo = new SqlJsConversationRepository(sharedFoundation.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(sharedFoundation.getRawDatabase());
  });

  afterEach(async () => {
    // Clean up services if not disposed
    if (service1 && service1.isAvailable()) service1.dispose();
    if (service2 && service2.isAvailable()) service2.dispose();
    // Shared owner closes the foundation
    sharedFoundation.close();
  });

  it('should allow multiple services to share the same external foundation', async () => {
    service1 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);
    service2 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);

    expect(service1.isAvailable()).toBe(true);
    expect(service2.isAvailable()).toBe(true);
  });

  it('should allow one service to dispose while other continues using shared foundation', async () => {
    service1 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);
    service2 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);

    // Both services work
    const result1 = await service1.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Service 1 Conversation',
    });
    expect(result1.error).toBeNull();

    const result2 = await service2.createConversation({
      id: 'conv-2' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Service 2 Conversation',
    });
    expect(result2.error).toBeNull();

    // Dispose service1
    service1.dispose();
    expect(service1.isAvailable()).toBe(false);

    // Service2 should still work
    expect(service2.isAvailable()).toBe(true);
    const result3 = await service2.createConversation({
      id: 'conv-3' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Service 2 Second Conversation',
    });
    expect(result3.error).toBeNull();
  });

  it('should keep shared foundation open until all services are disposed and owner closes it', async () => {
    service1 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);
    service2 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);

    service1.dispose();
    expect(sharedFoundation.isInitialized()).toBe(true);

    service2.dispose();
    expect(sharedFoundation.isInitialized()).toBe(true);

    // Foundation remains open until owner closes it
    sharedFoundation.close();
    expect(sharedFoundation.isInitialized()).toBe(false);
  });

  it('should handle disposal of services in any order with shared foundation', async () => {
    service1 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);
    service2 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);

    // Dispose in reverse order
    service2.dispose();
    expect(service2.isAvailable()).toBe(false);
    expect(service1.isAvailable()).toBe(true);
    expect(sharedFoundation.isInitialized()).toBe(true);

    service1.dispose();
    expect(service1.isAvailable()).toBe(false);
    expect(sharedFoundation.isInitialized()).toBe(true);
  });

  it('should prevent operations on disposed service while other service still works', async () => {
    service1 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);
    service2 = new PersistenceService(conversationRepo, messageRepo, sharedFoundation);

    service1.dispose();

    // Service1 should throw
    await expect(service1.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence service has been disposed');

    // Service2 should still work
    const result = await service2.createConversation({
      id: 'conv-2' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    });
    expect(result.error).toBeNull();
  });
});

describe('PersistenceService - Conversation Delegation', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);
  });

  afterEach(async () => {
    foundationService.close();
  });

  it('should delegate createConversation to repository', async () => {
    const result = await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test Conversation',
      createdAt: 1000,
      updatedAt: 2000,
      metadata: { key: 'value' },
    });

    expect(result.error).toBeNull();
    expect(result.conversation).not.toBeNull();
    expect(result.conversation!.id).toBe('conv-1');
    expect(result.conversation!.workspaceId).toBe('ws-1');
    expect(result.conversation!.title).toBe('Test Conversation');
    expect(result.conversation!.createdAt).toBe(1000);
    expect(result.conversation!.updatedAt).toBe(2000);
    expect(result.conversation!.metadata).toEqual({ key: 'value' });
  });

  it('should delegate getConversation to repository', async () => {
    await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const result = await service.getConversation('conv-1' as ConversationId);

    expect(result.error).toBeNull();
    expect(result.conversation).not.toBeNull();
    expect(result.conversation!.id).toBe('conv-1');
    expect(result.conversation!.title).toBe('Test');
  });

  it('should return null for non-existent conversation', async () => {
    const result = await service.getConversation('non-existent' as ConversationId);
    expect(result.error).toBeNull();
    expect(result.conversation).toBeNull();
  });

  it('should delegate listConversations to repository', async () => {
    await service.createConversation({ id: 'conv-1' as ConversationId, workspaceId: 'ws-1', title: 'Conv 1', createdAt: 1000, updatedAt: 1000 });
    await service.createConversation({ id: 'conv-2' as ConversationId, workspaceId: 'ws-1', title: 'Conv 2', createdAt: 2000, updatedAt: 2000 });
    await service.createConversation({ id: 'conv-3' as ConversationId, workspaceId: 'ws-2', title: 'Conv 3', createdAt: 3000, updatedAt: 3000 });

    const result = await service.listConversations();

    expect(result.error).toBeNull();
    expect(result.conversations).toHaveLength(3);
  });

  it('should pass workspaceId filter to listConversations', async () => {
    await service.createConversation({ id: 'conv-1' as ConversationId, workspaceId: 'ws-1', title: 'Conv 1', createdAt: 1000, updatedAt: 1000 });
    await service.createConversation({ id: 'conv-2' as ConversationId, workspaceId: 'ws-1', title: 'Conv 2', createdAt: 2000, updatedAt: 2000 });
    await service.createConversation({ id: 'conv-3' as ConversationId, workspaceId: 'ws-2', title: 'Conv 3', createdAt: 3000, updatedAt: 3000 });

    const result = await service.listConversations('ws-1');

    expect(result.error).toBeNull();
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations.every(c => c.workspaceId === 'ws-1')).toBe(true);
  });

  it('should delegate updateConversation to repository', async () => {
    await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Original',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const result = await service.updateConversation('conv-1' as ConversationId, { title: 'Updated' });

    expect(result.error).toBeNull();
    expect(result.conversation).not.toBeNull();
    expect(result.conversation!.title).toBe('Updated');
    expect(result.conversation!.updatedAt).toBeGreaterThan(1000);
  });

  it('should delegate deleteConversation to repository', async () => {
    await service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const deleteResult = await service.deleteConversation('conv-1' as ConversationId);
    expect(deleteResult.error).toBeNull();
    expect(deleteResult.deleted).toBe(true);

    const getResult = await service.getConversation('conv-1' as ConversationId);
    expect(getResult.conversation).toBeNull();
  });

  it('should return deleted=false for non-existent conversation', async () => {
    const result = await service.deleteConversation('non-existent' as ConversationId);
    expect(result.error).toBeNull();
    expect(result.deleted).toBe(false);
  });
});

describe('PersistenceService - Message Delegation', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);

    // Create a conversation for messages
    await conversationRepo.create({
      id: 'conv-1',
      workspace_id: 'ws-1',
      title: 'Test',
      created_at: 1000,
      updated_at: 1000,
    });
  });

  afterEach(async () => {
    foundationService.close();
  });

  it('should delegate createMessage to repository', async () => {
    const result = await service.createMessage({
      id: 'msg-1' as MessageId,
      conversationId: 'conv-1' as ConversationId,
      role: 'user',
      content: 'Hello, world!',
      status: 'completed',
      timestamp: 1000,
      seq: 0,
      metadata: { source: 'test' },
    });

    expect(result.error).toBeNull();
    expect(result.message).not.toBeNull();
    expect(result.message!.id).toBe('msg-1');
    expect(result.message!.conversationId).toBe('conv-1');
    expect(result.message!.role).toBe('user');
    expect(result.message!.content).toBe('Hello, world!');
    expect(result.message!.status).toBe('completed');
    expect(result.message!.timestamp).toBe(1000);
    expect(result.message!.seq).toBe(0);
    expect(result.message!.metadata).toEqual({ source: 'test' });
  });

  it('should delegate getMessage to repository', async () => {
    await service.createMessage({
      id: 'msg-1' as MessageId,
      conversationId: 'conv-1' as ConversationId,
      role: 'user',
      content: 'Hello',
      status: 'completed',
      timestamp: 1000,
      seq: 0,
    });

    const result = await service.getMessage('msg-1' as MessageId);

    expect(result.error).toBeNull();
    expect(result.message).not.toBeNull();
    expect(result.message!.id).toBe('msg-1');
    expect(result.message!.content).toBe('Hello');
  });

  it('should return null for non-existent message', async () => {
    const result = await service.getMessage('non-existent' as MessageId);
    expect(result.error).toBeNull();
    expect(result.message).toBeNull();
  });

  it('should delegate getMessagesByConversationId to repository', async () => {
    await service.createMessage({ id: 'msg-1' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
    await service.createMessage({ id: 'msg-2' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });
    await service.createMessage({ id: 'msg-3' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 3', status: 'completed', timestamp: 3000, seq: 2 });

    const result = await service.getMessagesByConversationId('conv-1' as ConversationId);

    expect(result.error).toBeNull();
    expect(result.messages).toHaveLength(3);
  });

  it('should return messages in chronological order', async () => {
    await service.createMessage({ id: 'msg-3' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 3', status: 'completed', timestamp: 3000, seq: 2 });
    await service.createMessage({ id: 'msg-1' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
    await service.createMessage({ id: 'msg-2' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

    const result = await service.getMessagesByConversationId('conv-1' as ConversationId);

    expect(result.error).toBeNull();
    expect(result.messages[0].id).toBe('msg-1');
    expect(result.messages[1].id).toBe('msg-2');
    expect(result.messages[2].id).toBe('msg-3');
  });

  it('should delegate updateMessage to repository', async () => {
    await service.createMessage({
      id: 'msg-1' as MessageId,
      conversationId: 'conv-1' as ConversationId,
      role: 'assistant',
      content: 'Original',
      status: 'streaming',
      timestamp: 1000,
      seq: 0,
    });

    const result = await service.updateMessage('msg-1' as MessageId, { content: 'Updated content' });

    expect(result.error).toBeNull();
    expect(result.message!.content).toBe('Updated content');
    expect(result.message!.status).toBe('streaming');
  });

  it('should delegate deleteMessage to repository', async () => {
    await service.createMessage({
      id: 'msg-1' as MessageId,
      conversationId: 'conv-1' as ConversationId,
      role: 'user',
      content: 'Hello',
      status: 'completed',
      timestamp: 1000,
      seq: 0,
    });

    const deleteResult = await service.deleteMessage('msg-1' as MessageId);
    expect(deleteResult.error).toBeNull();
    expect(deleteResult.deleted).toBe(true);

    const getResult = await service.getMessage('msg-1' as MessageId);
    expect(getResult.message).toBeNull();
  });

  it('should return deleted=false for non-existent message', async () => {
    const result = await service.deleteMessage('non-existent' as MessageId);
    expect(result.error).toBeNull();
    expect(result.deleted).toBe(false);
  });

  it('should delegate deleteMessagesByConversationId to repository', async () => {
    await service.createMessage({ id: 'msg-1' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
    await service.createMessage({ id: 'msg-2' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

    const deleteResult = await service.deleteMessagesByConversationId('conv-1' as ConversationId);
    expect(deleteResult.error).toBeNull();
    expect(deleteResult.deleted).toBe(true);

    const getResult = await service.getMessagesByConversationId('conv-1' as ConversationId);
    expect(getResult.messages).toHaveLength(0);
  });
});

describe('PersistenceService - Error Handling', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
    service = new PersistenceService(conversationRepo, messageRepo, foundationService);

    await conversationRepo.create({
      id: 'conv-1',
      workspace_id: 'ws-1',
      title: 'Test',
      created_at: 1000,
      updated_at: 1000,
    });
  });

  afterEach(async () => {
    foundationService.close();
  });

  it('should propagate repository errors', async () => {
    const result = await service.updateConversation('non-existent' as ConversationId, { title: 'New' });
    expect(result.error).not.toBeNull();
    expect(result.error!.name).toBe('PersistenceError');
  });

  it('should handle not-found errors without cause', async () => {
    const result = await service.updateConversation('non-existent' as ConversationId, { title: 'New' });
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toBe('Conversation not found');
  });

  it('should reject invalid conversation input', async () => {
    const result = await service.createConversation({
      id: '' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    });
    expect(result.error).not.toBeNull();
    expect(result.conversation).toBeNull();
  });

  it('should reject message for non-existent conversation', async () => {
    const result = await service.createMessage({
      id: 'msg-1' as MessageId,
      conversationId: 'non-existent' as ConversationId,
      role: 'user',
      content: 'Hello',
      status: 'completed',
    });
    expect(result.error).not.toBeNull();
    expect(result.message).toBeNull();
  });

  it('should throw when operating on closed persistence', async () => {
    service.dispose();
    await expect(service.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence service has been disposed');
  });

  it('should throw when operating on unavailable persistence', async () => {
    const uninitializedService = new PersistenceService(conversationRepo, messageRepo);
    await expect(uninitializedService.createConversation({
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
    })).rejects.toThrow('Persistence not initialized');
  });
});