import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  PersistenceService,
  SqlJsConversationRepository,
  CreateConversationInput,
  UpdateConversationInput,
} from './index.js';

describe('SqlJsConversationRepository', () => {
  let service: PersistenceService;
  let repository: SqlJsConversationRepository;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();
    repository = new SqlJsConversationRepository(service.getRawDatabase());
  });

  afterEach(async () => {
    service.close();
  });

  describe('create', () => {
    it('should create a conversation with all fields', async () => {
      const input: CreateConversationInput = {
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test Conversation',
        created_at: 1000,
        updated_at: 2000,
        metadata: { key: 'value' },
      };

      const result = await repository.create(input);

      expect(result.error).toBeNull();
      expect(result.conversation).not.toBeNull();
      expect(result.conversation!.id).toBe('conv-001');
      expect(result.conversation!.workspace_id).toBe('ws-001');
      expect(result.conversation!.title).toBe('Test Conversation');
      expect(result.conversation!.created_at).toBe(1000);
      expect(result.conversation!.updated_at).toBe(2000);
      expect(result.conversation!.metadata).toEqual({ key: 'value' });
    });

    it('should create a conversation with default timestamps', async () => {
      const before = Date.now();
      const input: CreateConversationInput = {
        id: 'conv-002',
        workspace_id: 'ws-001',
        title: 'Test Conversation 2',
      };

      const result = await repository.create(input);
      const after = Date.now();

      expect(result.error).toBeNull();
      expect(result.conversation).not.toBeNull();
      expect(result.conversation!.created_at).toBeGreaterThanOrEqual(before);
      expect(result.conversation!.created_at).toBeLessThanOrEqual(after);
      expect(result.conversation!.updated_at).toBeGreaterThanOrEqual(before);
      expect(result.conversation!.updated_at).toBeLessThanOrEqual(after);
      expect(result.conversation!.metadata).toEqual({});
    });

    it('should create a conversation with empty metadata', async () => {
      const input: CreateConversationInput = {
        id: 'conv-003',
        workspace_id: 'ws-001',
        title: 'Test Conversation 3',
        metadata: {},
      };

      const result = await repository.create(input);

      expect(result.error).toBeNull();
      expect(result.conversation!.metadata).toEqual({});
    });

    it('should reject invalid conversation input', async () => {
      const input: CreateConversationInput = {
        id: '',
        workspace_id: 'ws-001',
        title: 'Test',
      };

      const result = await repository.create(input);

      expect(result.error).not.toBeNull();
      expect(result.conversation).toBeNull();
      expect(result.error!.name).toBe('PersistenceError');
    });

    it('should reject conversation with empty workspace_id', async () => {
      const input: CreateConversationInput = {
        id: 'conv-004',
        workspace_id: '',
        title: 'Test',
      };

      const result = await repository.create(input);

      expect(result.error).not.toBeNull();
      expect(result.conversation).toBeNull();
    });

    it('should reject conversation with empty title', async () => {
      const input: CreateConversationInput = {
        id: 'conv-005',
        workspace_id: 'ws-001',
        title: '',
      };

      const result = await repository.create(input);

      expect(result.error).not.toBeNull();
      expect(result.conversation).toBeNull();
    });
  });

  describe('getById', () => {
    it('should retrieve a conversation by ID', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test Conversation',
        created_at: 1000,
        updated_at: 2000,
        metadata: { key: 'value' },
      });

      const result = await repository.getById('conv-001');

      expect(result.error).toBeNull();
      expect(result.conversation).not.toBeNull();
      expect(result.conversation!.id).toBe('conv-001');
      expect(result.conversation!.title).toBe('Test Conversation');
      expect(result.conversation!.metadata).toEqual({ key: 'value' });
    });

    it('should return null for non-existent conversation', async () => {
      const result = await repository.getById('non-existent');

      expect(result.error).toBeNull();
      expect(result.conversation).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all conversations', async () => {
      await repository.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Conv 1', created_at: 1000, updated_at: 1000 });
      await repository.create({ id: 'conv-2', workspace_id: 'ws-1', title: 'Conv 2', created_at: 2000, updated_at: 2000 });
      await repository.create({ id: 'conv-3', workspace_id: 'ws-2', title: 'Conv 3', created_at: 3000, updated_at: 3000 });

      const result = await repository.list();

      expect(result.error).toBeNull();
      expect(result.conversations).toHaveLength(3);
    });

    it('should list conversations filtered by workspace', async () => {
      await repository.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Conv 1', created_at: 1000, updated_at: 1000 });
      await repository.create({ id: 'conv-2', workspace_id: 'ws-1', title: 'Conv 2', created_at: 2000, updated_at: 2000 });
      await repository.create({ id: 'conv-3', workspace_id: 'ws-2', title: 'Conv 3', created_at: 3000, updated_at: 3000 });

      const result = await repository.list('ws-1');

      expect(result.error).toBeNull();
      expect(result.conversations).toHaveLength(2);
      expect(result.conversations.every(c => c.workspace_id === 'ws-1')).toBe(true);
    });

    it('should return conversations ordered by updated_at DESC', async () => {
      await repository.create({ id: 'conv-1', workspace_id: 'ws-1', title: 'Conv 1', created_at: 1000, updated_at: 1000 });
      await repository.create({ id: 'conv-2', workspace_id: 'ws-1', title: 'Conv 2', created_at: 2000, updated_at: 3000 });
      await repository.create({ id: 'conv-3', workspace_id: 'ws-1', title: 'Conv 3', created_at: 3000, updated_at: 2000 });

      const result = await repository.list('ws-1');

      expect(result.error).toBeNull();
      expect(result.conversations[0].id).toBe('conv-2');
      expect(result.conversations[1].id).toBe('conv-3');
      expect(result.conversations[2].id).toBe('conv-1');
    });

    it('should return empty list when no conversations exist', async () => {
      const result = await repository.list();

      expect(result.error).toBeNull();
      expect(result.conversations).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update conversation title', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Original Title',
        created_at: 1000,
        updated_at: 1000,
      });

      const result = await repository.update('conv-001', { title: 'Updated Title' });

      expect(result.error).toBeNull();
      expect(result.conversation).not.toBeNull();
      expect(result.conversation!.title).toBe('Updated Title');
      expect(result.conversation!.updated_at).toBeGreaterThan(1000);
      expect(result.conversation!.created_at).toBe(1000);
      expect(result.conversation!.id).toBe('conv-001');
      expect(result.conversation!.workspace_id).toBe('ws-001');
    });

    it('should update conversation metadata', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
        metadata: { original: true },
      });

      const result = await repository.update('conv-001', { metadata: { updated: true, count: 5 } });

      expect(result.error).toBeNull();
      expect(result.conversation!.metadata).toEqual({ updated: true, count: 5 });
    });

    it('should update both title and metadata', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Original',
        created_at: 1000,
        updated_at: 1000,
        metadata: { a: 1 },
      });

      const result = await repository.update('conv-001', { title: 'New Title', metadata: { b: 2 } });

      expect(result.error).toBeNull();
      expect(result.conversation!.title).toBe('New Title');
      expect(result.conversation!.metadata).toEqual({ b: 2 });
    });

    it('should preserve immutable fields (id, workspace_id, created_at)', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      const result = await repository.update('conv-001', { title: 'Updated' });

      expect(result.error).toBeNull();
      expect(result.conversation!.id).toBe('conv-001');
      expect(result.conversation!.workspace_id).toBe('ws-001');
      expect(result.conversation!.created_at).toBe(1000);
    });

    it('should return error for non-existent conversation', async () => {
      const result = await repository.update('non-existent', { title: 'New Title' });

      expect(result.error).not.toBeNull();
      expect(result.conversation).toBeNull();
      expect(result.error!.name).toBe('PersistenceError');
    });

    it('should reject invalid title (empty)', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      const result = await repository.update('conv-001', { title: '' });

      expect(result.error).not.toBeNull();
      expect(result.conversation).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing conversation', async () => {
      await repository.create({
        id: 'conv-001',
        workspace_id: 'ws-001',
        title: 'Test',
        created_at: 1000,
        updated_at: 1000,
      });

      const result = await repository.delete('conv-001');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(true);

      const getResult = await repository.getById('conv-001');
      expect(getResult.conversation).toBeNull();
    });

    it('should return deleted=false for non-existent conversation', async () => {
      const result = await repository.delete('non-existent');

      expect(result.error).toBeNull();
      expect(result.deleted).toBe(false);
    });
  });
});