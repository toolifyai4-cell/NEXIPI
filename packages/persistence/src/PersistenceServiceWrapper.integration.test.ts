import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { PersistenceService, createPersistenceService } from './PersistenceServiceWrapper.js';
import { SqlJsConversationRepository, SqlJsMessageRepository } from './repositories.js';
import { PersistenceService as FoundationPersistenceService } from './PersistenceService.js';
import { PersistenceError } from './PersistenceService.js';
import { ConversationId, MessageId, MessageRole, MessageStatus } from '@nexipi/shared';

describe('PersistenceService - Integration Tests', () => {
  let foundationService: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;
  let service: PersistenceService;

  beforeEach(async () => {
    foundationService = new FoundationPersistenceService();
    await foundationService.init();
    conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());
    service = createPersistenceService(conversationRepo, messageRepo, foundationService);
  });

  afterEach(async () => {
    foundationService.close();
  });

  describe('Full CRUD workflow', () => {
    it('should create, retrieve, update, and delete a conversation', async () => {
      // Create
      const createResult = await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Original Title',
        metadata: { tags: ['important'] },
      });
      expect(createResult.error).toBeNull();
      expect(createResult.conversation!.title).toBe('Original Title');
      expect(createResult.conversation!.metadata).toEqual({ tags: ['important'] });

      // Retrieve
      const getResult = await service.getConversation('conv-1' as ConversationId);
      expect(getResult.error).toBeNull();
      expect(getResult.conversation!.title).toBe('Original Title');

      // Update
      const updateResult = await service.updateConversation('conv-1' as ConversationId, {
        title: 'Updated Title',
      });
      expect(updateResult.error).toBeNull();
      expect(updateResult.conversation!.title).toBe('Updated Title');
      expect(updateResult.conversation!.metadata).toEqual({ tags: ['important'] }); // metadata preserved

      // Delete
      const deleteResult = await service.deleteConversation('conv-1' as ConversationId);
      expect(deleteResult.error).toBeNull();
      expect(deleteResult.deleted).toBe(true);

      // Verify deletion
      const finalGet = await service.getConversation('conv-1' as ConversationId);
      expect(finalGet.conversation).toBeNull();
    });

    it('should create, retrieve, update, and delete messages', async () => {
      // Create conversation first
      await conversationRepo.create({
        id: 'conv-1',
        workspace_id: 'ws-1',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      // Create messages
      const msg1 = await service.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });
      expect(msg1.error).toBeNull();

      const msg2 = await service.createMessage({
        id: 'msg-2' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'assistant',
        content: 'Hi there!',
        status: 'streaming',
        timestamp: 2000,
        seq: 1,
      });
      expect(msg2.error).toBeNull();

      // Retrieve messages
      const listResult = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(listResult.error).toBeNull();
      expect(listResult.messages).toHaveLength(2);
      expect(listResult.messages[0].content).toBe('Hello');
      expect(listResult.messages[1].content).toBe('Hi there!');

      // Update message
      const updateResult = await service.updateMessage('msg-2' as MessageId, {
        content: 'Hi there! How can I help?',
        status: 'completed',
      });
      expect(updateResult.error).toBeNull();
      expect(updateResult.message!.content).toBe('Hi there! How can I help?');
      expect(updateResult.message!.status).toBe('completed');

      // Delete individual message
      const deleteResult = await service.deleteMessage('msg-1' as MessageId);
      expect(deleteResult.error).toBeNull();
      expect(deleteResult.deleted).toBe(true);

      const remaining = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(remaining.messages).toHaveLength(1);
      expect(remaining.messages[0].id).toBe('msg-2');
    });

    it('should cascade delete messages when conversation is deleted', async () => {
      await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Test',
        createdAt: 1000,
        updatedAt: 1000,
      });

      await service.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Message 1',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      await service.createMessage({
        id: 'msg-2' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'assistant',
        content: 'Message 2',
        status: 'completed',
        timestamp: 2000,
        seq: 1,
      });

      // Delete conversation
      const deleteResult = await service.deleteConversation('conv-1' as ConversationId);
      expect(deleteResult.deleted).toBe(true);

      // Messages should be cascaded deleted
      const messages = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(messages.messages).toHaveLength(0);
    });

    it('should delete all messages by conversation ID', async () => {
      await conversationRepo.create({
        id: 'conv-1',
        workspace_id: 'ws-1',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      await service.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Message 1',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      await service.createMessage({
        id: 'msg-2' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'assistant',
        content: 'Message 2',
        status: 'completed',
        timestamp: 2000,
        seq: 1,
      });

      const deleteResult = await service.deleteMessagesByConversationId('conv-1' as ConversationId);
      expect(deleteResult.deleted).toBe(true);

      const messages = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(messages.messages).toHaveLength(0);
    });
  });

  describe('Multiple conversations and messages', () => {
    it('should handle multiple conversations with messages', async () => {
      // Create multiple conversations
      await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Conversation 1',
      });
      await service.createConversation({
        id: 'conv-2' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Conversation 2',
      });
      await service.createConversation({
        id: 'conv-3' as ConversationId,
        workspaceId: 'ws-2',
        title: 'Conversation 3',
      });

      // Add messages to conv-1
      await service.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Conv1 Msg 1',
        status: 'completed',
      });
      await service.createMessage({
        id: 'msg-2' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'assistant',
        content: 'Conv1 Msg 2',
        status: 'completed',
      });

      // Add messages to conv-2
      await service.createMessage({
        id: 'msg-3' as MessageId,
        conversationId: 'conv-2' as ConversationId,
        role: 'user',
        content: 'Conv2 Msg 1',
        status: 'completed',
      });

      // List all conversations
      const allConvs = await service.listConversations();
      expect(allConvs.conversations).toHaveLength(3);

      // List conversations filtered by workspace
      const ws1Convs = await service.listConversations('ws-1');
      expect(ws1Convs.conversations).toHaveLength(2);
      expect(ws1Convs.conversations.every(c => c.workspaceId === 'ws-1')).toBe(true);

      // Get messages for each conversation
      const conv1Messages = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(conv1Messages.messages).toHaveLength(2);

      const conv2Messages = await service.getMessagesByConversationId('conv-2' as ConversationId);
      expect(conv2Messages.messages).toHaveLength(1);

      const conv3Messages = await service.getMessagesByConversationId('conv-3' as ConversationId);
      expect(conv3Messages.messages).toHaveLength(0);
    });

    it('should order conversations by updatedAt DESC', async () => {
      await service.createConversation({ id: 'conv-1' as ConversationId, workspaceId: 'ws-1', title: 'Conv 1', createdAt: 1000, updatedAt: 1000 });
      await service.createConversation({ id: 'conv-2' as ConversationId, workspaceId: 'ws-1', title: 'Conv 2', createdAt: 2000, updatedAt: 3000 });
      await service.createConversation({ id: 'conv-3' as ConversationId, workspaceId: 'ws-1', title: 'Conv 3', createdAt: 3000, updatedAt: 2000 });

      const result = await service.listConversations('ws-1');

      expect(result.conversations[0].id).toBe('conv-2'); // updatedAt: 3000
      expect(result.conversations[1].id).toBe('conv-3'); // updatedAt: 2000
      expect(result.conversations[2].id).toBe('conv-1'); // updatedAt: 1000
    });
  });

  describe('Data integrity', () => {
    it('should preserve conversation metadata through updates', async () => {
      await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Test',
        metadata: { tags: ['important'], count: 5 },
      });

      const updateResult = await service.updateConversation('conv-1' as ConversationId, { title: 'Updated' });
      expect(updateResult.conversation!.metadata).toEqual({ tags: ['important'], count: 5 });
    });

    it('should preserve message metadata through updates', async () => {
      await conversationRepo.create({
        id: 'conv-1',
        workspace_id: 'ws-1',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      await service.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Hello',
        status: 'completed',
        metadata: { tokens: 10, model: 'test' },
      });

      const updateResult = await service.updateMessage('msg-1' as MessageId, { status: 'failed' });
      expect(updateResult.message!.metadata).toEqual({ tokens: 10, model: 'test' });
    });

    it('should maintain message ordering across operations', async () => {
      await conversationRepo.create({
        id: 'conv-1',
        workspace_id: 'ws-1',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      await service.createMessage({ id: 'msg-1' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: '1', status: 'completed', timestamp: 1000, seq: 0 });
      await service.createMessage({ id: 'msg-3' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: '3', status: 'completed', timestamp: 3000, seq: 2 });
      await service.createMessage({ id: 'msg-2' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'assistant', content: '2', status: 'completed', timestamp: 2000, seq: 1 });

      const result = await service.getMessagesByConversationId('conv-1' as ConversationId);
      expect(result.messages.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('should handle empty metadata', async () => {
      const result = await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Test',
        metadata: {},
      });
      expect(result.conversation!.metadata).toEqual({});
    });
  });

  describe('Error handling and recovery', () => {
    it('should handle database errors without corrupting subsequent operations', async () => {
      await service.createConversation({ id: 'conv-1' as ConversationId, workspaceId: 'ws-1', title: 'Test' });

      const updateResult = await service.updateConversation('non-existent' as ConversationId, { title: 'New' });
      expect(updateResult.error).not.toBeNull();

      const getResult = await service.getConversation('conv-1' as ConversationId);
      expect(getResult.error).toBeNull();
      expect(getResult.conversation).not.toBeNull();
    });

    it('should handle message update errors without affecting other messages', async () => {
      await conversationRepo.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Test', created_at: 1000, updated_at: 1000 });
      await service.createMessage({ id: 'msg-1' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await service.createMessage({ id: 'msg-2' as MessageId, conversationId: 'conv-1' as ConversationId, role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

      const updateResult = await service.updateMessage('non-existent' as MessageId, { content: 'Updated' });
      expect(updateResult.error).not.toBeNull();

      const msg1Result = await service.getMessage('msg-1' as MessageId);
      const msg2Result = await service.getMessage('msg-2' as MessageId);
      expect(msg1Result.message!.content).toBe('Msg 1');
      expect(msg2Result.message!.content).toBe('Msg 2');
    });

    it('should handle invalid input validation errors gracefully', async () => {
      const createResult = await service.createConversation({
        id: '' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Test',
      });
      expect(createResult.error).not.toBeNull();

      const validResult = await service.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Valid',
      });
      expect(validResult.error).toBeNull();
      expect(validResult.conversation).not.toBeNull();
    });
  });

  describe('File persistence', () => {
    let tempDir: string;
    let dbPath: string;
    let fs: typeof import('fs');
    let path: typeof import('path');
    let os: typeof import('os');

    beforeEach(async () => {
      fs = await import('fs');
      path = await import('path');
      os = await import('os');
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-integration-test-'));
      dbPath = path.join(tempDir, 'test.db');
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should persist data across close and reopen with shared foundation', async () => {
      const foundation1 = new FoundationPersistenceService(dbPath);
      await foundation1.init();
      const conversationRepo1 = new SqlJsConversationRepository(foundation1.getRawDatabase());
      const messageRepo1 = new SqlJsMessageRepository(foundation1.getRawDatabase());
      const service1 = new PersistenceService(conversationRepo1, messageRepo1, foundation1);

      await service1.createConversation({
        id: 'conv-1' as ConversationId,
        workspaceId: 'ws-1',
        title: 'Persisted',
        createdAt: 1000,
        updatedAt: 2000,
        metadata: { test: true },
      });

      await service1.createMessage({
        id: 'msg-1' as MessageId,
        conversationId: 'conv-1' as ConversationId,
        role: 'user',
        content: 'Hello!',
        status: 'completed',
        timestamp: 3000,
        seq: 0,
      });

      foundation1.save();
      foundation1.close();

      expect(fs.existsSync(dbPath)).toBe(true);

      // Phase 2: Reopen and verify
      const foundation2 = new FoundationPersistenceService(dbPath);
      await foundation2.init();
      const conversationRepo2 = new SqlJsConversationRepository(foundation2.getRawDatabase());
      const messageRepo2 = new SqlJsMessageRepository(foundation2.getRawDatabase());
      const service2 = new PersistenceService(conversationRepo2, messageRepo2, foundation2);

      const convResult = await service2.getConversation('conv-1' as ConversationId);
      expect(convResult.conversation).not.toBeNull();
      expect(convResult.conversation!.id).toBe('conv-1');
      expect(convResult.conversation!.title).toBe('Persisted');
      expect(convResult.conversation!.metadata).toEqual({ test: true });

      const msgResult = await service2.getMessage('msg-1' as MessageId);
      expect(msgResult.message).not.toBeNull();
      expect(msgResult.message!.content).toBe('Hello!');

      foundation2.close();
    });

    it('should persist updates across close and reopen', async () => {
      const foundation1 = new FoundationPersistenceService(dbPath);
      await foundation1.init();
      const conversationRepo1 = new SqlJsConversationRepository(foundation1.getRawDatabase());
      const service1 = new PersistenceService(conversationRepo1, new SqlJsMessageRepository(foundation1.getRawDatabase()), foundation1);

      await service1.createConversation({ id: 'conv-1' as ConversationId, workspaceId: 'ws-1', title: 'Original', createdAt: 1000, updatedAt: 1000 });
      await service1.updateConversation('conv-1' as ConversationId, { title: 'Updated' });

      foundation1.save();
      foundation1.close();

      const foundation2 = new FoundationPersistenceService(dbPath);
      await foundation2.init();
      const conversationRepo2 = new SqlJsConversationRepository(foundation2.getRawDatabase());
      const service2 = new PersistenceService(conversationRepo2, new SqlJsMessageRepository(foundation2.getRawDatabase()), foundation2);

      const result = await service2.getConversation('conv-1' as ConversationId);
      expect(result.conversation!.title).toBe('Updated');
      expect(result.conversation!.updatedAt).toBeGreaterThan(1000);

      foundation2.close();
    });
  });
});