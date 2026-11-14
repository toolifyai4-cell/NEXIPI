export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

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
  type: 'sendMessage' | 'newChat' | 'promptSelected' | 'ready' | 'openSettings';
  payload?: unknown;
}

export interface ExtensionMessage {
  type: 'info' | 'error' | 'state' | 'settingsOpened' | 'chatCleared';
  payload: unknown;
}

export interface SendMessagePayload {
  content: string;
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

export interface ExtensionStatePayload {
  messages: Message[];
  currentInput: string;
  viewMode: ViewMode;
  isLoading: boolean;
  modelConfigured: boolean;
}

export interface ExtensionInfoPayload {
  message: string;
}

export interface ExtensionErrorPayload {
  message: string;
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
