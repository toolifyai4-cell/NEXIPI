import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PersistenceService,
  Conversation,
  Message,
  SQLDatabase,
  PersistenceError,
} from './PersistenceService.js';

function getCountResult(result: { columns: string[]; values: unknown[][] }[]): number {
  if (result.length === 0 || result[0].values.length === 0) {
    return 0;
  }
  return result[0].values[0][0] as number;
}

describe('PersistenceService - Database Initialization', () => {
  it('should initialize database and have close method', async () => {
    const service = new PersistenceService();
    await service.init();
    expect(service.getRawDatabase()).toBeDefined();
    expect(typeof service.getRawDatabase().close).toBe('function');
    service.close();
  });

  it('should initialize database and have export method', async () => {
    const service = new PersistenceService();
    await service.init();
    const exported = service.exportDatabase();
    expect(exported).toBeInstanceOf(Uint8Array);
    service.close();
  });

  it('should throw when accessing uninitialized database', async () => {
    const service = new PersistenceService();
    expect(() => service.getRawDatabase()).toThrow('Database not initialized');
    expect(() => service.exportDatabase()).toThrow('Database not initialized');
  });

  it('should not throw when closing uninitialized database', async () => {
    const service = new PersistenceService();
    service.close(); // Should not throw
    expect(service.isInitialized()).toBe(false);
  });

  it('should handle repeated close calls safely', async () => {
    const service = new PersistenceService();
    await service.init();
    service.close();
    service.close(); // Should not throw
    expect(service.isInitialized()).toBe(false);
  });

  it('should throw when operating on closed database', async () => {
    const service = new PersistenceService();
    await service.init();
    service.close();
    expect(() => service.getRawDatabase()).toThrow('Database has been closed');
    expect(() => service.exportDatabase()).toThrow('Database has been closed');
  });
});

describe('PersistenceService - Migration System', () => {
  let service: PersistenceService;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();
  });

  afterEach(async () => {
    service.close();
  });

  it('should create conversations table on first init', async () => {
    const db = service.getRawDatabase();
    const result = db.exec(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'
    `);
    expect(result.length).toBe(1);
    expect(result[0].values[0][0]).toBe('conversations');
  });

  it('should create messages table on first init', async () => {
    const db = service.getRawDatabase();
    const result = db.exec(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='messages'
    `);
    expect(result.length).toBe(1);
    expect(result[0].values[0][0]).toBe('messages');
  });

  it('should create migrations table on first init', async () => {
    const db = service.getRawDatabase();
    const result = db.exec(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'
    `);
    expect(result.length).toBe(1);
    expect(result[0].values[0][0]).toBe('migrations');
  });

  it('should track applied migrations', async () => {
    const db = service.getRawDatabase();
    const result = db.exec('SELECT version FROM migrations ORDER BY version');
    const versions = result[0].values.map(row => row[0]);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('should not re-apply migrations on reinit', async () => {
    service.close();
    const service2 = new PersistenceService();
    await service2.init();
    const db = service2.getRawDatabase();
    const result = db.exec('SELECT version FROM migrations ORDER BY version');
    const versions = result[0].values.map(row => row[0]);
    expect(versions).toEqual([1, 2, 3]);
    service2.close();
  });

  it('should enable foreign keys', async () => {
    const db = service.getRawDatabase();
    const result = db.exec('PRAGMA foreign_keys');
    expect(result[0].values[0][0]).toBe(1);
  });
});

describe('PersistenceService - Conversation Persistence', () => {
  let service: PersistenceService;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();
  });

  afterEach(async () => {
    service.close();
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
    db.exec(
      `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.workspace_id,
        conversation.title,
        conversation.created_at,
        conversation.updated_at,
        JSON.stringify(conversation.metadata),
      ]
    );

    const result = db.exec('SELECT count(*) as count FROM conversations');
    expect(getCountResult(result)).toBe(1);
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
      db.exec(
        `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          conversation.id,
          conversation.workspace_id,
          conversation.title,
          conversation.created_at,
          conversation.updated_at,
          JSON.stringify(conversation.metadata),
        ]
      );
    }

    const result = db.exec('SELECT count(*) as count FROM conversations');
    expect(getCountResult(result)).toBe(3);
  });

  it('should enforce foreign key constraint on messages', async () => {
    const db = service.getRawDatabase();

    // Try to insert message with non-existent conversation_id
    expect(() => {
      db.exec(
        `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['msg-001', 'non-existent-conv', 'user', 'Hello', 'completed', Date.now(), 0, '{}']
      );
    }).toThrow();
  });
});

