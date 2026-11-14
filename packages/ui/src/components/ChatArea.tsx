import type { Message } from '../types';

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

export function ChatArea({ messages, isLoading, messagesEndRef }: ChatAreaProps) {
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
          <MessageBubble key={message.id} message={message} />
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
}

function MessageBubble({ message }: MessageBubbleProps) {
  const timeString = message.timestamp.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

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
          <time className="nexipi-message-time" dateTime={message.timestamp.toISOString()}>
            {timeString}
          </time>
        </div>
        <div className="nexipi-message-text">{formatMessage(message.content)}</div>
      </div>
    </article>
  );
}

function formatMessage(content: string): React.ReactNode {
  // Simple markdown-like formatting for code blocks and inline code
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
