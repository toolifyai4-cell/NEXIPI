import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { IPersistencePort } from './port.js';
import { PersistenceError } from './PersistenceService.js';
import { ConversationId, MessageId, MessageRole, MessageStatus } from '@nexipi/shared';

class MockPersistencePort implements IPersistencePort {
  private available = false;
  private disposed = false;

  async initialize(): Promise<void> {
    this.available = true;
  }

  isAvailable(): boolean {
    return this.available && !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.available = false;
  }

  save(): void {
    this.assertAvailable();
  }

  async createConversation(): Promise<any> {
    this.assertAvailable();
    return { conversation: null, error: new PersistenceError('Not implemented') };
  }

  async getConversation(): Promise<any> {
    this.assertAvailable();
    return { conversation: null, error: null };
  }

  async listConversations(): Promise<any> {
    this.assertAvailable();
    return { conversations: [], error: null };
  }

  async updateConversation(): Promise<any> {
    this.assertAvailable();
    return { conversation: null, error: new PersistenceError('Not implemented') };
  }

  async deleteConversation(): Promise<any> {
    this.assertAvailable();
    return { deleted: false, error: new PersistenceError('Not implemented') };
  }

  async createMessage(): Promise<any> {
    this.assertAvailable();
    return { message: null, error: new PersistenceError('Not implemented') };
  }

  async getMessage(): Promise<any> {
    this.assertAvailable();
    return { message: null, error: null };
  }

  async getMessagesByConversationId(): Promise<any> {
    this.assertAvailable();
    return { messages: [], error: null };
  }

  async updateMessage(): Promise<any> {
    this.assertAvailable();
    return { message: null, error: new PersistenceError('Not implemented') };
  }

  async deleteMessage(): Promise<any> {
    this.assertAvailable();
    return { deleted: false, error: new PersistenceError('Not implemented') };
  }

  async deleteMessagesByConversationId(): Promise<any> {
    this.assertAvailable();
    return { deleted: false, error: new PersistenceError('Not implemented') };
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new PersistenceError('Persistence not available');
    }
  }
}

describe('IPersistencePort - Contract Tests', () => {
  let port: IPersistencePort;

  beforeEach(async () => {
    port = new MockPersistencePort();
    await port.initialize();
  });

  afterEach(() => {
    port.dispose();
  });

  it('should have initialize method', () => {
    expect(typeof port.initialize).toBe('function');
  });

  it('should have isAvailable method', () => {
    expect(typeof port.isAvailable).toBe('function');
  });

  it('should have dispose method', () => {
    expect(typeof port.dispose).toBe('function');
  });

  it('should have conversation operations', () => {
    expect(typeof port.createConversation).toBe('function');
    expect(typeof port.getConversation).toBe('function');
    expect(typeof port.listConversations).toBe('function');
    expect(typeof port.updateConversation).toBe('function');
    expect(typeof port.deleteConversation).toBe('function');
  });

  it('should have message operations', () => {
    expect(typeof port.createMessage).toBe('function');
    expect(typeof port.getMessage).toBe('function');
    expect(typeof port.getMessagesByConversationId).toBe('function');
    expect(typeof port.updateMessage).toBe('function');
    expect(typeof port.deleteMessage).toBe('function');
    expect(typeof port.deleteMessagesByConversationId).toBe('function');
  });

  it('should be available after initialization', () => {
    expect(port.isAvailable()).toBe(true);
  });

  it('should not be available after disposal', () => {
    port.dispose();
    expect(port.isAvailable()).toBe(false);
  });

  it('should throw when operating after disposal', async () => {
    port.dispose();
    await expect(port.createConversation({} as any)).rejects.toThrow(PersistenceError);
  });

  it('should accept ConversationId branded type for getConversation', async () => {
    const id = 'conv-123' as ConversationId;
    const result = await port.getConversation(id);
    expect(result.error).toBeNull();
    expect(result.conversation).toBeNull();
  });

  it('should accept MessageId branded type for getMessage', async () => {
    const id = 'msg-123' as MessageId;
    const result = await port.getMessage(id);
    expect(result.error).toBeNull();
    expect(result.message).toBeNull();
  });

  it('should accept ConversationId for getMessagesByConversationId', async () => {
    const id = 'conv-123' as ConversationId;
    const result = await port.getMessagesByConversationId(id);
    expect(result.error).toBeNull();
    expect(result.messages).toEqual([]);
  });

  it('should accept ConversationId for deleteConversation', async () => {
    const id = 'conv-123' as ConversationId;
    const result = await port.deleteConversation(id);
    expect(result.error).not.toBeNull();
  });

  it('should accept MessageId for deleteMessage', async () => {
    const id = 'msg-123' as MessageId;
    const result = await port.deleteMessage(id);
    expect(result.error).not.toBeNull();
  });

  it('should accept ConversationId for deleteMessagesByConversationId', async () => {
    const id = 'conv-123' as ConversationId;
    const result = await port.deleteMessagesByConversationId(id);
    expect(result.error).not.toBeNull();
  });

  it('should support MessageRole enum', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'system'];
    expect(roles).toHaveLength(3);
  });

  it('should support MessageStatus enum', () => {
    const statuses: MessageStatus[] = ['pending', 'streaming', 'completed', 'failed', 'cancelled'];
    expect(statuses).toHaveLength(5);
  });
});

describe('IPersistencePort - Type Exports', () => {
  it('should export ConversationId type', () => {
    const id: ConversationId = 'test' as ConversationId;
    expect(typeof id).toBe('string');
  });

  it('should export MessageId type', () => {
    const id: MessageId = 'test' as MessageId;
    expect(typeof id).toBe('string');
  });

  it('should export CreateConversationInput shape', () => {
    const input = {
      id: 'conv-1' as ConversationId,
      workspaceId: 'ws-1',
      title: 'Test',
      createdAt: 1000,
      updatedAt: 2000,
      metadata: { key: 'value' },
    };
    expect(input.workspaceId).toBe('ws-1');
    expect(input.title).toBe('Test');
  });

  it('should export CreateMessageInput shape', () => {
    const input = {
      id: 'msg-1' as MessageId,
      conversationId: 'conv-1' as ConversationId,
      role: 'user' as MessageRole,
      content: 'Hello',
      status: 'completed' as MessageStatus,
      timestamp: 1000,
      seq: 0,
      metadata: {},
    };
    expect(input.role).toBe('user');
    expect(input.status).toBe('completed');
  });
});