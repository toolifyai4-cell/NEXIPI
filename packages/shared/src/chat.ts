import { z } from 'zod';

export type ConversationId = string & { readonly __brand: unique symbol };
export type MessageId = string & { readonly __brand: unique symbol };

export function createConversationId(id: string): ConversationId {
  return id as ConversationId;
}

export function createMessageId(id: string): MessageId {
  return id as MessageId;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'failed',
  'cancelled',
]);

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string;
  readonly status: MessageStatus;
  readonly timestamp: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  status: MessageStatusSchema,
  timestamp: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
});

export type MessageInput = z.input<typeof MessageSchema>;
export type MessageOutput = z.output<typeof MessageSchema>;

export interface Conversation {
  readonly id: ConversationId;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string().default('New Conversation'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
});

export type ConversationInput = z.input<typeof ConversationSchema>;
export type ConversationOutput = z.output<typeof ConversationSchema>;

export interface ConversationState {
  readonly conversation: Conversation;
  readonly messages: readonly Message[];
  readonly activeMessageId: MessageId | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

export function createConversation(
  id: ConversationId,
  title: string = 'New Conversation'
): Conversation {
  const now = Date.now();
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
  };
}

export function createMessage(
  conversationId: ConversationId,
  role: MessageRole,
  content: string,
  status: MessageStatus = 'pending',
  metadata?: Record<string, unknown>
): Message {
  return {
    id: createMessageId(`${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
    conversationId,
    role,
    content,
    status,
    timestamp: Date.now(),
    metadata,
  };
}

export function updateMessageStatus(
  message: Message,
  status: MessageStatus,
  content?: string
): Message {
  return {
    ...message,
    status,
    content: content ?? message.content,
    metadata: {
      ...message.metadata,
      statusUpdatedAt: Date.now(),
    },
  };
}

export function appendMessageContent(message: Message, delta: string): Message {
  return {
    ...message,
    content: message.content + delta,
    metadata: {
      ...message.metadata,
      lastDeltaAt: Date.now(),
    },
  };
}

export function isMessageTerminal(message: Message): boolean {
  return message.status === 'completed' || message.status === 'failed' || message.status === 'cancelled';
}

export function isMessageActive(message: Message): boolean {
  return message.status === 'pending' || message.status === 'streaming';
}

export function validateMessage(message: unknown): MessageOutput {
  return MessageSchema.parse(message);
}

export function validateConversation(conversation: unknown): ConversationOutput {
  return ConversationSchema.parse(conversation);
}

export function safeValidateMessage(
  message: unknown
): { success: true; data: MessageOutput } | { success: false; error: z.ZodError } {
  const result = MessageSchema.safeParse(message);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function safeValidateConversation(
  conversation: unknown
): { success: true; data: ConversationOutput } | { success: false; error: z.ZodError } {
  const result = ConversationSchema.safeParse(conversation);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}