describe('PersistenceService - Message Persistence', () => {
  let service: PersistenceService;

  beforeEach(async () => {
    service = new PersistenceService();
    await service.init();

    // Create a conversation for messages
    const db = service.getRawDatabase();
    db.exec(
      `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      ['conv-001', 'ws-001', 'Test', Date.now(), Date.now(), '{}']
    );
  });

  afterEach(async () => {
    service.close();
  });

  it('should save and retrieve messages', async () => {
    const db = service.getRawDatabase();

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

    db.exec(
      `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversation_id,
        message.role,
        message.content,
        message.status,
        message.timestamp,
        message.seq,
        JSON.stringify(message.metadata),
      ]
    );

    const result = db.exec('SELECT count(*) as count FROM messages');
    expect(getCountResult(result)).toBe(1);
  });

  it('should handle empty message content', async () => {
    const db = service.getRawDatabase();

    db.exec(
      `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['msg-empty', 'conv-001', 'user', '', 'completed', Date.now(), 0, '{}']
    );

    const result = db.exec("SELECT count(*) as count FROM messages WHERE id = 'msg-empty'");
    expect(getCountResult(result)).toBe(1);
  });

  it('should preserve message ordering by timestamp', async () => {
    const db = service.getRawDatabase();
    const baseTime = Date.now();

    for (let i = 0; i < 5; i++) {
      db.exec(
        `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`msg-${i}`, 'conv-001', 'user', `Message ${i}`, 'completed', baseTime + i * 1000, i, '{}']
      );
    }

    const result = db.exec('SELECT id FROM messages ORDER BY timestamp ASC');
    const ids = result[0].values.map(row => row[0]);
    expect(ids).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  it('should cascade delete messages when conversation is deleted', async () => {
    const db = service.getRawDatabase();

    db.exec(
      `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['msg-001', 'conv-001', 'user', 'Hello', 'completed', Date.now(), 0, '{}']
    );

    db.exec('DELETE FROM conversations WHERE id = ?', ['conv-001']);

    const result = db.exec('SELECT count(*) as count FROM messages WHERE conversation_id = ?', [
      'conv-001',
    ]);
    expect(getCountResult(result)).toBe(0);
  });
});

describe('PersistenceService - File Persistence (Close/Reopen)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should persist data across close and reopen', async () => {
    // Phase 1: Create database, insert data, save and close
    const service1 = new PersistenceService({ dbPath });
    await service1.init();

    const db1 = service1.getRawDatabase();
    db1.exec(
      `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      ['conv-001', 'ws-001', 'Persisted Conversation', 1000, 2000, '{"test": true}']
    );
    db1.exec(
      `INSERT INTO messages (id, conversation_id, role, content, status, timestamp, seq, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['msg-001', 'conv-001', 'user', 'Hello, persisted world!', 'completed', 3000, 0, '{}']
    );

    service1.save();
    service1.close();

    // Verify file exists
    expect(fs.existsSync(dbPath)).toBe(true);

    // Phase 2: Reopen database and verify data
    const service2 = new PersistenceService({ dbPath });
    await service2.init();

    const db2 = service2.getRawDatabase();

    // Verify conversation
    const convResult = db2.exec("SELECT * FROM conversations WHERE id = 'conv-001'");
    expect(convResult.length).toBe(1);
    expect(convResult[0].values[0][0]).toBe('conv-001');
    expect(convResult[0].values[0][1]).toBe('ws-001');
    expect(convResult[0].values[0][2]).toBe('Persisted Conversation');
    expect(convResult[0].values[0][3]).toBe(1000);
    expect(convResult[0].values[0][4]).toBe(2000);
    expect(JSON.parse(convResult[0].values[0][5] as string)).toEqual({ test: true });

    // Verify message
    const msgResult = db2.exec("SELECT * FROM messages WHERE id = 'msg-001'");
    expect(msgResult.length).toBe(1);
    expect(msgResult[0].values[0][0]).toBe('msg-001');
    expect(msgResult[0].values[0][1]).toBe('conv-001');
    expect(msgResult[0].values[0][2]).toBe('user');
    expect(msgResult[0].values[0][3]).toBe('Hello, persisted world!');
    expect(msgResult[0].values[0][4]).toBe('completed');
    expect(msgResult[0].values[0][5]).toBe(3000);
    expect(msgResult[0].values[0][6]).toBe(0);

    service2.close();
  });

  it('should handle multiple save/close/reopen cycles', async () => {
    // Cycle 1
    const service1 = new PersistenceService({ dbPath });
    await service1.init();
    const db1 = service1.getRawDatabase();
    db1.exec(
      `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      ['conv-1', 'ws-1', 'Conv 1', 1000, 1000, '{}']
    );
    service1.save();
    service1.close();

    // Cycle 2 - reopen, add more data
    const service2 = new PersistenceService({ dbPath });
    await service2.init();
    const db2 = service2.getRawDatabase();
    db2.exec(
      `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      ['conv-2', 'ws-1', 'Conv 2', 2000, 2000, '{}']
    );
    service2.save();
    service2.close();

    // Cycle 3 - reopen and verify both
    const service3 = new PersistenceService({ dbPath });
    await service3.init();
    const db3 = service3.getRawDatabase();
    const result = db3.exec('SELECT count(*) as count FROM conversations');
    expect(getCountResult(result)).toBe(2);
    service3.close();
  });

  it('should throw when saving without dbPath', async () => {
    const service = new PersistenceService({});
    await service.init();
    expect(() => service.save()).toThrow('No database path configured');
    service.close();
  });
});

describe('PersistenceService - Error Handling', () => {
  it('should throw on invalid database file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-test-'));
    const dbPath = path.join(tempDir, 'invalid.db');

    // Write invalid data
    fs.writeFileSync(dbPath, 'not a sqlite database');

    const service = new PersistenceService({ dbPath });
    await expect(service.init()).rejects.toThrow('file is not a database');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should throw on failed database write', async () => {
    // Create a file and try to use a path inside it as a directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-test-'));
    const blockingFile = path.join(tempDir, 'blocking');
    fs.writeFileSync(blockingFile, 'blocking');

    // Try to save to a path inside the blocking file (should fail on all platforms)
    const invalidPath = path.join(blockingFile, 'test.db');

    const service = new PersistenceService({ dbPath: invalidPath });
    await service.init();

    expect(() => service.save()).toThrow();

    service.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle missing database file gracefully', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-test-'));
    const dbPath = path.join(tempDir, 'nonexistent.db');

    const service = new PersistenceService({ dbPath });
    await service.init(); // Should create new database
    expect(service.isInitialized()).toBe(true);
    service.close();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle invalid SQL operations', async () => {
    const service = new PersistenceService({});
    await service.init();
    const db = service.getRawDatabase();

    expect(() => {
      db.exec('INVALID SQL STATEMENT');
    }).toThrow();

    service.close();
  });
});

describe('PersistenceService - WASM Loading', () => {
  it('should locate and load WASM asset correctly', async () => {
    const service = new PersistenceService();
    await service.init();
    expect(service.isInitialized()).toBe(true);
    service.close();
  });

  it('should handle multiple simultaneous initializations', async () => {
    const services = await Promise.all([
      (async () => {
        const s = new PersistenceService();
        await s.init();
        return s;
      })(),
      (async () => {
        const s = new PersistenceService();
        await s.init();
        return s;
      })(),
      (async () => {
        const s = new PersistenceService();
        await s.init();
        return s;
      })(),
    ]);

    for (const service of services) {
      expect(service.isInitialized()).toBe(true);
      service.close();
    }
  });
});
