import type { Message, ViewMode, WebviewMessage } from '../types';
export declare function useChat(): {
  messages: Message[];
  isLoading: boolean;
  currentInput: string;
  setCurrentInput: import('react').Dispatch<import('react').SetStateAction<string>>;
  viewMode: ViewMode;
  sendMessage: () => Promise<void>;
  handleNewChat: () => void;
  handlePromptSelect: (prompt: string) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  scrollToBottom: () => void;
  messagesEndRef: import('react').RefObject<HTMLDivElement>;
  postMessage: (message: WebviewMessage) => void;
  welcomePrompts: {
    label: string;
    prompt: string;
  }[];
};
