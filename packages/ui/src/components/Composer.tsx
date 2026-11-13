interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder: string;
}

export function Composer({
  value,
  onChange,
  onSend,
  onKeyDown,
  disabled,
  placeholder,
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
    if (!disabled) {
      onSend();
    }
  };

  const handleAttachClick = () => {
    // Placeholder for future attachment functionality
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
          onClick={handleAttachClick}
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
          disabled={disabled}
          placeholder={placeholder}
          aria-label="Message input"
          aria-multiline="true"
          rows={1}
          spellCheck={false}
        />
      </div>
      <div className="nexipi-composer-footer">
        <span className="nexipi-composer-status" aria-live="polite">
          {disabled ? 'AI model not configured — Phase 04' : 'Ready'}
        </span>
        <button
          type="submit"
          className="nexipi-composer-send"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          title={disabled ? 'AI model not configured — coming in Phase 04' : 'Send message'}
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
      </div>
    </form>
  );
}

import { useRef, useEffect } from 'react';
