import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StatusIndicator({ status, label }) {
    const statusConfig = {
        connected: { color: 'var(--vscode-success)', label: 'Connected' },
        disconnected: { color: 'var(--vscode-muted)', label: 'Disconnected' },
        connecting: { color: 'var(--vscode-warning)', label: 'Connecting...' },
        error: { color: 'var(--vscode-error)', label: 'Error' },
    };
    const config = statusConfig[status];
    return (_jsxs("footer", { className: "nexipi-status", role: "status", "aria-live": "polite", children: [_jsx("div", { className: "nexipi-status-indicator", style: { backgroundColor: config.color }, "aria-hidden": "true" }), _jsx("span", { className: "nexipi-status-label", children: label })] }));
}
