import { useMemo } from 'react';
import type { WelcomePrompt } from '../hooks/useChat';

interface WelcomeScreenProps {
  prompts: WelcomePrompt[];
  onPromptSelect: (prompt: string) => void;
  onNewChat: () => void;
}

export function WelcomeScreen({ prompts, onPromptSelect, onNewChat }: WelcomeScreenProps) {
  const promptGroups = useMemo(() => {
    const groups = {
      'Get started': prompts.slice(0, 2),
      'Code tasks': prompts.slice(2),
    };
    return groups;
  }, [prompts]);

  return (
    <div className="nexipi-welcome" role="region" aria-label="Welcome">
      <div className="nexipi-welcome-content">
        <div className="nexipi-welcome-brand" aria-hidden="true">
          <svg className="nexipi-logo-large" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <h1 className="nexipi-welcome-title">Welcome to NexiPi</h1>
        <p className="nexipi-welcome-description">
          An extensible AI coding agent for Visual Studio Code.
          NexiPi helps you understand, write, and improve code through natural conversation.
        </p>
        <div className="nexipi-welcome-prompts">
          {Object.entries(promptGroups).map(([groupTitle, groupPrompts]) => (
            <div key={groupTitle} className="nexipi-prompt-group">
              <h2 className="nexipi-prompt-group-title">{groupTitle}</h2>
              <div className="nexipi-prompt-list" role="list">
                {groupPrompts.map((prompt, index) => (
                  <button
                    key={prompt.label}
                    className="nexipi-prompt-card"
                    role="listitem"
                    onClick={() => onPromptSelect(prompt.prompt)}
                    aria-label={`Try: ${prompt.label}`}
                  >
                    <span className="nexipi-prompt-label">{prompt.label}</span>
                    <span className="nexipi-prompt-preview">{prompt.prompt}</span>
                    <svg className="nexipi-prompt-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="nexipi-welcome-footer">
          <kbd>Ctrl+Enter</kbd> to send · <kbd>Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  );
}