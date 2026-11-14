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

  it('initializes with welcome view mode and empty state', () => {
    const { result } = renderHook(() => useChat());
    expect(result.current.messages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.currentInput).toBe('');
    expect(result.current.viewMode).toBe('welcome');
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

  it('sendMessage adds user message and sets loading', () => {
    const { result } = renderHook(() => useChat());
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
      result.current.sendMessage();
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it('sendMessage does nothing when isLoading is true', () => {
    const { result } = renderHook(() => useChat());
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

  it('handleKeyDown sends on Ctrl+Enter', () => {
    const { result } = renderHook(() => useChat());
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

  it('handleKeyDown sends on Meta+Enter (Mac)', () => {
    const { result } = renderHook(() => useChat());
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
});
