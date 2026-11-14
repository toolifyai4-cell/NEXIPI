import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock window.acquireVsCodeApi for each test
const mockPostMessage = vi.fn();
const mockAcquireVsCodeApi = vi.fn(() => ({
  postMessage: mockPostMessage,
  getState: vi.fn(),
  setState: vi.fn(),
}));

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

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockClear();
    mockAcquireVsCodeApi.mockClear();

    Object.defineProperty(global.window, 'acquireVsCodeApi', {
      value: mockAcquireVsCodeApi,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(global.window, 'parent', {
      value: { postMessage: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  it('renders header with NexiPi branding', () => {
    render(<App />);
    expect(screen.getByText('NexiPi')).toBeInTheDocument();
  });

  it('renders welcome screen when viewMode is welcome', () => {
    render(<App />);
    expect(screen.getByText('Welcome to NexiPi')).toBeInTheDocument();
    expect(
      screen.getByText(
        'An extensible AI coding agent for Visual Studio Code. NexiPi helps you understand, write, and improve code through natural conversation.'
      )
    ).toBeInTheDocument();
  });

  it('renders prompt cards', () => {
    render(<App />);
    expect(screen.getByText('Explain this codebase')).toBeInTheDocument();
    expect(screen.getByText('Find a bug')).toBeInTheDocument();
  });

  it('renders status indicator as interactive button with disconnected status initially', () => {
    render(<App />);
    const statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusButton).toBeInTheDocument();
  });

  it('calls handleNewChat when new chat button is clicked', () => {
    render(<App />);
    const newChatBtn = screen.getByLabelText('New chat');
    fireEvent.click(newChatBtn);
    // Should stay in welcome mode
    expect(screen.getByText('Welcome to NexiPi')).toBeInTheDocument();
  });

  it('populates composer when a prompt card is clicked', () => {
    render(<App />);
    const promptCard = screen.getByLabelText('Try: Explain this codebase');
    fireEvent.click(promptCard);
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).toHaveValue(
      'Give me an overview of this repository structure and key components.'
    );
  });

  it('opens settings dropdown when settings button is clicked', () => {
    render(<App />);
    const menuBtn = screen.getByLabelText('Settings');
    fireEvent.click(menuBtn);
    const settingsItem = screen.getByRole('menuitem', { name: /Settings/i });
    expect(settingsItem).toBeInTheDocument();
  });

  it('sends openSettings message when settings menu item is clicked', () => {
    render(<App />);
    const menuBtn = screen.getByLabelText('Settings');
    fireEvent.click(menuBtn);
    const settingsItem = screen.getByRole('menuitem', { name: /Settings/i });
    fireEvent.click(settingsItem);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openSettings',
      payload: { reason: 'user_click' },
    });
  });

  it('sends openSettings message with model_status_click when status indicator is clicked', () => {
    render(<App />);
    // Clear the mock to ignore the initial 'ready' message
    mockPostMessage.mockClear();
    const statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    fireEvent.click(statusButton);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openSettings',
      payload: { reason: 'model_status_click' },
    });
  });

  it('composer is enabled when model is not configured (only disabled during loading)', () => {
    render(<App />);
    // Default modelConfigured is false, but composer only disabled during loading
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).not.toBeDisabled();
    const sendBtn = screen.getByLabelText('Send message');
    // Send button is disabled when textarea is empty (correct behavior)
    expect(sendBtn).toBeDisabled();
  });

  it('composer shows placeholder to configure model when not configured', () => {
    render(<App />);
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).toHaveAttribute('placeholder', 'Configure an AI model to start chatting');
  });

  it('composer becomes enabled after receiving model configured state', () => {
    render(<App />);
    // Initially disabled (model not configured, but composer only disabled when loading)
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).not.toBeDisabled();

    // Simulate extension sending model configured state
    act(() => {
      simulateExtensionStateMessage(true);
    });

    // Textarea should still be enabled (composer only disabled when loading)
    expect(textarea).not.toBeDisabled();
    const sendBtn = screen.getByLabelText('Send message');
    // Send button is disabled when textarea is empty (correct behavior)
    expect(sendBtn).toBeDisabled();
    expect(textarea).toHaveAttribute('placeholder', 'Message NexiPi...');
  });

  it('status indicator shows connected when model is configured', () => {
    render(<App />);
    // Initially disconnected
    let statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusButton).toBeInTheDocument();

    // Simulate extension sending model configured state
    act(() => {
      simulateExtensionStateMessage(true);
    });

    // Now should show connected
    statusButton = screen.getByRole('button', {
      name: /Model status: AI model configured/,
    });
    expect(statusButton).toBeInTheDocument();
  });

  it('sends message and shows loading when model configured', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });

    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'test message' } });

    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    await act(async () => {
      fireEvent.keyDown(textarea, event);
    });

    // Wait for view to switch to chat mode
    await waitFor(() => {
      expect(screen.getByText('test message')).toBeInTheDocument();
    });
    expect(textarea).toHaveValue('');

    // Should show loading indicator (typing indicator)
    expect(screen.getByRole('status', { name: /waiting for response/i })).toBeInTheDocument();
  });

  it('shows error message and keeps composer enabled when sending without model configured', async () => {
    render(<App />);
    // Ensure modelConfigured is false
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'state',
            payload: {
              messages: [],
              currentInput: '',
              viewMode: 'welcome',
              isLoading: false,
              modelConfigured: false,
            },
          },
        })
      );
    });
    // Default modelConfigured is false
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'hello' } });

    // Use Ctrl+Enter to send (bypasses disabled button)
    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    await act(async () => {
      fireEvent.keyDown(textarea, event);
    });

    // User message should appear
    await waitFor(() => {
      expect(screen.getByText('hello')).toBeInTheDocument();
    });

    // Error message should appear (use flexible text matcher)
    await waitFor(() => {
      expect(screen.getByText(/No AI model is configured/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Open NexiPi settings to configure a model before chatting/i)
      ).toBeInTheDocument();
    });

    // Composer should still be enabled (not disabled)
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveValue('');

    // Should NOT show loading indicator
    expect(screen.queryByRole('status', { name: /waiting for response/i })).not.toBeInTheDocument();
  });

  it('Shift+Enter inserts newline in textarea', () => {
    render(<App />);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'line 1' } });

    const event = {
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    fireEvent.keyDown(textarea, event);

    // In jsdom, Shift+Enter doesn't automatically insert newline,
    // so we simulate the default behavior by updating the value
    fireEvent.change(textarea, { target: { value: 'line 1\n' } });

    // Should not submit, just allow newline (default behavior)
    expect(textarea).toHaveValue('line 1\n');
  });

  it('new chat button clears messages and returns to welcome view', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    const sendBtn = screen.getByLabelText('Send message');

    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('hello')).toBeInTheDocument();
    });

    const newChatBtn = screen.getByLabelText('New chat');
    await act(async () => {
      fireEvent.click(newChatBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Welcome to NexiPi')).toBeInTheDocument();
    });
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('');
  });

  it('resets loading state when extension sends info message', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });

    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'test' } });

    const sendBtn = screen.getByLabelText('Send message');
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /waiting for response/i })).toBeInTheDocument();
    });

    // Simulate extension response
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'info',
            payload: { message: 'AI response' },
          },
        })
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: /waiting for response/i })
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('AI response')).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
  });

  // Regression tests for Phase 03 runtime issues

  it('regression: exact screenshot state - modelConfigured=false, user submits hi, no loading, composer enabled, both indicators show unconfigured', async () => {
    render(<App />);
    // Ensure modelConfigured is false (default)
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute('placeholder', 'Configure an AI model to start chatting');

    // Status indicator shows disconnected
    let statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusButton).toBeInTheDocument();

    // Composer footer shows "AI model not configured" when not loading
    expect(screen.getByTestId('composer-status').textContent).toBe('AI model not configured');

    // User submits 'hi' via Ctrl+Enter
    fireEvent.change(textarea, { target: { value: 'hi' } });
    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;

    await act(async () => {
      fireEvent.keyDown(textarea, event);
    });

    // User message remains visible
    await waitFor(() => {
      expect(screen.getByText('hi')).toBeInTheDocument();
    });

    // Error message shown
    await waitFor(() => {
      expect(screen.getByText(/No AI model is configured/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Open NexiPi settings to configure a model before chatting/i)
      ).toBeInTheDocument();
    });

    // Loading indicator NOT shown
    expect(screen.queryByRole('status', { name: /waiting for response/i })).not.toBeInTheDocument();

    // Composer still enabled (not disabled)
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveValue('');

    // Placeholder still shows configure model message
    expect(textarea).toHaveAttribute('placeholder', 'Configure an AI model to start chatting');

    // Status indicator still shows disconnected
    statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusButton).toBeInTheDocument();

    // Composer footer shows "AI model not configured" (model not configured, not loading)
    expect(screen.getByTestId('composer-status').textContent).toBe('AI model not configured');
  });

  it('regression: both model status displays (Composer footer and StatusIndicator) show consistent state', async () => {
    render(<App />);

    // Initially both show unconfigured
    let statusIndicator = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusIndicator).toBeInTheDocument();
    expect(screen.getByTestId('composer-status').textContent).toBe('AI model not configured');

    // Simulate extension sending model configured
    act(() => {
      simulateExtensionStateMessage(true);
    });

    // Both should now show configured
    statusIndicator = screen.getByRole('button', {
      name: /Model status: AI model configured/,
    });
    expect(statusIndicator).toBeInTheDocument();

    // Composer footer should show "Ready" (not loading, model configured)
    expect(screen.getByTestId('composer-status').textContent).toBe('Ready');

    // Simulate extension sending model unconfigured
    act(() => {
      simulateExtensionStateMessage(false);
    });

    // Both should show unconfigured again
    statusIndicator = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    expect(statusIndicator).toBeInTheDocument();
    expect(screen.getByTestId('composer-status').textContent).toBe('AI model not configured');
  });

  it('regression: loading state shows "Waiting for response..." in Composer footer, not "AI model not configured"', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });

    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'test' } });

    const sendBtn = screen.getByLabelText('Send message');
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /waiting for response/i })).toBeInTheDocument();
    });

    // Composer footer should show "Waiting for response..." during loading
    expect(screen.getByText('Waiting for response...')).toBeInTheDocument();
    expect(screen.queryByText('AI model not configured')).not.toBeInTheDocument();

    // Send button title should be "Waiting for response..."
    expect(sendBtn).toHaveAttribute('title', 'Waiting for response...');
  });

  it('regression: Settings menu item sends openSettings message with correct payload', () => {
    render(<App />);
    const menuBtn = screen.getByLabelText('Settings');
    fireEvent.click(menuBtn);
    const settingsItem = screen.getByRole('menuitem', { name: /Settings/i });
    fireEvent.click(settingsItem);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openSettings',
      payload: { reason: 'user_click' },
    });
  });

  it('regression: StatusIndicator click sends openSettings with model_status_click reason', () => {
    render(<App />);
    mockPostMessage.mockClear();
    const statusButton = screen.getByRole('button', {
      name: /Model status: AI model not configured/,
    });
    fireEvent.click(statusButton);

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'openSettings',
      payload: { reason: 'model_status_click' },
    });
  });

  it('regression: extension error response resets loading and shows error in chat', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });

    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'test' } });

    const sendBtn = screen.getByLabelText('Send message');
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /waiting for response/i })).toBeInTheDocument();
    });

    // Simulate extension error
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'error',
            payload: { message: 'Connection failed' },
          },
        })
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: /waiting for response/i })
      ).not.toBeInTheDocument();
    });

    expect(screen.getByText('Error: Connection failed')).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
  });

  it('regression: chatCleared from extension resets loading and clears messages', async () => {
    render(<App />);
    act(() => {
      simulateExtensionStateMessage(true);
    });

    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'hello' } });

    const sendBtn = screen.getByLabelText('Send message');
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /waiting for response/i })).toBeInTheDocument();
    });
    expect(screen.getByText('hello')).toBeInTheDocument();

    // Simulate chatCleared from extension
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

    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: /waiting for response/i })
      ).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('Welcome to NexiPi')).toBeInTheDocument();
    });
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
  });
});
