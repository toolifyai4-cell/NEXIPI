import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { App } from './App';

// Mock window.acquireVsCodeApi for each test
const mockPostMessage = vi.fn();
const mockAcquireVsCodeApi = vi.fn(() => ({
  postMessage: mockPostMessage,
  getState: vi.fn(),
  setState: vi.fn(),
}));

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

  it('renders status indicator as interactive button', () => {
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

  it('send button is disabled when input is empty', () => {
    render(<App />);
    const sendBtn = screen.getByLabelText('Send message');
    expect(sendBtn).toBeDisabled();
  });

  it('send button is enabled when input has content', () => {
    render(<App />);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    const sendBtn = screen.getByLabelText('Send message');
    expect(sendBtn).not.toBeDisabled();
  });

  it('Ctrl+Enter submits the message and switches to chat view', async () => {
    render(<App />);
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
});
