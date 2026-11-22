import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PersistenceService,
  SqlJsConversationRepository,
  SqlJsMessageRepository,
  CreateConversationInput,
  CreateMessageInput,
} from './index.js';

describe('Repository Integrity Tests', () => {
  let service: PersistenceService;
  let conversationRepo: SqlJsConversationRepository;
  let messageRepo: SqlJsMessageRepository;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();
    conversationRepo = new SqlJsConversationRepository(service.getRawDatabase());
    messageRepo = new SqlJsMessageRepository(service.getRawDatabase());
  });

  afterEach(async () => {
    service.close();
  });

  describe('Foreign key constraints and cascading', () => {
    it('should cascade delete messages when conversation is deleted via repository', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });
      await messageRepo.create({ id: 'msg-001', conversation_id: 'conv-001', role: 'user', content: 'Hello', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-002', conversation_id: 'conv-001', role: 'assistant', content: 'Hi', status: 'completed', timestamp: 2000, seq: 1 });

      const deleteResult = await conversationRepo.delete('conv-001');

      expect(deleteResult.deleted).toBe(true);

      const messagesResult = await messageRepo.getByConversationId('conv-001');
      expect(messagesResult.messages).toHaveLength(0);
    });

    it('should enforce foreign key constraint when creating message for non-existent conversation', async () => {
      const result = await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'non-existent-conv',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
      });

      expect(result.error).not.toBeNull();
      expect(result.message).toBeNull();
    });
  });

  describe('Shared database instance', () => {
    it('should allow multiple repository instances to use the same PersistenceService', async () => {
      const conversationRepo2 = new SqlJsConversationRepository(service.getRawDatabase());
      const messageRepo2 = new SqlJsMessageRepository(service.getRawDatabase());

      await conversationRepo.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Conv 1', created_at: 1000, updated_at: 1000 });
      await conversationRepo2.create({ id: 'conv-2', workspace_id: 'ws-1', title: 'Conv 2', created_at: 2000, updated_at: 2000 });

      const listResult = await conversationRepo.list();
      expect(listResult.conversations).toHaveLength(2);

      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-1', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo2.create({ id: 'msg-2', conversation_id: 'conv-2', role: 'user', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 0 });

      const msgs1 = await messageRepo.getByConversationId('conv-1');
      const msgs2 = await messageRepo2.getByConversationId('conv-2');
      expect(msgs1.messages).toHaveLength(1);
      expect(msgs2.messages).toHaveLength(1);
    });

    it('should not close the shared database when repository operations complete', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });
      await messageRepo.create({ id: 'msg-001', conversation_id: 'conv-001', role: 'user', content: 'Hello', status: 'completed', timestamp: 1000, seq: 0 });

      expect(service.isInitialized()).toBe(true);

      const result = await conversationRepo.getById('conv-001');
      expect(result.conversation).not.toBeNull();

      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('Error handling and recovery', () => {
    it('should handle database errors without corrupting subsequent operations', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });

      const updateResult = await conversationRepo.update('non-existent', { title: 'New' });
      expect(updateResult.error).not.toBeNull();

      const getResult = await conversationRepo.getById('conv-001');
      expect(getResult.error).toBeNull();
      expect(getResult.conversation).not.toBeNull();
    });

    it('should handle message update errors without affecting other messages', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });
      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: 'Msg 1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: 'Msg 2', status: 'completed', timestamp: 2000, seq: 1 });

      const updateResult = await messageRepo.update('non-existent', { content: 'Updated' });
      expect(updateResult.error).not.toBeNull();

      const msg1Result = await messageRepo.getById('msg-1');
      const msg2Result = await messageRepo.getById('msg-2');
      expect(msg1Result.message!.content).toBe('Msg 1');
      expect(msg2Result.message!.content).toBe('Msg 2');
    });

    it('should handle invalid input validation errors gracefully', async () => {
      const createResult = await conversationRepo.create({
        id: '',
        workspace_id: 'ws-001',
        title: 'Test',
      });
      expect(createResult.error).not.toBeNull();

      const validResult = await conversationRepo.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Valid',
        created_at: 1000,
        updated_at: 1000,
      });
      expect(validResult.error).toBeNull();
      expect(validResult.conversation).not.toBeNull();
    });
  });

  describe('Transaction-like behavior', () => {
    it('should not leave partially written data on conversation creation failure', async () => {
      const result = await conversationRepo.create({
        id: '',
        workspace_id: 'ws-001',
        title: 'Test',
      });
      expect(result.error).not.toBeNull();

      const listResult = await conversationRepo.list();
      expect(listResult.conversations).toHaveLength(0);
    });

    it('should not leave partially written data on message creation failure', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });

      const result = await messageRepo.create({
        id: '',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Test',
        status: 'completed',
      });
      expect(result.error).not.toBeNull();

      const messagesResult = await messageRepo.getByConversationId('conv-001');
      expect(messagesResult.messages).toHaveLength(0);
    });
  });

  describe('Data consistency', () => {
    it('should preserve conversation metadata through updates', async () => {
      await conversationRepo.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
        metadata: { tags: ['important'], count: 5 },
      });

      const updateResult = await conversationRepo.update('conv-001', { title: 'Updated' });
      expect(updateResult.conversation!.metadata).toEqual({ tags: ['important'], count: 5 });
    });

    it('should preserve message metadata through updates', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });
      await messageRepo.create({
        id: 'msg-001',
        conversation_id: 'conv-001',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        timestamp: 1000,
        seq: 0,
        metadata: { tokens: 10, model: 'test' },
      });

      const updateResult = await messageRepo.update('msg-001', { status: 'failed' });
      expect(updateResult.message!.metadata).toEqual({ tokens: 10, model: 'test' });
    });

    it('should maintain message ordering across multiple operations', async () => {
      await conversationRepo.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Test', created_at: 1000, updated_at: 1000 });

      await messageRepo.create({ id: 'msg-1', conversation_id: 'conv-001', role: 'user', content: '1', status: 'completed', timestamp: 1000, seq: 0 });
      await messageRepo.create({ id: 'msg-3', conversation_id: 'conv-001', role: 'user', content: '3', status: 'completed', timestamp: 3000, seq: 2 });
      await messageRepo.create({ id: 'msg-2', conversation_id: 'conv-001', role: 'assistant', content: '2', status: 'completed', timestamp: 2000, seq: 1 });

      const result = await messageRepo.getByConversationId('conv-001');
      expect(result.messages.map(m => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });
  });
});

