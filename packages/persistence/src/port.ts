import type { ConversationId, MessageId, MessageRole, MessageStatus } from '@nexipi/shared';
import type { PersistenceError } from './PersistenceService.js';

export interface CreateConversationInput {
  id: ConversationId;
  workspaceId: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateConversationInput {
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: ConversationId;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface ConversationListResult {
  conversations: Conversation[];
  error: PersistenceError | null;
}

export interface ConversationResult {
  conversation: Conversation | null;
  error: PersistenceError | null;
}

export interface CreateMessageInput {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp?: number;
  seq?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateMessageInput {
  content?: string;
  status?: MessageStatus;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: number;
  seq: number;
  metadata: Record<string, unknown>;
}

export interface MessageResult {
  message: Message | null;
  error: PersistenceError | null;
}

export interface MessageListResult {
  messages: Message[];
  error: PersistenceError | null;
}

export interface DeleteResult {
  deleted: boolean;
  error: PersistenceError | null;
}

export interface IPersistencePort {
  initialize(): Promise<void>;
  isAvailable(): boolean;
  dispose(): void;
  save(): void;

  createConversation(input: CreateConversationInput): Promise<ConversationResult>;
  getConversation(id: ConversationId): Promise<ConversationResult>;
  listConversations(workspaceId?: string): Promise<ConversationListResult>;
  updateConversation(id: ConversationId, input: UpdateConversationInput): Promise<ConversationResult>;
  deleteConversation(id: ConversationId): Promise<DeleteResult>;

  createMessage(input: CreateMessageInput): Promise<MessageResult>;
  getMessage(id: MessageId): Promise<MessageResult>;
  getMessagesByConversationId(conversationId: ConversationId): Promise<MessageListResult>;
  updateMessage(id: MessageId, input: UpdateMessageInput): Promise<MessageResult>;
  deleteMessage(id: MessageId): Promise<DeleteResult>;
  deleteMessagesByConversationId(conversationId: ConversationId): Promise<DeleteResult>;
}

export type PersistencePort = IPersistencePort;