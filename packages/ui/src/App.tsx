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
    handleOpenSettings,
    handleKeyDown,
    messagesEndRef,
    welcomePrompts,
  } = useChat();

  return (
    <div className="nexipi-app">
      <Header onNewChat={handleNewChat} onSettings={handleOpenSettings} />
      <main className="nexipi-main" role="main">
        <div
          className="nexipi-content"
          role="region"
          aria-label={viewMode === 'welcome' ? 'Welcome' : 'Conversation'}
        >
          {viewMode === 'welcome' ? (
            <WelcomeScreen prompts={welcomePrompts} onPromptSelect={handlePromptSelect} />
          ) : (
            <ChatArea messages={messages} isLoading={isLoading} messagesEndRef={messagesEndRef} />
          )}
        </div>
        <Composer
          value={currentInput}
          onChange={setCurrentInput}
          onSend={sendMessage}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          placeholder={isLoading ? 'Waiting for response...' : 'Message NexiPi...'}
        />
      </main>
      <StatusIndicator
        status="disconnected"
        label="AI model not configured"
        onClick={handleOpenSettings}
        reason="model_status_click"
      />
    </div>
  );
}
