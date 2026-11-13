import { Header } from './Header';
import { WelcomeScreen } from './WelcomeScreen';
import { ChatArea } from './ChatArea';
import { Composer } from './Composer';
import { StatusIndicator } from './StatusIndicator';
import { useChat } from '../hooks/useChat';
import type { WebviewMessage } from '../types';

export function App() {
  const {
    messages,
    isLoading,
    currentInput,
    setCurrentInput,
    viewMode,
    sendMessage,
    handleNewChat,
    handlePromptSelect,
    handleKeyDown,
    messagesEndRef,
    welcomePrompts,
  } = useChat();

  return (
    <div className="nexipi-app">
      <Header onNewChat={handleNewChat} onSettings={() => {}} />
      <main className="nexipi-main" role="main">
        {viewMode === 'welcome' ? (
          <WelcomeScreen
            prompts={welcomePrompts}
            onPromptSelect={handlePromptSelect}
            onNewChat={handleNewChat}
          />
        ) : (
          <>
            <ChatArea
              messages={messages}
              isLoading={isLoading}
              messagesEndRef={messagesEndRef}
            />
            <Composer
              value={currentInput}
              onChange={setCurrentInput}
              onSend={sendMessage}
              onKeyDown={handleKeyDown}
              disabled={isLoading || !currentInput.trim()}
              placeholder={isLoading ? 'Waiting for response...' : 'Message NexiPi...'}
            />
          </>
        )}
      </main>
      <StatusIndicator
        status="disconnected"
        label="AI model not configured"
      />
    </div>
  );
}