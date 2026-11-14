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
  StreamEventPayload,
  MessageCreatedPayload,
  MessageUpdatedPayload,
  CancelMessagePayload,
  RetryMessagePayload,
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

interface UseChatOptions {
  onStreamEvent?: (event: StreamEventPayload['event']) => void;
}

export function useChat(options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentInput, setCurrentInput] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('welcome');
  const [modelConfigured, setModelConfigured] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscodeApiRef = useRef<ReturnType<NonNullable<Window['acquireVsCodeApi']>> | null>(null);
  const pendingUserMessageRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const addMessage = useCallback((role: Message['role'], content: string, status: Message['status'] = 'pending', metadata?: Record<string, unknown>) => {
    const message: Message = {
      id: generateId(),
      conversationId: conversationId ?? generateId(),
      role,
      content,
      status,
      timestamp: Date.now(),
      metadata,
    };
    setMessages(prev => [...prev, message]);
    return message;
  }, [conversationId]);

  const updateMessage = useCallback((messageId: string, updates: Partial<Pick<Message, 'content' | 'status' | 'metadata'>>) => {
    setMessages(prev => prev.map(msg =>
      msg.id === messageId ? { ...msg, ...updates, metadata: { ...msg.metadata, ...updates.metadata } } : msg
    ));
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

      console.debug('[NexiPi] Received extension message:', message.type, message.payload);

      switch (message.type) {
        case 'state': {
          const payload = message.payload as ExtensionStatePayload;
          if (payload && typeof payload.modelConfigured === 'boolean') {
            console.debug('[NexiPi] Model configured state updated:', payload.modelConfigured);
            setModelConfigured(payload.modelConfigured);
          }
          if (payload.conversationId) {
            setConversationId(payload.conversationId);
          }
          if (payload.messages && Array.isArray(payload.messages)) {
            setMessages(payload.messages);
          }
          if (payload.currentInput !== undefined) {
            setCurrentInput(payload.currentInput);
          }
          if (payload.viewMode) {
            setViewMode(payload.viewMode);
          }
          if (payload.isLoading !== undefined) {
            setIsLoading(payload.isLoading);
          }
          break;
        }
        case 'info': {
          const payload = message.payload as ExtensionInfoPayload;
          if (payload?.message) {
            addMessage('assistant', payload.message, 'completed');
          }
          resetLoadingState();
          break;
        }
        case 'error': {
          const payload = message.payload as ExtensionErrorPayload;
          if (payload?.message) {
            addMessage('assistant', `Error: ${payload.message}`, 'failed');
          }
          resetLoadingState();
          break;
        }
        case 'chatCleared': {
          setMessages([]);
          setConversationId(null);
          setCurrentInput('');
          setIsLoading(false);
          setViewMode('welcome');
          break;
        }
        case 'streamEvent': {
          const payload = message.payload as StreamEventPayload;
          if (payload?.event) {
            const { event } = payload;
            switch (event.type) {
              case 'stream:start': {
                updateMessage(event.messageId, { status: 'streaming', content: '' });
                setIsLoading(true);
                break;
              }
              case 'stream:delta': {
                setMessages(prev => prev.map(msg => {
                  if (msg.id === event.messageId) {
                    return { ...msg, content: msg.content + event.delta, status: 'streaming' };
                  }
                  return msg;
                }));
                break;
              }
              case 'stream:complete': {
                setMessages(prev => prev.map(msg => {
                  if (msg.id === event.messageId) {
                    return {
                      ...msg,
                      status: 'completed',
                      metadata: {
                        ...msg.metadata,
                        usage: event.usage,
                        finishReason: event.finishReason,
                      },
                    };
                  }
                  return msg;
                }));
                setIsLoading(false);
                break;
              }
              case 'stream:error': {
                setMessages(prev => prev.map(msg => {
                  if (msg.id === event.messageId) {
                    return {
                      ...msg,
                      status: 'failed',
                      metadata: {
                        ...msg.metadata,
                        error: event.error,
                      },
                    };
                  }
                  return msg;
                }));
                setIsLoading(false);
                break;
              }
              case 'stream:cancel': {
                setMessages(prev => prev.map(msg => {
                  if (msg.id === event.messageId) {
                    return { ...msg, status: 'cancelled' };
                  }
                  return msg;
                }));
                setIsLoading(false);
                break;
              }
            }
            options.onStreamEvent?.(event);
          }
          break;
        }
        case 'messageCreated': {
          const payload = message.payload as MessageCreatedPayload;
          if (payload?.message) {
            setMessages(prev => [...prev, payload.message]);
          }
          break;
        }
        case 'messageUpdated': {
          const payload = message.payload as MessageUpdatedPayload;
          if (payload?.message) {
            updateMessage(payload.message.id, {
              content: payload.message.content,
              status: payload.message.status,
              metadata: payload.message.metadata,
            });
          }
          break;
        }
        case 'settingsOpened': {
          console.debug('[NexiPi] Settings opened confirmation received');
          break;
        }
        default:
          console.warn('[NexiPi] Unknown extension message type:', message.type);
          break;
      }
    },
    [addMessage, resetLoadingState, updateMessage, conversationId, options]
  );

  useEffect(() => {
    window.addEventListener('message', handleExtensionMessage);
    return () => window.removeEventListener('message', handleExtensionMessage);
  }, [handleExtensionMessage]);

  const getVscodeApi = useCallback(() => {
    if (vscodeApiRef.current) {
      return vscodeApiRef.current;
    }
    try {
      const api = window.acquireVsCodeApi?.();
      if (api) {
        vscodeApiRef.current = api;
        console.debug('[NexiPi] VS Code API acquired');
        return api;
      }
    } catch (error) {
      console.warn('[NexiPi] acquireVsCodeApi failed:', error);
    }
    return null;
  }, []);

  const postMessage = useCallback(
    (message: WebviewMessage) => {
      const api = getVscodeApi();
      if (api) {
        console.debug('[NexiPi] Sending message via VS Code API:', message.type);
        api.postMessage(message);
        return;
      }
      if (window.parent !== window) {
        console.debug(
          '[NexiPi] Sending message via window.parent.postMessage (fallback):',
          message.type
        );
        window.parent.postMessage(message, '*');
      } else {
        console.warn('[NexiPi] No messaging channel available, message dropped:', message.type);
      }
    },
    [getVscodeApi]
  );

  const sendMessage = useCallback(() => {
    if (!currentInput.trim() || isLoading) return;

    if (!modelConfigured) {
      const userMessage = currentInput.trim();
      setCurrentInput('');
      addMessage('user', userMessage, 'completed');
      setViewMode('chat');

      addMessage(
        'assistant',
        'No AI model is configured. Open NexiPi settings to configure a model before chatting.',
        'failed'
      );
      return;
    }

    const userMessage = currentInput.trim();
    pendingUserMessageRef.current = userMessage;
    setCurrentInput('');
    addMessage('user', userMessage, 'completed');
    setIsLoading(true);
    setViewMode('chat');

    const payload: SendMessagePayload = { content: userMessage };
    postMessage({ type: 'sendMessage', payload });
  }, [currentInput, isLoading, modelConfigured, addMessage, postMessage]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCurrentInput('');
    setIsLoading(false);
    setViewMode('welcome');
    setConversationId(null);
    pendingUserMessageRef.current = null;

    const payload: NewChatPayload = { timestamp: new Date().toISOString() };
    postMessage({ type: 'newChat', payload });
  }, [postMessage]);

  const handlePromptSelect = useCallback(
    (prompt: string) => {
      setCurrentInput(prompt);
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

  const handleCancelMessage = useCallback(
    (messageId: string) => {
      if (!conversationId) return;
      const payload: CancelMessagePayload = { messageId, conversationId };
      postMessage({ type: 'cancelMessage', payload });
    },
    [conversationId, postMessage]
  );

  const handleRetryMessage = useCallback(
    (messageId: string) => {
      if (!conversationId) return;
      const payload: RetryMessagePayload = { messageId, conversationId };
      postMessage({ type: 'retryMessage', payload });
    },
    [conversationId, postMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
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
    conversationId,
    sendMessage,
    handleNewChat,
    handlePromptSelect,
    handleOpenSettings,
    handleCancelMessage,
    handleRetryMessage,
    handleKeyDown,
    scrollToBottom,
    messagesEndRef,
    postMessage,
    welcomePrompts: WELCOME_PROMPTS,
  };
}