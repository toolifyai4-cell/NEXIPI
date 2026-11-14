import type {
  Message as SharedMessage,
  Conversation as SharedConversation,
  MessageStatus as SharedMessageStatus,
  MessageRole as SharedMessageRole,
  MessageId as SharedMessageId,
  ConversationId as SharedConversationId,
} from '@nexipi/shared';

export type Message = SharedMessage;
export type Conversation = SharedConversation;
export type MessageStatus = SharedMessageStatus;
export type MessageRole = SharedMessageRole;
export type MessageId = SharedMessageId;
export type ConversationId = SharedConversationId;

export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  currentInput: string;
}

export type ViewMode = 'welcome' | 'chat';

export interface WelcomePrompt {
  label: string;
  prompt: string;
}

export interface WebviewMessage {
  type:
    | 'sendMessage'
    | 'newChat'
    | 'promptSelected'
    | 'ready'
    | 'openSettings'
    | 'cancelMessage'
    | 'retryMessage';
  payload?: unknown;
}

export interface ExtensionMessage {
  type:
    | 'info'
    | 'error'
    | 'state'
    | 'settingsOpened'
    | 'chatCleared'
    | 'streamEvent'
    | 'messageCreated'
    | 'messageUpdated';
  payload: unknown;
}

export interface SendMessagePayload {
  content: string;
  conversationId?: string;
}

export interface NewChatPayload {
  timestamp: string;
}

export interface PromptSelectedPayload {
  prompt: string;
}

export interface OpenSettingsPayload {
  reason: 'user_click' | 'model_status_click';
}

export interface CancelMessagePayload {
  messageId: string;
  conversationId: string;
}

export interface RetryMessagePayload {
  messageId: string;
  conversationId: string;
}

export interface ExtensionStatePayload {
  messages: Message[];
  currentInput: string;
  viewMode: ViewMode;
  isLoading: boolean;
  modelConfigured: boolean;
  conversationId?: string;
}

export interface ExtensionInfoPayload {
  message: string;
}

export interface ExtensionErrorPayload {
  message: string;
}

export interface StreamEventPayload {
  event: {
    type: string;
    conversationId: string;
    messageId: string;
    delta?: string;
    finishReason?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokens?: number;
    };
    error?: {
      code: string;
      message: string;
      retryable: boolean;
      providerErrorCode?: string;
    };
  };
}

export interface MessageCreatedPayload {
  message: Message;
}

export interface MessageUpdatedPayload {
  message: Message;
}

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}
