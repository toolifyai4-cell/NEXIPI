import { Header, WelcomeScreen, ChatArea, Composer, StatusIndicator } from './components';
import { useChat } from './hooks/useChat';

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
          <WelcomeScreen prompts={welcomePrompts} onPromptSelect={handlePromptSelect} />
        ) : (
          <>
            <ChatArea messages={messages} isLoading={isLoading} messagesEndRef={messagesEndRef} />
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
      <StatusIndicator status="disconnected" label="AI model not configured" />
    </div>
  );
}
