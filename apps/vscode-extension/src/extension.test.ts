import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

// Mock vscode module
vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    createStatusBarItem: vi.fn(() => ({
      text: '',
      tooltip: '',
      command: '',
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    registerWebviewViewProvider: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => {
        if (key === 'nexipi.enabled') return true;
        if (key === 'nexipi.logLevel') return 'info';
        return defaultValue;
      }),
    })),
    onDidChangeConfiguration: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Uri: {
    joinPath: vi.fn((base: unknown, ...paths: string[]) => ({
      toString: () => `file://${base}/${paths.join('/')}`,
    })),
  },
  ViewColumn: {},
  WebviewViewProvider: vi.fn(),
  ExtensionContext: {
    subscriptions: [],
  },
  StatusBarAlignment: { Right: 1 },
  CancellationToken: {},
  WebviewViewResolveContext: {},
  Webview: {
    asWebviewUri: vi.fn((uri: unknown) => ({
      toString: () => `vscode-webview://${uri}`,
    })),
  },
}));

describe('vscode-extension', () => {
  let mockOutputChannel: ReturnType<typeof vscode.window.createOutputChannel>;
  let mockStatusBarItem: ReturnType<typeof vscode.window.createStatusBarItem>;
  let mockExecuteCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutputChannel = vscode.window.createOutputChannel();
    mockStatusBarItem = vscode.window.createStatusBarItem();
    mockExecuteCommand = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
  });

  it('should export activate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.activate).toBe('function');
  });

  it('should export deactivate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.deactivate).toBe('function');
  });

  it('should have correct extension metadata in package.json', async () => {
    const pkg = await import('../package.json', { assert: { type: 'json' } });
    expect(pkg.default.name).toBe('nexipi');
    expect(pkg.default.displayName).toBe('NexiPi');
    expect(pkg.default.main).toBe('./dist/extension.js');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.start');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.showOutput');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.showInformation');
    expect(pkg.default.contributes.commands).toHaveLength(4);
    expect(pkg.default.contributes.configuration.properties).toHaveProperty('nexipi.enabled');
    expect(pkg.default.contributes.configuration.properties).toHaveProperty('nexipi.logLevel');
  });

  it('should have debugging configuration', async () => {
    const launchConfig = await import('../../../.vscode/launch.json', { assert: { type: 'json' } });
    expect(launchConfig.default.configurations).toHaveLength(2);
    expect(launchConfig.default.configurations[0].name).toBe('Run Extension');
    expect(launchConfig.default.configurations[0].type).toBe('extensionHost');
  });

  it('should have build task configuration', async () => {
    const tasksConfig = await import('../../../.vscode/tasks.json', { assert: { type: 'json' } });
    expect(tasksConfig.default.tasks).toHaveLength(1);
    expect(tasksConfig.default.tasks[0].label).toBe('npm: build - apps/vscode-extension');
  });

  describe('NexiPiSidebarProvider message handling', () => {
    let extensionModule: { activate: (context: unknown) => void };
    let mockContext: { extensionUri: { toString: () => string }; subscriptions: unknown[] };
    let mockWebviewView: {
      webview: {
        onDidReceiveMessage: (handler: (msg: unknown) => void) => void;
        postMessage: ReturnType<typeof vi.fn>;
        options: unknown;
        html: string;
      };
    };

    beforeEach(async () => {
      extensionModule = await import('./extension.js');
      mockContext = {
        extensionUri: { toString: () => 'file:///test' },
        subscriptions: [],
      };
      mockWebviewView = {
        webview: {
          onDidReceiveMessage: vi.fn(),
          postMessage: vi.fn(),
          options: {},
          html: '',
          asWebviewUri: vi.fn((uri: unknown) => ({
            toString: () => `vscode-webview://${uri}`,
          })),
        },
      };
    });

    it('should handle openSettings message and execute workbench.action.openSettings command', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      // Get the registered provider
      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      // Simulate resolveWebviewView
      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      // Get the message handler
      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      // Send openSettings message
      messageHandler({ type: 'openSettings', payload: { reason: 'user_click' } });

      // Verify command was executed with correct arguments
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        '@ext:nexipi'
      );
    });

    it('should handle openSettings message with model_status_click reason', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      messageHandler({ type: 'openSettings', payload: { reason: 'model_status_click' } });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        '@ext:nexipi'
      );
    });

    it('should send settingsOpened response after handling openSettings', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      messageHandler({ type: 'openSettings', payload: { reason: 'user_click' } });

      // Wait for async handler to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'settingsOpened',
          payload: expect.objectContaining({ timestamp: expect.any(String) }),
        })
      );
    });

    it('should handle sendMessage and respond with info message', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      messageHandler({ type: 'sendMessage', payload: { content: 'test message' } });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          payload: expect.objectContaining({
            message: expect.stringContaining('Message received'),
          }),
        })
      );
    });

    it('should handle newChat message and respond with chatCleared', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      messageHandler({ type: 'newChat', payload: { timestamp: '2024-01-01T00:00:00.000Z' } });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chatCleared',
          payload: expect.objectContaining({ timestamp: expect.any(String) }),
        })
      );
    });

    it('should send initial state on ready message', async () => {
      extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

      const registerCall = (vscode.window.registerWebviewViewProvider as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const provider = registerCall[1];

      provider.resolveWebviewView(
        mockWebviewView as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );

      const messageHandler = (
        mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][0];

      messageHandler({ type: 'ready' });

      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state',
          payload: expect.objectContaining({
            modelConfigured: true,
            viewMode: 'welcome',
            isLoading: false,
          }),
        })
      );
    });
  });
});
