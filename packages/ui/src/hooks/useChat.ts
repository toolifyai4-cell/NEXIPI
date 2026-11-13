import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, ViewMode, WebviewMessage } from '../types';

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

  const sendMessage = useCallback(() => {
    if (!currentInput.trim() || isLoading) return;

    const userMessage = currentInput.trim();
    setCurrentInput('');
    addMessage('user', userMessage);
    setIsLoading(true);
    setViewMode('chat');

    // Simulate AI response delay - in Phase 04 this will be replaced with actual AI call
    setTimeout(() => {
      addMessage(
        'assistant',
        'AI conversation functionality will be implemented in Phase 04. This is a placeholder response.'
      );
      setIsLoading(false);
    }, 1000);
  }, [currentInput, isLoading, addMessage]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCurrentInput('');
    setIsLoading(false);
    setViewMode('welcome');
  }, []);

  const handlePromptSelect = useCallback((prompt: string) => {
    setCurrentInput(prompt);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const postMessage = useCallback((message: WebviewMessage) => {
    // Use VS Code Webview API when available (inside webview context)
    // Fallback to window.parent.postMessage for development/testing outside webview
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

  useEffect(() => {
    postMessage({ type: 'ready' });
  }, [postMessage]);

  return {
    messages,
    isLoading,
    currentInput,
    setCurrentInput,
    viewMode,
    sendMessage,
    handleNewChat,
    handlePromptSelect,
    handleKeyDown,
    scrollToBottom,
    messagesEndRef,
    postMessage,
    welcomePrompts: WELCOME_PROMPTS,
  };
}