describe('Repository File Persistence Tests', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-repo-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should persist conversations across close and reopen', async () => {
    const service1 = new PersistenceService(dbPath);
    await service1.init();
    const conversationRepo1 = new SqlJsConversationRepository(service1.getRawDatabase());
    const messageRepo1 = new SqlJsMessageRepository(service1.getRawDatabase());

    await conversationRepo1.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Persisted', created_at: 1000, updated_at: 2000, metadata: { test: true } });
    await messageRepo1.create({ id: 'msg-001', conversation_id: 'conv-001', role: 'user', content: 'Hello!', status: 'completed', timestamp: 3000, seq: 0 });

    service1.save();
    service1.close();

    expect(fs.existsSync(dbPath)).toBe(true);

    const service2 = new PersistenceService(dbPath);
    await service2.init();
    const conversationRepo2 = new SqlJsConversationRepository(service2.getRawDatabase());
    const messageRepo2 = new SqlJsMessageRepository(service2.getRawDatabase());

    const convResult = await conversationRepo2.getById('conv-001');
    expect(convResult.conversation).not.toBeNull();
    expect(convResult.conversation!.id).toBe('conv-001');
    expect(convResult.conversation!.title).toBe('Persisted');
    expect(convResult.conversation!.metadata).toEqual({ test: true });

    const msgResult = await messageRepo2.getById('msg-001');
    expect(msgResult.message).not.toBeNull();
    expect(msgResult.message!.content).toBe('Hello!');

    service2.close();
  });

  it('should persist updates across close and reopen', async () => {
    const service1 = new PersistenceService(dbPath);
    await service1.init();
    const conversationRepo1 = new SqlJsConversationRepository(service1.getRawDatabase());

    await conversationRepo1.create({ id: 'conv-001', workspace_id: 'ws-001', title: 'Original', created_at: 1000, updated_at: 1000 });
    await conversationRepo1.update('conv-001', { title: 'Updated' });

    service1.save();
    service1.close();

    const service2 = new PersistenceService(dbPath);
    await service2.init();
    const conversationRepo2 = new SqlJsConversationRepository(service2.getRawDatabase());

    const result = await conversationRepo2.getById('conv-001');
    expect(result.conversation!.title).toBe('Updated');
    expect(result.conversation!.updated_at).toBeGreaterThan(1000);

    service2.close();
  });

  it('should handle multiple save/close/reopen cycles with repositories', async () => {
    // Cycle 1
    const service1 = new PersistenceService(dbPath);
    await service1.init();
    const conversationRepo1 = new SqlJsConversationRepository(service1.getRawDatabase());
    await conversationRepo1.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Conv 1', created_at: 1000, updated_at: 1000 });
    service1.save();
    service1.close();

    // Cycle 2
    const service2 = new PersistenceService(dbPath);
    await service2.init();
    const conversationRepo2 = new SqlJsConversationRepository(service2.getRawDatabase());
    await conversationRepo2.create({ id: 'conv-2', workspace_id: 'ws-1', title: 'Conv 2', created_at: 2000, updated_at: 2000 });
    service2.save();
    service2.close();

    // Cycle 3
    const service3 = new PersistenceService(dbPath);
    await service3.init();
    const conversationRepo3 = new SqlJsConversationRepository(service3.getRawDatabase());
    const listResult = await conversationRepo3.list();
    expect(listResult.conversations).toHaveLength(2);
    service3.close();
  });
});