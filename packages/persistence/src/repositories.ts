import type { SQLDatabase } from './PersistenceService.js';
import { PersistenceError, validateConversation, validateMessage } from './PersistenceService.js';

type SqlValue = string | number | Uint8Array | null;

export interface CreateConversationInput {
  id: string;
  workspace_id: string;
  title: string;
  created_at?: number;
  updated_at?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateConversationInput {
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationRepository {
  create(input: CreateConversationInput): Promise<ConversationResult>;
  getById(id: string): Promise<ConversationResult>;
  list(workspaceId?: string): Promise<ConversationListResult>;
  update(id: string, input: UpdateConversationInput): Promise<ConversationResult>;
  delete(id: string): Promise<DeleteResult>;
}

export interface ConversationResult {
  conversation: ConversationRecord | null;
  error: PersistenceError | null;
}

export interface ConversationListResult {
  conversations: ConversationRecord[];
  error: PersistenceError | null;
}

export interface DeleteResult {
  deleted: boolean;
  error: PersistenceError | null;
}

export interface ConversationRecord {
  id: string;
  workspace_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
}

export interface CreateMessageInput {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  timestamp?: number;
  seq?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateMessageInput {
  content?: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  metadata?: Record<string, unknown>;
}

export interface MessageRepository {
  create(input: CreateMessageInput): Promise<MessageResult>;
  getById(id: string): Promise<MessageResult>;
  getByConversationId(conversationId: string): Promise<MessageListResult>;
  update(id: string, input: UpdateMessageInput): Promise<MessageResult>;
  delete(id: string): Promise<DeleteResult>;
  deleteByConversationId(conversationId: string): Promise<DeleteResult>;
}

export interface MessageResult {
  message: MessageRecord | null;
  error: PersistenceError | null;
}

export interface MessageListResult {
  messages: MessageRecord[];
  error: PersistenceError | null;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  timestamp: number;
  seq: number;
  metadata: Record<string, unknown>;
}

function mapConversationRow(row: unknown[]): ConversationRecord {
  return {
    id: row[0] as string,
    workspace_id: row[1] as string,
    title: row[2] as string,
    created_at: row[3] as number,
    updated_at: row[4] as number,
    metadata: JSON.parse(row[5] as string) as Record<string, unknown>,
  };
}

function mapMessageRow(row: unknown[]): MessageRecord {
  return {
    id: row[0] as string,
    conversation_id: row[1] as string,
    role: row[2] as 'user' | 'assistant' | 'system',
    content: row[3] as string,
    status: row[4] as 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled',
    timestamp: row[5] as number,
    seq: row[6] as number,
    metadata: JSON.parse(row[7] as string) as Record<string, unknown>,
  };
}

export class SqlJsConversationRepository implements ConversationRepository {
  constructor(private readonly db: SQLDatabase) {}

  async create(input: CreateConversationInput): Promise<ConversationResult> {
    await Promise.resolve();
    try {
      const now = Date.now();
      const conversation = {
        ...input,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now,
        metadata: input.metadata ?? {},
      };

      validateConversation(conversation);

      this.db.exec(
        `INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          conversation.id,
          conversation.workspace_id,
          conversation.title,
          conversation.created_at,
          conversation.updated_at,
          JSON.stringify(conversation.metadata),
        ] as SqlValue[]
      );

      return { conversation: mapConversationRow([
        conversation.id,
        conversation.workspace_id,
        conversation.title,
        conversation.created_at,
        conversation.updated_at,
        JSON.stringify(conversation.metadata),
      ]), error: null };
    } catch (error) {
      return { conversation: null, error: new PersistenceError('Failed to create conversation', error instanceof Error ? error : undefined) };
    }
  }

  async getById(id: string): Promise<ConversationResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec('SELECT id, workspace_id, title, created_at, updated_at, metadata FROM conversations WHERE id = ?', [id]);
      if (result.length === 0 || result[0].values.length === 0) {
        return { conversation: null, error: null };
      }
      return { conversation: mapConversationRow(result[0].values[0]), error: null };
    } catch (error) {
      return { conversation: null, error: new PersistenceError('Failed to get conversation', error instanceof Error ? error : undefined) };
    }
  }

  async list(workspaceId?: string): Promise<ConversationListResult> {
    await Promise.resolve();
    try {
      let sql = 'SELECT id, workspace_id, title, created_at, updated_at, metadata FROM conversations';
      const params: unknown[] = [];

      if (workspaceId) {
        sql += ' WHERE workspace_id = ?';
        params.push(workspaceId);
      }

      sql += ' ORDER BY updated_at DESC';

      const result = this.db.exec(sql, params as SqlValue[]);
      const conversations = result.length > 0 ? result[0].values.map(mapConversationRow) : [];
      return { conversations, error: null };
    } catch (error) {
      return { conversations: [], error: new PersistenceError('Failed to list conversations', error instanceof Error ? error : undefined) };
    }
  }

  async update(id: string, input: UpdateConversationInput): Promise<ConversationResult> {
    await Promise.resolve();
    try {
      const existingResult = this.db.exec('SELECT id, workspace_id, title, created_at, updated_at, metadata FROM conversations WHERE id = ?', [id] as SqlValue[]);
      if (existingResult.length === 0 || existingResult[0].values.length === 0) {
        return { conversation: null, error: new PersistenceError('Conversation not found') };
      }

      const existing = mapConversationRow(existingResult[0].values[0]);
      const now = Date.now();

      const updated = {
        ...existing,
        title: input.title ?? existing.title,
        metadata: input.metadata ?? existing.metadata,
        updated_at: now,
      };

      validateConversation(updated);

      this.db.exec(
        `UPDATE conversations SET title = ?, updated_at = ?, metadata = ? WHERE id = ?`,
        [updated.title, updated.updated_at, JSON.stringify(updated.metadata), id] as SqlValue[]
      );

      return { conversation: updated, error: null };
    } catch (error) {
      return { conversation: null, error: new PersistenceError('Failed to update conversation', error instanceof Error ? error : undefined) };
    }
  }

  async delete(id: string): Promise<DeleteResult> {
    await Promise.resolve();
    try {
      this.db.exec('DELETE FROM conversations WHERE id = ?', [id] as SqlValue[]);
      const deleted = this.db.getRowsModified() > 0;
      return { deleted, error: null };
    } catch (error) {
      return { deleted: false, error: new PersistenceError('Failed to delete conversation', error instanceof Error ? error : undefined) };
    }
  }
}

export class SqlJsMessageRepository implements MessageRepository {
  constructor(private readonly db: SQLDatabase) {}

  async create(input: CreateMessageInput): Promise<MessageResult> {
    await Promise.resolve();
    try {
      const now = Date.now();
      const message = {
        ...input,
        timestamp: input.timestamp ?? now,
        seq: input.seq ?? 0,
        metadata: input.metadata ?? {},
      };

      validateMessage(message);

      this.db.exec(
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
        ] as SqlValue[]
      );

      return { message: mapMessageRow([
        message.id,
        message.conversation_id,
        message.role,
        message.content,
        message.status,
        message.timestamp,
        message.seq,
        JSON.stringify(message.metadata),
      ]), error: null };
    } catch (error) {
      return { message: null, error: new PersistenceError('Failed to create message', error instanceof Error ? error : undefined) };
    }
  }

  async getById(id: string): Promise<MessageResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        'SELECT id, conversation_id, role, content, status, timestamp, seq, metadata FROM messages WHERE id = ?',
        [id] as SqlValue[]
      );
      if (result.length === 0 || result[0].values.length === 0) {
        return { message: null, error: null };
      }
      return { message: mapMessageRow(result[0].values[0]), error: null };
    } catch (error) {
      return { message: null, error: new PersistenceError('Failed to get message', error instanceof Error ? error : undefined) };
    }
  }

  async getByConversationId(conversationId: string): Promise<MessageListResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        'SELECT id, conversation_id, role, content, status, timestamp, seq, metadata FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC, seq ASC',
        [conversationId] as SqlValue[]
      );
      const messages = result.length > 0 ? result[0].values.map(mapMessageRow) : [];
      return { messages, error: null };
    } catch (error) {
      return { messages: [], error: new PersistenceError('Failed to get messages', error instanceof Error ? error : undefined) };
    }
  }

  async update(id: string, input: UpdateMessageInput): Promise<MessageResult> {
    await Promise.resolve();
    try {
      const existingResult = this.db.exec(
        'SELECT id, conversation_id, role, content, status, timestamp, seq, metadata FROM messages WHERE id = ?',
        [id] as SqlValue[]
      );
      if (existingResult.length === 0 || existingResult[0].values.length === 0) {
        return { message: null, error: new PersistenceError('Message not found') };
      }

      const existing = mapMessageRow(existingResult[0].values[0]);

      const updated = {
        ...existing,
        content: input.content ?? existing.content,
        status: input.status ?? existing.status,
        metadata: input.metadata ?? existing.metadata,
      };

      validateMessage(updated);

      this.db.exec(
        `UPDATE messages SET content = ?, status = ?, metadata = ? WHERE id = ?`,
        [updated.content, updated.status, JSON.stringify(updated.metadata), id] as SqlValue[]
      );

      return { message: updated, error: null };
    } catch (error) {
      return { message: null, error: new PersistenceError('Failed to update message', error instanceof Error ? error : undefined) };
    }
  }

  async delete(id: string): Promise<DeleteResult> {
    await Promise.resolve();
    try {
      this.db.exec('DELETE FROM messages WHERE id = ?', [id] as SqlValue[]);
      const deleted = this.db.getRowsModified() > 0;
      return { deleted, error: null };
    } catch (error) {
      return { deleted: false, error: new PersistenceError('Failed to delete message', error instanceof Error ? error : undefined) };
    }
  }

  async deleteByConversationId(conversationId: string): Promise<DeleteResult> {
    await Promise.resolve();
    try {
      this.db.exec('DELETE FROM messages WHERE conversation_id = ?', [conversationId] as SqlValue[]);
      const deleted = this.db.getRowsModified() > 0;
      return { deleted, error: null };
    } catch (error) {
      return { deleted: false, error: new PersistenceError('Failed to delete messages by conversation', error instanceof Error ? error : undefined) };
    }
  }
}