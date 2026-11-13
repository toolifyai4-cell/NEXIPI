import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ChatArea({ messages, isLoading, messagesEndRef }) {
    if (messages.length === 0) {
        return (_jsxs("div", { className: "nexipi-chat-empty", role: "status", "aria-live": "polite", children: [_jsxs("div", { className: "nexipi-empty-state", children: [_jsx("svg", { className: "nexipi-empty-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", "aria-hidden": "true", children: _jsx("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }) }), _jsx("p", { className: "nexipi-empty-text", children: "No messages yet" }), _jsx("p", { className: "nexipi-empty-hint", children: "Start a conversation or select a suggested prompt" })] }), _jsx("div", { ref: messagesEndRef })] }));
    }
    return (_jsx("div", { className: "nexipi-chat-area", role: "log", "aria-live": "polite", "aria-label": "Conversation", children: _jsxs("div", { className: "nexipi-message-list", children: [messages.map((message) => (_jsx(MessageBubble, { message: message }, message.id))), isLoading && (_jsx("div", { className: "nexipi-loading-message", role: "status", "aria-live": "polite", children: _jsxs("div", { className: "nexipi-typing-indicator", "aria-hidden": "true", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }) })), _jsx("div", { ref: messagesEndRef })] }) }));
}
function MessageBubble({ message }) {
    const timeString = message.timestamp.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
    return (_jsxs("article", { className: `nexipi-message nexipi-message--${message.role}`, role: "listitem", children: [_jsx("div", { className: "nexipi-message-avatar", "aria-hidden": "true", children: message.role === 'user' ? (_jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", children: [_jsx("path", { d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }), _jsx("circle", { cx: "12", cy: "7", r: "4" })] })) : (_jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: [_jsx("path", { d: "M12 2L2 7l10 5 10-5-10-5z" }), _jsx("path", { d: "M2 17l10 5 10-5" }), _jsx("path", { d: "M2 12l10 5 10-5" })] })) }), _jsxs("div", { className: "nexipi-message-content", children: [_jsxs("div", { className: "nexipi-message-header", children: [_jsx("span", { className: "nexipi-message-role", children: message.role === 'user' ? 'You' : 'NexiPi' }), _jsx("time", { className: "nexipi-message-time", dateTime: message.timestamp.toISOString(), children: timeString })] }), _jsx("div", { className: "nexipi-message-text", children: formatMessage(message.content) })] })] }));
}
function formatMessage(content) {
    // Simple markdown-like formatting for code blocks and inline code
    const parts = content.split(/(`[^`]+`|```[\s\S]*?```)/g);
    return parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
            const code = part.slice(3, -3).trim();
            return (_jsx("pre", { className: "nexipi-code-block", children: _jsx("code", { children: code }) }, index));
        }
        if (part.startsWith('`') && part.endsWith('`')) {
            return _jsx("code", { className: "nexipi-inline-code", children: part.slice(1, -1) }, index);
        }
        return part.split('\n').map((line, i) => (_jsxs(React.Fragment, { children: [i > 0 && _jsx("br", {}), line] }, i)));
    });
}
import React from 'react';
