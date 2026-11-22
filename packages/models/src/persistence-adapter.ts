import type { IPersistencePort, Conversation as PersistenceConversation, CreateConversationInput, UpdateConversationInput, Message as PersistenceMessage, CreateMessageInput, UpdateMessageInput, ConversationResult, MessageResult } from '@nexipi/persistence';
import type { ConversationId, MessageId, Conversation, Message, MessageStatus } from '@nexipi/shared';
import { PersistenceError } from '@nexipi/persistence';

export interface PersistenceAdapterOptions {
  persistencePort: IPersistencePort;
  workspaceId: string;
}

export class PersistenceAdapter {
  private readonly port: IPersistencePort;
  private readonly workspaceId: string;

  constructor(options: PersistenceAdapterOptions) {
    this.port = options.persistencePort;
    this.workspaceId = options.workspaceId;
  }

  async initialize(): Promise<void> {
    await this.port.initialize();
  }

  isAvailable(): boolean {
    return this.port.isAvailable();
  }

  dispose(): void {
    this.port.dispose();
  }

  private toPersistenceConversation(input: Conversation, createdAt?: number, updatedAt?: number): CreateConversationInput {
    return {
      id: input.id,
      workspaceId: this.workspaceId,
      title: input.title,
      createdAt: createdAt ?? input.createdAt,
      updatedAt: updatedAt ?? input.updatedAt,
      metadata: input.metadata ?? {},
    };
  }

  private fromPersistenceConversation(p: PersistenceConversation): Conversation {
    return {
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      metadata: p.metadata,
    };
  }

  private toPersistenceMessage(input: Message, seq?: number): CreateMessageInput {
    return {
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      status: input.status,
      timestamp: input.timestamp,
      seq: seq ?? 0,
      metadata: input.metadata ?? {},
    };
  }

  private fromPersistenceMessage(p: PersistenceMessage): Message {
    return {
      id: p.id,
      conversationId: p.conversationId,
      role: p.role,
      content: p.content,
      status: p.status,
      timestamp: p.timestamp,
      metadata: p.metadata,
    };
  }

  private handleConversationResult(result: ConversationResult): PersistenceConversation {
    if (result.error) {
      throw result.error;
    }
    if (result.conversation === null) {
      throw new PersistenceError('Unexpected null conversation result');
    }
    return result.conversation;
  }

  private handleMessageResult(result: MessageResult): PersistenceMessage {
    if (result.error) {
      throw result.error;
    }
    if (result.message === null) {
      throw new PersistenceError('Unexpected null message result');
    }
    return result.message;
  }

  async createConversation(conversation: Conversation, createdAt?: number, updatedAt?: number): Promise<Conversation> {
    const input = this.toPersistenceConversation(conversation, createdAt, updatedAt);
    const result = await this.port.createConversation(input);
    return this.fromPersistenceConversation(this.handleConversationResult(result));
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    const result = await this.port.getConversation(id);
    if (result.error) {
      throw result.error;
    }
    return result.conversation ? this.fromPersistenceConversation(result.conversation) : null;
  }

  async listConversations(): Promise<Conversation[]> {
    const result = await this.port.listConversations(this.workspaceId);
    if (result.error) {
      throw result.error;
    }
    return result.conversations.map((c) => this.fromPersistenceConversation(c));
  }

  async updateConversation(id: ConversationId, title?: string, metadata?: Record<string, unknown>): Promise<Conversation> {
    const input: UpdateConversationInput = {};
    if (title !== undefined) input.title = title;
    if (metadata !== undefined) input.metadata = metadata;
    const result = await this.port.updateConversation(id, input);
    return this.fromPersistenceConversation(this.handleConversationResult(result));
  }

  async deleteConversation(id: ConversationId): Promise<boolean> {
    const result = await this.port.deleteConversation(id);
    if (result.error) {
      throw result.error;
    }
    return result.deleted;
  }

  async createMessage(message: Message, seq?: number): Promise<Message> {
    const input = this.toPersistenceMessage(message, seq);
    const result = await this.port.createMessage(input);
    return this.fromPersistenceMessage(this.handleMessageResult(result));
  }

  async getMessage(id: MessageId): Promise<Message | null> {
    const result = await this.port.getMessage(id);
    if (result.error) {
      throw result.error;
    }
    return result.message ? this.fromPersistenceMessage(result.message) : null;
  }

  async getMessagesByConversationId(conversationId: ConversationId): Promise<Message[]> {
    const result = await this.port.getMessagesByConversationId(conversationId);
    if (result.error) {
      throw result.error;
    }
    return result.messages.map((m) => this.fromPersistenceMessage(m));
  }

  async updateMessage(id: MessageId, content?: string, status?: MessageStatus, metadata?: Record<string, unknown>): Promise<Message> {
    const input: UpdateMessageInput = {};
    if (content !== undefined) input.content = content;
    if (status !== undefined) input.status = status;
    if (metadata !== undefined) input.metadata = metadata;
    const result = await this.port.updateMessage(id, input);
    return this.fromPersistenceMessage(this.handleMessageResult(result));
  }

  async deleteMessage(id: MessageId): Promise<boolean> {
    const result = await this.port.deleteMessage(id);
    if (result.error) {
      throw result.error;
    }
    return result.deleted;
  }

  async deleteMessagesByConversationId(conversationId: ConversationId): Promise<boolean> {
    const result = await this.port.deleteMessagesByConversationId(conversationId);
    if (result.error) {
      throw result.error;
    }
    return result.deleted;
  }
}

export function createPersistenceAdapter(options: PersistenceAdapterOptions): PersistenceAdapter {
  return new PersistenceAdapter(options);
}