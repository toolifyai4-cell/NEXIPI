import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function Composer({ value, onChange, onSend, onKeyDown, disabled, placeholder }) {
    const textareaRef = useRef(null);
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [value]);
    const handleSubmit = (e) => {
        e.preventDefault();
        if (!disabled) {
            onSend();
        }
    };
    const handleAttachClick = () => {
        // Placeholder for future attachment functionality
    };
    return (_jsxs("form", { className: "nexipi-composer", onSubmit: handleSubmit, role: "form", "aria-label": "Message composer", children: [_jsxs("div", { className: "nexipi-composer-toolbar", children: [_jsx("button", { type: "button", className: "nexipi-composer-btn", onClick: handleAttachClick, "aria-label": "Add context", title: "Add context (not yet implemented)", disabled: true, children: _jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true", children: [_jsx("path", { d: "M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z" }), _jsx("polyline", { points: "15 3 15 9 21 9" }), _jsx("path", { d: "M10.5 15.5L12 17l4.5-4.5" }), _jsx("path", { d: "M15 12H3" }), _jsx("path", { d: "M15 9H3" })] }) }), _jsx("div", { className: "nexipi-composer-spacer" }), _jsx("span", { className: "nexipi-composer-hint", children: "Ctrl+Enter to send" })] }), _jsx("div", { className: "nexipi-composer-input-wrapper", children: _jsx("textarea", { ref: textareaRef, className: "nexipi-composer-input", value: value, onChange: (e) => onChange(e.target.value), onKeyDown: onKeyDown, disabled: disabled, placeholder: placeholder, "aria-label": "Message input", "aria-multiline": "true", rows: 1, spellCheck: false }) }), _jsxs("div", { className: "nexipi-composer-footer", children: [_jsx("span", { className: "nexipi-composer-status", "aria-live": "polite", children: disabled ? 'AI model not configured — Phase 04' : 'Ready' }), _jsx("button", { type: "submit", className: "nexipi-composer-send", onClick: onSend, disabled: disabled || !value.trim(), "aria-label": "Send message", title: disabled ? 'AI model not configured — coming in Phase 04' : 'Send message', children: _jsx("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": "true", children: _jsx("path", { d: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" }) }) })] })] }));
}
import { useRef, useEffect } from 'react';
