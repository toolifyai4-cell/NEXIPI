import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  PersistenceService as FoundationPersistenceService,
} from './PersistenceService.js';
import {
  SqlJsConversationRepository,
  SqlJsMessageRepository,
  CreateConversationInput,
  CreateMessageInput,
  UpdateMessageInput,
} from './repositories.js';

describe('SqlJsMessageRepository', () => {
  let service: FoundationPersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;

  beforeEach(async () => {
    service = new FoundationPersistenceService();
    await service.init();
    conversationRepo = new SqlJsConversationRepository(service.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(service.getRawDatabase());

    // Create a conversation for messages
    await conversationRepo.create({
      id: 'conv-001',
      workspace_id: 'ws-001',
      title: 'Test Conversation',
      created_at: 1000,
      updated_at: 1000,
    });
  });

  afterEach(async () => {
    service.close();
  });

  describe('create', () => {
    it('should create a user message', async () => {
      const input: CreateMessageInput = {
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello, world!',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
        metadata: { source: 'test' },
      };

      const result = await messageRepo.create(input);

      expect(result.error).toBeNull();
      expect(result.message).not.toBeNull();
      expect(result.message!.id).toBe('msg-001');
      expect(result.message!.conversation_id).toBe('conv-001');
      expect(result.message!.role).toBe('user');
      expect(result.message!.content).toBe('Hello, world!');
      expect(result.message!.status).toBe('completed');
      expect(result.message!.timestamp).toBe(1000);
      expect(result.message!.seq).toBe(0);
      expect(result.message!.metadata).toEqual({ source: 'test' });
    });

    it('should create an assistant message', async () => {
      const input: CreateMessageInput = {
        id: 'msg-002',
        conversation_id: 'conv-001',
        role: 'assistant',
        content: 'Hello! How can I help?',
        status: 'completed',
        timestamp: 2000,
        seq: 1,
      };

      const result = await messageRepo.create(input);

      expect(result.error).toBeNull();
      expect(result.message!.role).toBe('assistant');
    });

    it('should create a system message', async () => {
      const input: CreateMessageInput = {
        id: 'msg-003',
        conversation_id: 'conv-001',
        role: 'system',
        content: 'System prompt',
        status: 'completed',
      };

      const result = await messageRepo.create(input);

      expect(result.error).toBeNull();
      expect(result.message!.role).toBe('system');
    });

    it('should create a message with empty content', async () => {
      const input: CreateMessageInput = {
        id: 'msg-empty',
        conversation_id: 'conv-001',
        role: 'assistant',
        content: '',
        status: 'streaming',
      };

      const result = await messageRepo.create(input);

      expect(result.error).toBeNull();
      expect(result.message!.content).toBe('');
      expect(result.message!.status).toBe('streaming');
    });

    it('should create a message with default timestamp and seq', async () => {
      const before = Date.now();
      const input: CreateMessageInput = {
        id: 'msg-004',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Test',
        status: 'pending',
      };

      const result = await messageRepo.create(input);
      const after = Date.now();

      expect(result.error).toBeNull();
      expect(result.message!.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.message!.timestamp).toBeLessThanOrEqual(after);
      expect(result.message!.seq).toBe(0);
    });

    it('should reject message with non-existent conversation', async () => {
      const input: CreateMessageInput = {
        id: 'msg-001',
        conversation_id: 'non-existent',
        role: 'user',
        content: 'Hello',
        status: 'completed',
      };

      const result = await messageRepo.create(input);

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });

    it('should reject invalid message input (empty id)', async () => {
      const input: CreateMessageInput = {
        id: '',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
      };

      const result = await messageRepo.create(input);

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });

    it('should reject invalid role', async () => {
      const input: CreateMessageInput = {
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'invalid' as 'user' | 'assistant' | 'system',
        content: 'Hello',
        status: 'completed',
      };

      const result = await messageRepo.create(input);

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });

    it('should reject invalid status', async () => {
      const input: CreateMessageInput = {
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'invalid' as 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled',
      };

      const result = await messageRepo.create(input);

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });
  });

  describe('getById', () => {
    it('should retrieve a message by ID', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.getById('msg-001');

      expect(result.error).toBeNull();
      expect(result.message).not.toBeNull();
      expect(result.message!.id).toBe('msg-001');
      expect(result.message!.content).toBe('Hello');
    });

    it('should return null for non-existent message', async () => {
      const result = await messageRepo.getById('non-existent');

      expect(result.error).toBeNull();
      expect(result.message).toBeNull();
    });
  });

  describe('getByConversationId', () => {
    it('should retrieve all messages for a conversation', async () => {
      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });
      await messageRepo.create({ id: 'msg-3', conversation_id: 'conv-001', role: 'user', content: 'Msg 3', status: 'completed', timestamp: 3000, seq: 2 });

      const result = await messageRepo.getByConversationId('conv-001');

      expect(result.error).toBeNull();
      expect(result.messages).toHaveLength(3);
    });

    it('should return messages in chronological order (timestamp ASC, seq ASC)', async () => {
      await messageRepo.create({ id: 'msg-3', conversation_id: 'conv-001', role: 'user', content: 'Msg 3', status: 'completed', timestamp: 3000, seq: 2 });
      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

      const result = await messageRepo.getByConversationId('conv-001');

      expect(result.error).toBeNull();
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[1].id).toBe('msg-2');
      expect(result.messages[2].id).toBe('msg-3');
    });

    it('should handle messages with same timestamp ordered by seq', async () => {
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 1000, seq: 1 });
      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });

      const result = await messageRepo.getByConversationId('conv-001');

      expect(result.error).toBeNull();
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[1].id).toBe('msg-2');
    });

    it('should return empty list for conversation with no messages', async () => {
      await conversationRepo.create({ id: 'conv-002', workspace_id: 'ws-001', title: 'Empty', created_at: 1000, updated_at: 1000 });

      const result = await messageRepo.getByConversationId('conv-002');

      expect(result.error).toBeNull();
      expect(result.messages).toHaveLength(0);
    });

    it('should return empty list for non-existent conversation', async () => {
      const result = await messageRepo.getByConversationId('non-existent');

      expect(result.error).toBeNull();
      expect(result.messages).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update message content', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'assistant',
        content: 'Original',
        status: 'streaming',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.update('msg-001', { content: 'Updated content' });

      expect(result.error).toBeNull();
      expect(result.message!.content).toBe('Updated content');
      expect(result.message!.status).toBe('streaming');
      expect(result.message!.id).toBe('msg-001');
    });

    it('should update message status', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'assistant',
        content: 'Hello',
        status: 'streaming',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.update('msg-001', { status: 'completed' });

      expect(result.error).toBeNull();
      expect(result.message!.status).toBe('completed');
    });

    it('should update message metadata', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
        metadata: { original: true },
      });

      const result = await messageRepo.update('msg-001', { metadata: { updated: true, tokens: 100 } });

      expect(result.error).toBeNull();
      expect(result.message!.metadata).toEqual({ updated: true, tokens: 100 });
    });

    it('should update content and status together', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'assistant',
        content: 'Partial',
        status: 'streaming',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.update('msg-001', { content: 'Complete response', status: 'completed' });

      expect(result.error).toBeNull();
      expect(result.message!.content).toBe('Complete response');
      expect(result.message!.status).toBe('completed');
    });

    it('should preserve immutable fields (id, conversation_id, role, timestamp, seq)', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 5,
      });

      const result = await messageRepo.update('msg-001', { content: 'Updated', status: 'failed' });

      expect(result.error).toBeNull();
      expect(result.message!.id).toBe('msg-001');
      expect(result.message!.conversation_id).toBe('conv-001');
      expect(result.message!.role).toBe('user');
      expect(result.message!.timestamp).toBe(1000);
      expect(result.message!.seq).toBe(5);
    });

    it('should return error for non-existent message', async () => {
      const result = await messageRepo.update('non-existent', { content: 'Updated' });

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });

    it('should reject invalid status', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.update('msg-001', { status: 'invalid' as 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' });

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an individual message', async () => {
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      const result = await messageRepo.delete('msg-001');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(true);

      const getResult = await messageRepo.getById('msg-001');
      expect(getResult.message).toBeNull();
    });

    it('should return deleted=false for non-existent message', async () => {
      const result = await messageRepo.delete('non-existent');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(false);
    });
  });

  describe('deleteByConversationId', () => {
    it('should delete all messages for a conversation', async () => {
      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

      const result = await messageRepo.deleteByConversationId('conv-001');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(true);

      const getResult = await messageRepo.getByConversationId('conv-001');
      expect(getResult.messages).toHaveLength(0);
    });

    it('should return deleted=false for conversation with no messages', async () => {
      await conversationRepo.create({ id: 'conv-002', workspace_id: 'ws-001', title: 'Empty', created_at: 1000, updated_at: 1000 });

      const result = await messageRepo.deleteByConversationId('conv-002');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(false);
    });
  });
});