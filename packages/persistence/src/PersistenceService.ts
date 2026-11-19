import Database from 'sql.js';
import z from 'zod';

// Use any for Database type - skipLibCheck is enabled in tsconfig
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SQLDatabase = any;

export const ConversationValidationSchema = z.object({
  id: z.number().int().positive(),
  workspace_id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).default({}),
});

export const MessageValidationSchema = z.object({
  id: z.number().int().positive(),
  conversation_id: z.number().int().positive(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
  status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
  timestamp: z.number().int().nonnegative(),
  seq: z.number().int().default(0),
  metadata: z.record(z.unknown()).default({}),
});

export function validateConversation(data: unknown): z.infer<typeof ConversationValidationSchema> {
  return ConversationValidationSchema.parse(data);
}

export function validateMessage(data: unknown): z.infer<typeof MessageValidationSchema> {
  return MessageValidationSchema.parse(data);
}

export interface Conversation {
  id: number;
  workspace_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  timestamp: number;
  seq: number;
  metadata: Record<string, unknown>;
}

export class PersistenceService {
  private readonly dbPath: string | undefined;
  private db: any = null;
  private readonly busyTimeout: number;
  private initialized = false;

  constructor(options: { filepath?: string; busyTimeout?: number } = {}) {
    this.dbPath = options.filepath;
    this.busyTimeout = options.busyTimeout ?? 5000;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Use any type assertion to bypass sql.js type definitions
    // which don't include the 'force' option in their config type
    // @ts-ignore - sql.js types don't match our usage pattern
    let db: any = new Database(this.dbPath && this.dbPath !== ':memory:' ? this.dbPath : ':memory:', this.dbPath && this.dbPath !== ':memory:' ? { force: true } : undefined);
    this.db = db;

    this.db!.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=${this.busyTimeout};
    `);

    await this.runMigrations();

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  getRawDatabase(): any {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  getDrizzleDatabase() {
    throw new Error('Drizzle ORM not available - use raw database operations');
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS _nexipi_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      )
    `);

    const result = this.db!.exec('SELECT version FROM _nexipi_migrations');
    const appliedStr = result[0] || '';
    const appliedVersions = appliedStr
      .trim()
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => parseInt(line.split('|')[0].trim(), 10));

    const migrations: Array<{ version: number; up: (db: SQLDatabase) => void }> = [
      {
        version: 1,
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              workspace_id TEXT NOT NULL,
              title TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              metadata TEXT NOT NULL DEFAULT '{}'
            )
          `);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations(workspace_id)`);
          db.exec(`INSERT INTO _nexipi_migrations (version) VALUES (1)`);
        },
      },
      {
        version: 2,
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation_id INTEGER NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              status TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              seq INTEGER NOT NULL DEFAULT 0,
              metadata TEXT NOT NULL DEFAULT '{}',
              FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )
          `);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)`);
          db.exec(`INSERT INTO _nexipi_migrations (version) VALUES (2)`);
        },
      },
    ];

    for (const migration of migrations) {
      if (!appliedVersions.includes(migration.version)) {
        migration.up(this.db!);
      }
    }
  }
}