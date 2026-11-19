import Database from 'sql.js';
import z from 'zod';

// Use any for Database type - skipLibCheck is enabled in tsconfig
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SQLDatabase = any;

/**
 * Validation schema for conversation records stored in the persistence layer.
 * IDs are stored as strings to match the Phase 06 ConversationId contract
 * (string & { readonly __brand: unique symbol }).
 */
export const ConversationValidationSchema = z.object({
  id: z.string(),
  workspace_id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).default({}),
});

export function validateConversation(data: unknown): z.infer<typeof ConversationValidationSchema> {
  return ConversationValidationSchema.parse(data);
}

/**
 * Validation schema for message records stored in the persistence layer.
 * IDs are stored as strings to match the Phase 06 MessageId contract
 * (string & { readonly __brand: unique symbol }).
 * Content allows empty strings to support the streaming lifecycle.
 */
export const MessageValidationSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(), // Allow empty string for streaming lifecycle
  status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
  timestamp: z.number().int().nonnegative(),
  seq: z.number().int().default(0),
  metadata: z.record(z.unknown()).default({}),
});

export function validateMessage(data: unknown): z.infer<typeof MessageValidationSchema> {
  return MessageValidationSchema.parse(data);
}

/**
 * Interface for a conversation record in the persistence store.
 * IDs are strings matching the Phase 06 ConversationId contract.
 */
export interface Conversation {
  id: string;
  workspace_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
}

/**
 * Interface for a message record in the persistence store.
 * IDs are strings matching the Phase 06 MessageId contract.
 * Content can be empty to support streaming.
 */
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

/**
 * Generates a string ID matching the Phase 06 format:
 * `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
 */
export function createConversationId(id: string): string {
  return id;
}

/**
 * Generates a string ID matching the Phase 06 format:
 * `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
 */
export function createMessageId(id: string): string {
  return id;
}

/**
 * PersistenceService uses sql.js (pure JavaScript SQLite) for database operations.
 * Supports file-based persistence with automatic WAL mode and foreign key enforcement.
 *
 * Design decisions:
 * - Uses string IDs (not numeric) to match Phase 06 ConversationId/MessageId contract
 * - Content allows empty strings for streaming lifecycle support
 * - Versioned migrations with tracking table
 * - WAL mode for better concurrency
 * - Busy timeout for lock handling
 */
export class PersistenceService {
  private readonly dbPath: string | undefined;
  private db: any = null;
  private readonly busyTimeout: number;
  private initialized = false;

  constructor(options: { filepath?: string; busyTimeout?: number } = {}) {
    this.dbPath = options.filepath;
    this.busyTimeout = options.busyTimeout ?? 5000;
  }

  /**
   * Initializes the database: opens existing file or creates new one,
   * enables WAL and foreign keys, and runs migrations.
   * If a database file exists at the configured filepath, it is opened
   * and existing data is retained. If no filepath is provided, an in-memory
   * database is used (data will not survive process exit).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Determine the database path: use file if provided, otherwise :memory:
    const dbPath = this.dbPath && this.dbPath !== ':memory:' ? this.dbPath : undefined;

    // Create the sql.js database instance
    // @ts-expect-error - sql.js Database constructor types not fully available with skipLibCheck
  this.db = new Database(dbPath ?? ':memory:');

    // Enable WAL mode for better concurrent read performance
    this.db!.exec(`PRAGMA journal_mode=WAL;`);

    // Enable foreign key enforcement
    this.db!.exec(`PRAGMA foreign_keys=ON;`);

    // Set busy timeout for lock handling
    this.db!.exec(`PRAGMA busy_timeout=${this.busyTimeout};`);

    // @ts-ignore - sql.js Database constructor type not fully available with skipLibCheck
  await this.runMigrations();

    this.initialized = true;
  }
/**
   * Closes the database connection and persists data to the configured filepath.
   * If a filepath was provided when constructing the service, the current
   * database state is exported as bytes and written to that file before closing.
   * If no filepath was provided, the in-memory database is simply closed
   * and data is lost (expected behavior).
   *
   * Important: Always call init() before close(). Calling close() without
   * init() is a no-op.
   */
  async close(): Promise<void> {
    if (this.db) {
      // Persist to file if a filepath was configured
      if (this.dbPath && this.dbPath !== ':memory:') {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');
          const dir = path.dirname(this.dbPath);
          try {
            await fs.mkdir(dir, { recursive: true });
          } catch {
            // Directory creation may fail if path is invalid; continue with file write attempt
          }
          const bytes = this.db!.export();
          await fs.writeFile(this.dbPath, bytes);
        } catch (error) {
          // Log the error but still close the database connection
          console.error(`Failed to persist database to ${this.dbPath}:`, error);
        }
      }
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  /**
   * Exports the current database as a Uint8Array of bytes.
   * This can be used to save the database state externally or reopen it later.
   * @returns Uint8Array containing the serialized SQLite database
   */
  exportDatabase(): Uint8Array {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db!.export();
  }

  /** @deprecated - Drizzle ORM is not available in this setup; use getRawDatabase() instead */
  getDrizzleDatabase(): never {
    throw new Error('Drizzle ORM not available - use raw database operations');
  }

  /**
   * Returns the raw sql.js database instance for direct SQL operations.
   * Use this for custom queries, migrations, or operations not covered by the
   * service's higher-level API.
   */
  getRawDatabase(): any {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Runs pending migrations to ensure the database schema is up to date.
   * Migrations are idempotent - already-applied migrations are skipped.
   * The migration tracking table `_nexipi_migrations` tracks which versions
   * have been applied.
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    // Create the migration tracking table
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS _nexipi_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      )
    `);

    // Get already-applied migration versions
    const result = this.db!.exec('SELECT version FROM _nexipi_migrations');
    const appliedStr = result[0] || '';
    const appliedVersions = appliedStr
      .trim()
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => parseInt(line.split('|')[0].trim(), 10));

    // Define migrations - using TEXT PRIMARY KEY for IDs to match Phase 06 contract
    const migrations: Array<{ version: number; up: (db: SQLDatabase) => void }> = [
      {
        version: 1,
        up: (db) => {
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
          db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations(workspace_id)`);
          db.exec(`INSERT INTO _nexipi_migrations (version) VALUES (1)`);
        },
      },
      {
        version: 2,
        up: (db) => {
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
          db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
          db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)`);
          db.exec(`INSERT INTO _nexipi_migrations (version) VALUES (2)`);
        },
      },
    ];

    // Apply pending migrations
    for (const migration of migrations) {
      if (!appliedVersions.includes(migration.version)) {
        migration.up(this.db);
      }
    }
  }
}