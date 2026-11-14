import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  Message,
  ViewMode,
  WebviewMessage,
  SendMessagePayload,
  NewChatPayload,
  PromptSelectedPayload,
  OpenSettingsPayload,
  ExtensionMessage,
  ExtensionStatePayload,
  ExtensionInfoPayload,
  ExtensionErrorPayload,
} from '../types';

const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const WELCOME_PROMPTS = [
  {
    label: 'Explain this codebase',
    prompt: 'Give me an overview of this repository structure and key components.',
  },
  {
    label: 'Find a bug',
    prompt: 'Help me identify potential issues in the current file.',
  },
  {
    label: 'Write a test',
    prompt: 'Generate unit tests for the selected function.',
  },
  {
    label: 'Refactor this code',
    prompt: 'Suggest improvements for readability and maintainability.',
  },
];

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentInput, setCurrentInput] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('welcome');
  const [modelConfigured, setModelConfigured] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const addMessage = useCallback((role: Message['role'], content: string) => {
    const message: Message = {
      id: generateId(),
      role,
      content,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, message]);
    return message;
  }, []);

  const resetLoadingState = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleExtensionMessage = useCallback(
    (event: MessageEvent) => {
      const message = event.data as ExtensionMessage;
      if (!message || typeof message !== 'object' || !message.type) {
        return;
      }

      switch (message.type) {
        case 'state': {
          const payload = message.payload as ExtensionStatePayload;
          if (payload && typeof payload.modelConfigured === 'boolean') {
            setModelConfigured(payload.modelConfigured);
          }
          break;
        }
        case 'info': {
          const payload = message.payload as ExtensionInfoPayload;
          if (payload?.message) {
            addMessage('assistant', payload.message);
          }
          resetLoadingState();
          break;
        }
        case 'error': {
          const payload = message.payload as ExtensionErrorPayload;
          if (payload?.message) {
            addMessage('assistant', `Error: ${payload.message}`);
          }
          resetLoadingState();
          break;
        }
        case 'chatCleared': {
          setMessages([]);
          setViewMode('welcome');
          resetLoadingState();
          break;
        }
        case 'settingsOpened': {
          // Settings opened, no state change needed
          break;
        }
        default:
          break;
      }
    },
    [addMessage, resetLoadingState]
  );

  useEffect(() => {
    window.addEventListener('message', handleExtensionMessage);
    return () => window.removeEventListener('message', handleExtensionMessage);
  }, [handleExtensionMessage]);

  const postMessage = useCallback((message: WebviewMessage) => {
    try {
      const vscodeApi = window.acquireVsCodeApi?.();
      if (vscodeApi) {
        vscodeApi.postMessage(message);
        return;
      }
    } catch {
      // acquireVsCodeApi not available or already called
    }
    if (window.parent !== window) {
      window.parent.postMessage(message, '*');
    }
  }, []);

  const sendMessage = useCallback(() => {
    if (!currentInput.trim() || isLoading) return;

    if (!modelConfigured) {
      const userMessage = currentInput.trim();
      setCurrentInput('');
      addMessage('user', userMessage);
      setViewMode('chat');

      // Show error message for missing model
      addMessage(
        'assistant',
        'No AI model is configured. Open NexiPi settings to configure a model before chatting.'
      );
      // Do not set isLoading, composer stays enabled
      return;
    }

    const userMessage = currentInput.trim();
    setCurrentInput('');
    addMessage('user', userMessage);
    setIsLoading(true);
    setViewMode('chat');

    // Send message to extension host
    const payload: SendMessagePayload = { content: userMessage };
    postMessage({ type: 'sendMessage', payload });
  }, [currentInput, isLoading, modelConfigured, addMessage, postMessage]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCurrentInput('');
    setIsLoading(false);
    setViewMode('welcome');

    // Notify extension host
    const payload: NewChatPayload = { timestamp: new Date().toISOString() };
    postMessage({ type: 'newChat', payload });
  }, [postMessage]);

  const handlePromptSelect = useCallback(
    (prompt: string) => {
      setCurrentInput(prompt);
      // Notify extension host
      const payload: PromptSelectedPayload = { prompt };
      postMessage({ type: 'promptSelected', payload });
    },
    [postMessage]
  );

  const handleOpenSettings = useCallback(
    (reason: 'user_click' | 'model_status_click' = 'user_click') => {
      const payload: OpenSettingsPayload = { reason };
      postMessage({ type: 'openSettings', payload });
    },
    [postMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+Enter (or Cmd+Enter on Mac) to send
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
      // Shift+Enter inserts newline (default textarea behavior, no action needed)
    },
    [sendMessage]
  );

  useEffect(() => {
    postMessage({ type: 'ready' });
  }, [postMessage]);

  return {
    messages,
    isLoading,
    currentInput,
    setCurrentInput,
    viewMode,
    modelConfigured,
    sendMessage,
    handleNewChat,
    handlePromptSelect,
    handleOpenSettings,
    handleKeyDown,
    scrollToBottom,
    messagesEndRef,
    postMessage,
    welcomePrompts: WELCOME_PROMPTS,
  };
}
