import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChat } from './useChat';

describe('useChat hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const simulateExtensionStateMessage = (modelConfigured: boolean) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'state',
          payload: {
            messages: [],
            currentInput: '',
            viewMode: 'welcome',
            isLoading: false,
            modelConfigured,
          },
        },
      })
    );
  };

  const simulateExtensionInfoMessage = (message: string) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'info',
          payload: { message },
        },
      })
    );
  };

  it('initializes with welcome view mode and empty state', () => {
    const { result } = renderHook(() => useChat());
    expect(result.current.messages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.currentInput).toBe('');
    expect(result.current.viewMode).toBe('welcome');
    expect(result.current.modelConfigured).toBe(false);
  });

  it('has welcome prompts', () => {
    const { result } = renderHook(() => useChat());
    expect(result.current.welcomePrompts).toHaveLength(4);
    expect(result.current.welcomePrompts[0].label).toBe('Explain this codebase');
  });

  it('updates currentInput when setCurrentInput is called', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.setCurrentInput('test message');
    });
    expect(result.current.currentInput).toBe('test message');
  });

  it('handlePromptSelect sets currentInput', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.handlePromptSelect('selected prompt');
    });
    expect(result.current.currentInput).toBe('selected prompt');
  });

  it('handleNewChat resets state to welcome mode', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.setCurrentInput('some input');
    });
    act(() => {
      result.current.sendMessage();
    });
    act(() => {
      result.current.handleNewChat();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.currentInput).toBe('');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.viewMode).toBe('welcome');
  });

  it('sendMessage adds user message and sets loading when model is configured', () => {
    const { result } = renderHook(() => useChat());
    // Simulate extension sending model configured state
    act(() => {
      simulateExtensionStateMessage(true);
    });
    expect(result.current.modelConfigured).toBe(true);

    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.messages[0].content).toBe('hello');
    expect(result.current.isLoading).toBe(true);
    expect(result.current.viewMode).toBe('chat');
    expect(result.current.currentInput).toBe('');
  });

  it('sendMessage does nothing when input is empty', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.sendMessage();
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it('sendMessage does nothing when isLoading is true', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });
    // Try to send again while loading
    act(() => {
      result.current.sendMessage();
    });
    // Should still only have one message
    expect(result.current.messages).toHaveLength(1);
  });

  it('sendMessage shows error and does not set loading when model is not configured', () => {
    const { result } = renderHook(() => useChat());
    // Default modelConfigured is false
    expect(result.current.modelConfigured).toBe(false);

    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });

    // User message should be added
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.messages[0].content).toBe('hello');
    // Error message should be added
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe(
      'No AI model is configured. Open NexiPi settings to configure a model before chatting.'
    );
    // Loading should NOT be set
    expect(result.current.isLoading).toBe(false);
    expect(result.current.viewMode).toBe('chat');
    expect(result.current.currentInput).toBe('');
  });

  it('handleKeyDown sends on Ctrl+Enter when model configured', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('test');
    });

    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    act(() => {
      result.current.handleKeyDown(event);
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].content).toBe('test');
  });

  it('handleKeyDown sends on Meta+Enter (Mac) when model configured', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('test');
    });

    const event = {
      key: 'Enter',
      ctrlKey: false,
      metaKey: true,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    act(() => {
      result.current.handleKeyDown(event);
    });

    expect(result.current.messages).toHaveLength(1);
  });

  it('handleKeyDown does not send when model not configured', () => {
    const { result } = renderHook(() => useChat());
    // modelConfigured defaults to false
    act(() => {
      result.current.setCurrentInput('test');
    });

    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    act(() => {
      result.current.handleKeyDown(event);
    });

    // Should show error message, not send
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe('test');
    expect(result.current.messages[1].content).toContain('No AI model is configured');
    expect(result.current.isLoading).toBe(false);
  });

  it('handleOpenSettings is a function', () => {
    const { result } = renderHook(() => useChat());
    expect(typeof result.current.handleOpenSettings).toBe('function');
  });

  it('postMessage is a function', () => {
    const { result } = renderHook(() => useChat());
    expect(typeof result.current.postMessage).toBe('function');
  });

  it('resets loading state on extension info message', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });
    expect(result.current.isLoading).toBe(true);

    act(() => {
      simulateExtensionInfoMessage('Response from AI');
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe('Response from AI');
  });

  it('resets loading state on extension error message', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });
    expect(result.current.isLoading).toBe(true);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            payload: { message: 'Something went wrong' },
          },
        })
      );
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe('Error: Something went wrong');
  });

  it('clears messages on chatCleared message from extension', () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      simulateExtensionStateMessage(true);
    });
    act(() => {
      result.current.setCurrentInput('hello');
    });
    act(() => {
      result.current.sendMessage();
    });
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'chatCleared',
            payload: { timestamp: new Date().toISOString() },
          },
        })
      );
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.viewMode).toBe('welcome');
    expect(result.current.isLoading).toBe(false);
  });
});
