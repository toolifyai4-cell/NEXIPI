import { vi } from 'vitest';

const mockOutputChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  name: 'NexiPi',
};

const mockStatusBarItem = {
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  command: '',
  tooltip: '',
  text: '',
};

const mockConfiguration = {
  get: vi.fn((key: string, defaultValue?: unknown) => {
    if (key === 'nexipi.enabled') return true;
    if (key === 'nexipi.logLevel') return 'info';
    return defaultValue;
  }),
};

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
    createStatusBarItem: vi.fn(() => mockStatusBarItem),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn((_command: string, callback: (...args: unknown[]) => void) => {
      callback();
      return { dispose: vi.fn() };
    }),
    executeCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => mockConfiguration),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  StatusBarAlignment: { Right: 1 },
  ExtensionContext: vi.fn(),
}));
