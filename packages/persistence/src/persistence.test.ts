import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { PersistenceService, Conversation, Message, SQLStatement, SQLDatabase } from './PersistenceService.js';

let sqlModule: any = null;
let DatabaseClass: any = null;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  DatabaseClass = sqlModule.Database;
});
describe('PersistenceService - Database Initialization', () => {
  it('should initialize database and have close method', async () => {
    const service = new PersistenceService();
    await service.init();
    expect(service.getRawDatabase()).toBeDefined();
    expect(typeof service.getRawDatabase().close).toBe('function');
    await service.close();
  });

  it('should initialize database and have export method', async () => {
    const service = new PersistenceService();
    await service.init();
    const exported = service.exportDatabase();
    expect(exported).toBeInstanceOf(Uint8Array);
    await service.close();
  });
});
describe('PersistenceService - Conversation Persistence', () => {
  let service: PersistenceService;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();

    const db = service.getRawDatabase();
    // Create conversations table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
  });

  afterEach(async () => {
    await service.close();
  });

  it('should save and retrieve a conversation', async () => {
    const conversation: Conversation = {
      id: 'conv-001',
      workspace_id: 'ws-001',
      title: 'Test Conversation',
      created_at: Date.now(),
      updated_at: Date.now(),
      metadata: { key: 'value' },
    };

    const db = service.getRawDatabase();
    const sql = `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES ('${conversation.id}', '${conversation.workspace_id}', '${conversation.title}', ${conversation.created_at}, ${conversation.updated_at}, '${JSON.stringify(conversation.metadata)}')`;
    db.exec(sql);

    const result = db.exec('SELECT count(*) as count FROM conversations');
    expect((result as any)[0]['count']).toBe(1);
  });

  it('should handle multiple conversations', async () => {
    const db = service.getRawDatabase();

    for (let i = 0; i < 3; i++) {
      const conversation: Conversation = {
        id: `conv-${i}`,
        workspace_id: `ws-${i}`,
        title: `Conv ${i}`,
        created_at: Date.now(),
        updated_at: Date.now(),
        metadata: {},
      };
      const sql = `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES ('${conversation.id}', '${conversation.workspace_id}', '${conversation.title}', ${conversation.created_at}, ${conversation.updated_at}, '${JSON.stringify(conversation.metadata)}')`;
      db.exec(sql);
    }

    const result = db.exec('SELECT count(*) as count FROM conversations');
    expect((result as any)[0]['count']).toBe(3);

    await service.close();
  });
});
describe('PersistenceService - Message Persistence', () => {
  let service: PersistenceService;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();
  });

  afterEach(async () => {
    await service.close();
  });

  it('should save and retrieve messages', async () => {
    const db = service.getRawDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        conversation_id TEXT,
        role TEXT,
        content TEXT,
        status TEXT,
        timestamp INTEGER,
        seq INTEGER,
        metadata TEXT
      )
    `);

    const message: Message = {
      id: 'msg-001',
      conversation_id: 'conv-001',
      role: 'user',
      content: 'Hello, world!',
      status: 'completed',
      timestamp: Date.now(),
      seq: 0,
      metadata: {},
    };

    const sql = `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES ('${message.id}', '${message.conversation_id}', '${message.role}', '${message.content}', '${message.status}', ${message.timestamp}, ${message.seq}, '${JSON.stringify(message.metadata)}')`;
    db.exec(sql);

    const result = db.exec('SELECT count(*) as count FROM messages');
    expect((result as any)[0]['count']).toBe(1);
  });

  it('should handle empty message content', async () => {
    const db = service.getRawDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        conversation_id TEXT,
        role TEXT,
        content TEXT,
        status TEXT,
        timestamp INTEGER,
        seq INTEGER,
        metadata TEXT
      )
    `);

    const sql = `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES ('msg-empty', 'conv-001', 'user', '', 'completed', ${Date.now()}, 0, '{}')`;
    db.exec(sql);

    const result = db.exec("SELECT count(*) as count FROM messages WHERE id = 'msg-empty'");
    expect((result as any)[0]['count']).toBe(1);
  });
});
describe('PersistenceService - Close/Reopen Persistence', () => {
  it('should close and reopen database', async () => {
    const service = new PersistenceService();
    await service.init();

    // Verify database is open
    expect(service.getRawDatabase()).toBeDefined();

    // Close the database
    await service.close();

    // Create a new service instance
    const service2 = new PersistenceService();
    await service2.init();
    expect(service2.getRawDatabase()).toBeDefined();
    await service2.close();
  });
});

describe('PersistenceService - Error Handling', () => {
  it('should throw error when accessing uninitialized database', async () => {
    const service = new PersistenceService(); // No init() called
    await expect(() => service.exportDatabase()).toThrow('Database not initialized');
  });

  it('should not throw when closing uninitialized database', async () => {
    const service = new PersistenceService(); // No init() called
    await expect(service.close()).resolves.toBeUndefined();
  });
});