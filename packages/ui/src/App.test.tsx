import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from './App';
import { useChat } from './hooks/useChat';

vi.mock('./hooks/useChat');

const createMockUseChat = (overrides: Partial<ReturnType<typeof useChat>> = {}) => ({
  messages: [],
  isLoading: false,
  currentInput: '',
  setCurrentInput: vi.fn(),
  viewMode: 'welcome' as const,
  sendMessage: vi.fn(),
  handleNewChat: vi.fn(),
  handlePromptSelect: vi.fn(),
  handleKeyDown: vi.fn(),
  messagesEndRef: { current: null },
  welcomePrompts: [
    { label: 'Test prompt 1', prompt: 'Test prompt 1 content' },
    { label: 'Test prompt 2', prompt: 'Test prompt 2 content' },
  ],
  postMessage: vi.fn(),
  scrollToBottom: vi.fn(),
  ...overrides,
});

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useChat).mockReturnValue(createMockUseChat());
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
    expect(screen.getByText('Test prompt 1')).toBeInTheDocument();
    expect(screen.getByText('Test prompt 2')).toBeInTheDocument();
  });

  it('renders status indicator with disconnected status', () => {
    render(<App />);
    expect(screen.getByText('AI model not configured')).toBeInTheDocument();
  });

  it('calls handleNewChat when new chat button is clicked', () => {
    render(<App />);
    const newChatBtn = screen.getByLabelText('New chat');
    fireEvent.click(newChatBtn);
    expect(vi.mocked(useChat).mock.results[0].value.handleNewChat).toHaveBeenCalled();
  });

  it('calls handlePromptSelect when a prompt card is clicked', () => {
    render(<App />);
    const promptCard = screen.getByLabelText('Try: Test prompt 1');
    fireEvent.click(promptCard);
    expect(vi.mocked(useChat).mock.results[0].value.handlePromptSelect).toHaveBeenCalledWith(
      'Test prompt 1 content'
    );
  });
});

describe('App - Chat Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useChat).mockReturnValue(
      createMockUseChat({
        messages: [
          { id: '1', role: 'user', content: 'Hello', timestamp: new Date() },
          { id: '2', role: 'assistant', content: 'Hi there!', timestamp: new Date() },
        ],
        currentInput: 'test message',
        viewMode: 'chat',
      })
    );
  });

  it('renders chat area with messages when viewMode is chat', () => {
    render(<App />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('renders composer with current input value', () => {
    render(<App />);
    const textarea = screen.getByLabelText('Message input');
    expect(textarea).toHaveValue('test message');
  });

  it('calls setCurrentInput when typing in composer', () => {
    render(<App />);
    const textarea = screen.getByLabelText('Message input');
    fireEvent.change(textarea, { target: { value: 'new message' } });
    expect(vi.mocked(useChat).mock.results[0].value.setCurrentInput).toHaveBeenCalledWith(
      'new message'
    );
  });

  it('calls sendMessage when send button is clicked', () => {
    render(<App />);
    const sendBtn = screen.getByLabelText('Send message');
    fireEvent.click(sendBtn);
    expect(vi.mocked(useChat).mock.results[0].value.sendMessage).toHaveBeenCalled();
  });

  it('does not call sendMessage when input is empty', () => {
    vi.clearAllMocks();
    vi.mocked(useChat).mockReturnValue(
      createMockUseChat({
        messages: [],
        currentInput: '',
        viewMode: 'chat',
      })
    );

    render(<App />);
    const sendBtn = screen.getByLabelText('Send message');
    fireEvent.click(sendBtn);
    expect(vi.mocked(useChat).mock.results[0].value.sendMessage).not.toHaveBeenCalled();
  });

  it('calls handleNewChat when new chat button is clicked in chat mode', () => {
    render(<App />);
    const newChatBtn = screen.getByLabelText('New chat');
    fireEvent.click(newChatBtn);
    expect(vi.mocked(useChat).mock.results[0].value.handleNewChat).toHaveBeenCalled();
  });
});
