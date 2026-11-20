import Database from 'sql.js';
import z from 'zod';

export type SQLDatabase = {
  exec: (sql: string, params?: unknown[]) => SQLStatement | SQLStatement[] | void;
  close: () => Promise<void> | void;
  export: () => Uint8Array;
  loadExtension: (name: string, data?: Uint8Array) => void;
};

export type SQLStatement = {
  readonly: boolean;
};

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

export const MessageValidationSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
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

export class PersistenceService {
  private readonly dbPath: string | undefined;
  private db: SQLDatabase | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath;
  }

  init(): void {
    // @ts-expect-error sql.js Database constructor accepts string paths at runtime despite type definitions
    this.db = new Database(undefined) as SQLDatabase;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  exportDatabase(): Uint8Array {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db.export();
  }

  getRawDatabase(): SQLDatabase {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }
}