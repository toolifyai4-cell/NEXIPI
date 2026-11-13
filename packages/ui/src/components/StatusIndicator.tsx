interface StatusIndicatorProps {
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  label: string;
}

export function StatusIndicator({ status, label }: StatusIndicatorProps) {
  const statusConfig = {
    connected: { color: 'var(--vscode-success)', label: 'Connected' },
    disconnected: { color: 'var(--vscode-muted)', label: 'Disconnected' },
    connecting: { color: 'var(--vscode-warning)', label: 'Connecting...' },
    error: { color: 'var(--vscode-error)', label: 'Error' },
  };

  const config = statusConfig[status];

  return (
    <footer className="nexipi-status" role="status" aria-live="polite">
      <div
        className="nexipi-status-indicator"
        style={{ backgroundColor: config.color }}
        aria-hidden="true"
      />
      <span className="nexipi-status-label">{label}</span>
    </footer>
  );
}
