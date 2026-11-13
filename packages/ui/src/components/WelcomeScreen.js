import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
export function WelcomeScreen({ prompts, onPromptSelect }) {
    const promptGroups = useMemo(() => {
        const groups = {
            'Get started': prompts.slice(0, 2),
            'Code tasks': prompts.slice(2),
        };
        return groups;
    }, [prompts]);
    return (_jsx("div", { className: "nexipi-welcome", role: "region", "aria-label": "Welcome", children: _jsxs("div", { className: "nexipi-welcome-content", children: [_jsx("div", { className: "nexipi-welcome-brand", "aria-hidden": "true", children: _jsxs("svg", { className: "nexipi-logo-large", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: [_jsx("path", { d: "M12 2L2 7l10 5 10-5-10-5z" }), _jsx("path", { d: "M2 17l10 5 10-5" }), _jsx("path", { d: "M2 12l10 5 10-5" })] }) }), _jsx("h1", { className: "nexipi-welcome-title", children: "Welcome to NexiPi" }), _jsx("p", { className: "nexipi-welcome-description", children: "An extensible AI coding agent for Visual Studio Code. NexiPi helps you understand, write, and improve code through natural conversation." }), _jsx("div", { className: "nexipi-welcome-prompts", children: Object.entries(promptGroups).map(([groupTitle, groupPrompts]) => (_jsxs("div", { className: "nexipi-prompt-group", children: [_jsx("h2", { className: "nexipi-prompt-group-title", children: groupTitle }), _jsx("div", { className: "nexipi-prompt-list", role: "list", children: groupPrompts.map((prompt) => (_jsxs("button", { className: "nexipi-prompt-card", role: "listitem", onClick: () => onPromptSelect(prompt.prompt), "aria-label": `Try: ${prompt.label}`, children: [_jsx("span", { className: "nexipi-prompt-label", children: prompt.label }), _jsx("span", { className: "nexipi-prompt-preview", children: prompt.prompt }), _jsx("svg", { className: "nexipi-prompt-arrow", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true", children: _jsx("path", { d: "M5 12h14M12 5l7 7-7 7" }) })] }, prompt.label))) })] }, groupTitle))) }), _jsxs("p", { className: "nexipi-welcome-footer", children: [_jsx("kbd", { children: "Ctrl+Enter" }), " to send \u00B7 ", _jsx("kbd", { children: "Shift+Enter" }), " for new line"] })] }) }));
}
