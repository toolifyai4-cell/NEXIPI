import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Header, WelcomeScreen, ChatArea, Composer, StatusIndicator } from './components';
import { useChat } from './hooks/useChat';
export function App() {
    const { messages, isLoading, currentInput, setCurrentInput, viewMode, sendMessage, handleNewChat, handlePromptSelect, handleKeyDown, messagesEndRef, welcomePrompts, } = useChat();
    return (_jsxs("div", { className: "nexipi-app", children: [_jsx(Header, { onNewChat: handleNewChat, onSettings: () => { } }), _jsx("main", { className: "nexipi-main", role: "main", children: viewMode === 'welcome' ? (_jsx(WelcomeScreen, { prompts: welcomePrompts, onPromptSelect: handlePromptSelect })) : (_jsxs(_Fragment, { children: [_jsx(ChatArea, { messages: messages, isLoading: isLoading, messagesEndRef: messagesEndRef }), _jsx(Composer, { value: currentInput, onChange: setCurrentInput, onSend: sendMessage, onKeyDown: handleKeyDown, disabled: isLoading || !currentInput.trim(), placeholder: isLoading ? 'Waiting for response...' : 'Message NexiPi...' })] })) }), _jsx(StatusIndicator, { status: "disconnected", label: "AI model not configured" })] }));
}
