import { useRef, useEffect } from 'react';

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
  modelConfigured: boolean;
  onCancel?: () => void;
}

export function Composer({
  value,
  onChange,
  onSend,
  onKeyDown,
  isLoading,
  modelConfigured,
  onCancel,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoading && value.trim()) {
      onSend();
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    }
  };

  const getFooterStatus = () => {
    if (isLoading) {
      return 'Generating response...';
    }
    if (!modelConfigured) {
      return 'AI model not configured';
    }
    return 'Ready';
  };

  const getSendButtonTitle = () => {
    if (isLoading) {
      return 'Waiting for response...';
    }
    if (!modelConfigured) {
      return 'AI model not configured';
    }
    return 'Send message';
  };

  return (
    <form
      className="nexipi-composer"
      onSubmit={handleSubmit}
      role="form"
      aria-label="Message composer"
    >
      <div className="nexipi-composer-toolbar">
        <button
          type="button"
          className="nexipi-composer-btn"
          aria-label="Add context"
          title="Add context (not yet implemented)"
          disabled
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z" />
            <polyline points="15 3 15 9 21 9" />
            <path d="M10.5 15.5L12 17l4.5-4.5" />
            <path d="M15 12H3" />
            <path d="M15 9H3" />
          </svg>
        </button>
        <div className="nexipi-composer-spacer" />
        <span className="nexipi-composer-hint">Ctrl+Enter to send</span>
      </div>
      <div className="nexipi-composer-input-wrapper">
        <textarea
          ref={textareaRef}
          className="nexipi-composer-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isLoading}
          placeholder={
            isLoading
              ? 'Waiting for response...'
              : modelConfigured
                ? 'Message NexiPi...'
                : 'Configure an AI model to start chatting'
          }
          aria-label="Message input"
          aria-multiline="true"
          rows={1}
          spellCheck={false}
        />
      </div>
      <div className="nexipi-composer-footer">
        <span className="nexipi-composer-status" aria-live="polite" data-testid="composer-status">
          {getFooterStatus()}
        </span>
        {isLoading ? (
          <button
            type="button"
            className="nexipi-composer-cancel"
            onClick={handleCancel}
            aria-label="Stop generation"
            title="Stop generation"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="nexipi-composer-send"
            disabled={!value.trim() || !modelConfigured}
            aria-label="Send message"
            title={getSendButtonTitle()}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
