import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabaseType } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import z from 'zod';

export type SQLDatabase = SqlJsDatabaseType;

export const ConversationValidationSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).default({}),
});

export function validateConversation(data: unknown): z.infer<typeof ConversationValidationSchema> {
  return ConversationValidationSchema.parse(data);
}

export const MessageValidationSchema = z.object({
  id: z.string().min(1),
  conversation_id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
  timestamp: z.number().int().nonnegative(),
  seq: z.number().int().default(0),
  metadata: z.record(z.unknown()).default({}),
});

export function validateMessage(data: unknown): z.infer<typeof MessageValidationSchema> {
  return MessageValidationSchema.parse(data);
}

export interface Conversation {
  id: string;
  workspace_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  timestamp: number;
  seq: number;
  metadata: Record<string, unknown>;
}

export function createConversationId(id: string): string {
  return id;
}

export function createMessageId(id: string): string {
  return id;
}

interface Migration {
  version: number;
  name: string;
  up: (db: SQLDatabase) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_conversations_table',
    up: (db: SQLDatabase) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`
      );
    },
  },
  {
    version: 2,
    name: 'create_messages_table',
    up: (db: SQLDatabase) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp ASC)`
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(conversation_id, seq ASC)`);
    },
  },
  {
    version: 3,
    name: 'create_migrations_table',
    up: (db: SQLDatabase) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);
    },
  },
];

export class PersistenceError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

interface SqlJsModule {
  Database: new (data?: Uint8Array) => SQLDatabase;
}

export interface PersistenceServiceOptions {
  dbPath?: string;
  locateFile?: (file: string) => string;
}

export class PersistenceService {
  private readonly dbPath: string | undefined;
  private readonly locateFile: ((file: string) => string) | undefined;
  private db: SQLDatabase | null = null;
  private sqlModule: SqlJsModule | null = null;
  private isClosed = false;
  private wasInitialized = false;

  constructor(options: PersistenceServiceOptions = {}) {
    this.dbPath = options.dbPath;
    this.locateFile = options.locateFile;
  }

  async init(): Promise<void> {
    if (this.sqlModule && this.wasInitialized && !this.isClosed) {
      return;
    }

    // If we were closed, reset state for re-initialization
    if (this.isClosed) {
      this.isClosed = false;
      this.db = null;
    }

    try {
      this.sqlModule = await initSqlJs({
        locateFile: this.locateFile,
        useOldExtensionFunctions: true,
      });
    } catch (error) {
      throw new PersistenceError(
        'Failed to initialize sql.js',
        error instanceof Error ? error : undefined
      );
    }

    const DatabaseClass = this.sqlModule.Database;

    if (this.dbPath && fs.existsSync(this.dbPath)) {
      try {
        const fileData = fs.readFileSync(this.dbPath);
        this.db = new DatabaseClass(new Uint8Array(fileData));
      } catch (error) {
        throw new PersistenceError(
          `Failed to load database from ${this.dbPath}`,
          error instanceof Error ? error : undefined
        );
      }
    } else {
      this.db = new DatabaseClass();
    }

    this.enableForeignKeys();
    this.runMigrations();
    this.wasInitialized = true;
  }

  private enableForeignKeys(): void {
    if (!this.db) return;
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private runMigrations(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const appliedResult = this.db.exec('SELECT version FROM migrations ORDER BY version');
    const appliedVersions = new Set<number>();
    if (appliedResult.length > 0 && appliedResult[0].values.length > 0) {
      for (const row of appliedResult[0].values) {
        appliedVersions.add(row[0] as number);
      }
    }

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      try {
        migration.up(this.db);
        this.db.exec('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          Date.now(),
        ]);
      } catch (error) {
        throw new PersistenceError(
          `Migration ${migration.version} (${migration.name}) failed`,
          error instanceof Error ? error : undefined
        );
      }
    }
  }

  close(): void {
    if (this.db && !this.isClosed) {
      this.db.close();
      this.db = null;
      this.isClosed = true;
    }
  }

  exportDatabase(): Uint8Array {
    if (!this.db) {
      if (this.isClosed) {
        throw new PersistenceError('Database has been closed.');
      }
      throw new PersistenceError('Database not initialized. Call init() first.');
    }
    return this.db.export();
  }

  save(): void {
    if (!this.dbPath) {
      throw new PersistenceError('No database path configured. Cannot save.');
    }
    if (!this.db) {
      if (this.isClosed) {
        throw new PersistenceError('Database has been closed.');
      }
      throw new PersistenceError('Database not initialized. Call init() first.');
    }

    try {
      const data = this.exportDatabase();
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dbPath, data);
    } catch (error) {
      throw new PersistenceError(
        `Failed to save database to ${this.dbPath}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  getRawDatabase(): SQLDatabase {
    if (!this.db) {
      if (this.isClosed) {
        throw new PersistenceError('Database has been closed.');
      }
      throw new PersistenceError('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  getDbPath(): string | undefined {
    return this.dbPath;
  }

  isInitialized(): boolean {
    return this.db !== null && !this.isClosed;
  }
}
