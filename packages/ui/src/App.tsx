import { Header, WelcomeScreen, ChatArea, Composer, StatusIndicator } from './components';
import { useChat } from './hooks/useChat';

export function App() {
  const {
    messages,
    isLoading,
    currentInput,
    setCurrentInput,
    viewMode,
    modelConfigured,
    sendMessage,
    handleNewChat,
    handlePromptSelect,
    handleOpenSettings,
    handleKeyDown,
    messagesEndRef,
    welcomePrompts,
  } = useChat();

  const composerDisabled = isLoading || !modelConfigured;

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
          disabled={composerDisabled}
          placeholder={
            isLoading
              ? 'Waiting for response...'
              : modelConfigured
                ? 'Message NexiPi...'
                : 'Configure an AI model to start chatting'
          }
        />
      </main>
      <StatusIndicator
        status={modelConfigured ? 'connected' : 'disconnected'}
        label={modelConfigured ? 'AI model configured' : 'AI model not configured'}
        onClick={handleOpenSettings}
        reason="model_status_click"
      />
    </div>
  );
}
