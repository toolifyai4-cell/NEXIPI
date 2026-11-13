import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from './App';

const mockUseChat = {
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
};

vi.mock('./hooks/useChat', () => ({
  useChat: vi.fn(() => mockUseChat),
}));

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders header with NexiPi branding', () => {
    render(<App />);
    expect(screen.getByText('NexiPi')).toBeInTheDocument();
  });

  it('renders welcome screen when viewMode is welcome', () => {
    render(<App />);
    expect(screen.getByText('Welcome to NexiPi')).toBeInTheDocument();
    expect(screen.getByText('An extensible AI coding agent for Visual Studio Code.')).toBeInTheDocument();
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
    expect(mockUseChat.handleNewChat).toHaveBeenCalled();
  });
});