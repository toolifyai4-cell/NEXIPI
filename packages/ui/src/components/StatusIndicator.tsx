interface StatusIndicatorProps {
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  label: string;
  onClick?: () => void;
}

type StatusConfig = Record<StatusIndicatorProps['status'], { color: string; label: string }>;

export function StatusIndicator({ status, label, onClick }: StatusIndicatorProps) {
  const statusConfig: StatusConfig = {
    connected: { color: 'var(--vscode-success)', label: 'Connected' },
    disconnected: { color: 'var(--vscode-muted)', label: 'Disconnected' },
    connecting: { color: 'var(--vscode-warning)', label: 'Connecting...' },
    error: { color: 'var(--vscode-error)', label: 'Error' },
  };

  const config = statusConfig[status];
  const isInteractive = typeof onClick === 'function';

  return (
    <footer className="nexipi-status" role="status" aria-live="polite">
      {isInteractive ? (
        <button
          className="nexipi-status-button"
          onClick={onClick}
          aria-label={`Model status: ${label}. Click to open settings.`}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <div
            className="nexipi-status-indicator"
            style={{ backgroundColor: config.color }}
            aria-hidden="true"
          />
          <span className="nexipi-status-label">{label}</span>
        </button>
      ) : (
        <>
          <div
            className="nexipi-status-indicator"
            style={{ backgroundColor: config.color }}
            aria-hidden="true"
          />
          <span className="nexipi-status-label">{label}</span>
        </>
      )}
    </footer>
  );
}
