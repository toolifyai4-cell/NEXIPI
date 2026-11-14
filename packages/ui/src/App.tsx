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
    handleCancelMessage,
    handleRetryMessage,
    messagesEndRef,
    welcomePrompts,
  } = useChat();

  const handleCancel = () => {
    // Find the active streaming message and cancel it
    const activeMessage = messages.find(
      m => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending')
    );
    if (activeMessage) {
      handleCancelMessage(activeMessage.id);
    }
  };

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
            <ChatArea
              messages={messages}
              isLoading={isLoading}
              messagesEndRef={messagesEndRef}
              onCancelMessage={handleCancelMessage}
              onRetryMessage={handleRetryMessage}
            />
          )}
        </div>
        <Composer
          value={currentInput}
          onChange={setCurrentInput}
          onSend={sendMessage}
          onKeyDown={handleKeyDown}
          isLoading={isLoading}
          modelConfigured={modelConfigured}
          onCancel={handleCancel}
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
