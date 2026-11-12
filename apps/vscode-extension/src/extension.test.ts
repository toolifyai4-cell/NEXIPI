import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from './extension.js';

const createMockOutputChannel = () => ({
  appendLine: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  name: 'NexiPi',
});

const createMockStatusBarItem = () => ({
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  command: '',
  tooltip: '',
  text: '',
});

const createMockContext = (subscriptions: vscode.Disposable[] = []) => ({
  subscriptions,
  workspaceState: { get: vi.fn(), update: vi.fn() },
  globalState: { get: vi.fn(), update: vi.fn() },
  secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
  extensionUri: { fsPath: '' },
  extensionPath: '',
  environmentVariableCollection: {},
  asAbsolutePath: vi.fn((p: string) => p),
  storageUri: undefined,
  globalStorageUri: { fsPath: '' },
  logUri: { fsPath: '' },
  extensionMode: 1,
});

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return {
    ...actual,
    window: {
      createOutputChannel: vi.fn(() => createMockOutputChannel()),
      createStatusBarItem: vi.fn(() => createMockStatusBarItem()),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn((_, callback) => {
        callback();
        return { dispose: vi.fn() };
      }),
      executeCommand: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          if (key === 'nexipi.enabled') return true;
          if (key === 'nexipi.logLevel') return 'info';
          return defaultValue;
        }),
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    StatusBarAlignment: { Right: 1 },
    ExtensionContext: vi.fn(),
  };
});

describe('vscode-extension', () => {
  let mockContext: vscode.ExtensionContext;
  let mockOutputChannel: ReturnType<typeof createMockOutputChannel>;
  let mockStatusBarItem: ReturnType<typeof createMockStatusBarItem>;
  let subscriptions: vscode.Disposable[];

  beforeEach(() => {
    subscriptions = [];
    mockContext = createMockContext(subscriptions);
    mockOutputChannel = createMockOutputChannel();
    mockStatusBarItem = createMockStatusBarItem();

    vi.clearAllMocks();

    (vscode.window.createOutputChannel as vi.Mock).mockReturnValue(mockOutputChannel);
    (vscode.window.createStatusBarItem as vi.Mock).mockReturnValue(mockStatusBarItem);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should activate without errors', () => {
    expect(() => activate(mockContext)).not.toThrow();
  });

  it('should deactivate without errors', () => {
    activate(mockContext);
    expect(() => deactivate()).not.toThrow();
  });

  it('should create output channel on activation', () => {
    activate(mockContext);
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('NexiPi');
    expect(mockOutputChannel.appendLine).toHaveBeenCalled();
  });

  it('should create status bar item on activation', () => {
    activate(mockContext);
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    expect(mockStatusBarItem.show).toHaveBeenCalled();
    expect(mockStatusBarItem.command).toBe('nexipi.showOutput');
  });

  it('should register all three commands', () => {
    activate(mockContext);
    const registerCalls = (vscode.commands.registerCommand as vi.Mock).mock.calls;
    const commands = registerCalls.map((call: unknown[]) => call[0] as string);
    expect(commands).toContain('nexipi.start');
    expect(commands).toContain('nexipi.showOutput');
    expect(commands).toContain('nexipi.showInformation');
  });

  it('should push disposables to context subscriptions', () => {
    activate(mockContext);
    expect(mockContext.subscriptions.length).toBeGreaterThan(0);
  });

  describe('nexipi.start command', () => {
    it('should update status bar to active when successful', () => {
      activate(mockContext);
      const startCall = (vscode.commands.registerCommand as vi.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === 'nexipi.start'
      );
      expect(startCall).toBeDefined();

      const callback = startCall![1] as Function;
      callback();

      expect(mockStatusBarItem.text).toContain('NexiPi: Active');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'NexiPi started successfully'
      );
    });
  });

  describe('nexipi.showOutput command', () => {
    it('should show output channel', () => {
      activate(mockContext);
      const showOutputCall = (vscode.commands.registerCommand as vi.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === 'nexipi.showOutput'
      );
      expect(showOutputCall).toBeDefined();

      const callback = showOutputCall![1] as Function;
      callback();

      expect(mockOutputChannel.show).toHaveBeenCalled();
    });
  });

  describe('nexipi.showInformation command', () => {
    it('should show information message', () => {
      activate(mockContext);
      const showInfoCall = (vscode.commands.registerCommand as vi.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === 'nexipi.showInformation'
      );
      expect(showInfoCall).toBeDefined();

      const callback = showInfoCall![1] as Function;
      callback();

      expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    });
  });
});
