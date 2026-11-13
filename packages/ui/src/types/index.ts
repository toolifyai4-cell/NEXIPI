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
  type: 'sendMessage' | 'newChat' | 'promptSelected' | 'ready';
  payload?: unknown;
}

export interface ExtensionMessage {
  type: 'info' | 'error' | 'state';
  payload: unknown;
}
