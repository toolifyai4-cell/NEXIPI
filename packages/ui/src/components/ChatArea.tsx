import { useMemo } from 'react';
import type { Message, MessageStatus } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  onCancelMessage?: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
}

export function ChatArea({ messages, isLoading, messagesEndRef, onCancelMessage, onRetryMessage }: ChatAreaProps) {
  if (messages.length === 0) {
    return (
      <div className="nexipi-chat-empty" role="status" aria-live="polite">
        <div className="nexipi-empty-state">
          <svg
            className="nexipi-empty-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <p className="nexipi-empty-text">No messages yet</p>
          <p className="nexipi-empty-hint">Start a conversation or select a suggested prompt</p>
        </div>
        <div ref={messagesEndRef} />
      </div>
    );
  }

  return (
    <div className="nexipi-chat-area" role="log" aria-live="polite" aria-label="Conversation">
      <div className="nexipi-message-list">
        {messages.map(message => (
          <MessageBubble
            key={message.id}
            message={message}
            onCancel={onCancelMessage}
            onRetry={onRetryMessage}
          />
        ))}
        {isLoading && (
          <div
            className="nexipi-loading-message"
            role="status"
            aria-live="polite"
            aria-label="Waiting for response"
          >
            <div className="nexipi-typing-indicator" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  onCancel?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
}

function MessageBubble({ message, onCancel, onRetry }: MessageBubbleProps) {
  const timeString = useMemo(() => {
    return new Date(message.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [message.timestamp]);

  const statusConfig = useMemo(() => {
    switch (message.status) {
      case 'streaming':
        return { label: 'Streaming', className: 'nexipi-status--streaming' };
      case 'pending':
        return { label: 'Pending', className: 'nexipi-status--pending' };
      case 'failed':
        return { label: 'Failed', className: 'nexipi-status--failed' };
      case 'cancelled':
        return { label: 'Cancelled', className: 'nexipi-status--cancelled' };
      default:
        return { label: 'Completed', className: 'nexipi-status--completed' };
    }
  }, [message.status]);

  const showCancelButton = message.role === 'assistant' && (message.status === 'streaming' || message.status === 'pending');
  const showRetryButton = message.role === 'assistant' && (message.status === 'failed' || message.status === 'cancelled');

  return (
    <article className={`nexipi-message nexipi-message--${message.role}`} role="listitem">
      <div className="nexipi-message-avatar" aria-hidden="true">
        {message.role === 'user' ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        )}
      </div>
      <div className="nexipi-message-content">
        <div className="nexipi-message-header">
          <span className="nexipi-message-role">{message.role === 'user' ? 'You' : 'NexiPi'}</span>
          <time className="nexipi-message-time" dateTime={new Date(message.timestamp).toISOString()}>
            {timeString}
          </time>
          {(message.status !== 'completed' || message.role === 'assistant') && (
            <span className={`nexipi-message-status ${statusConfig.className}`} aria-live="polite">
              {statusConfig.label}
            </span>
          )}
        </div>
        <div className="nexipi-message-text">{formatMessage(message.content)}</div>
        {(showCancelButton || showRetryButton) && (
          <div className="nexipi-message-actions">
            {showCancelButton && onCancel && (
              <button
                className="nexipi-message-btn nexipi-message-btn--cancel"
                onClick={() => onCancel(message.id)}
                aria-label="Stop generation"
                title="Stop generation"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            )}
            {showRetryButton && onRetry && (
              <button
                className="nexipi-message-btn nexipi-message-btn--retry"
                onClick={() => onRetry(message.id)}
                aria-label="Retry"
                title="Retry"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            )}
          </div>
        )}
        {message.status === 'failed' && message.metadata?.error && (
          <div className="nexipi-message-error" role="alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{message.metadata.error.message}</span>
            {message.metadata.error.retryable && (
              <span className="nexipi-error-retryable"> (Retryable)</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function formatMessage(content: string): React.ReactNode {
  const parts = content.split(/(`[^`]+`|```[\s\S]*?```)/g);

  return parts.map((part, index) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const code = part.slice(3, -3).trim();
      return (
        <pre key={index} className="nexipi-code-block">
          <code>{code}</code>
        </pre>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="nexipi-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part.split('\n').map((line, i) => (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        {line}
      </React.Fragment>
    ));
  });
}

import React from 'react';