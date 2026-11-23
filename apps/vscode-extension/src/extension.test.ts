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
    workspaceFolders: [],
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Uri: {
    joinPath: vi.fn((base: unknown, ...paths: string[]) => {
      let basePath: string;
      if (typeof base === 'string') {
        basePath = base;
      } else if (base && typeof base === 'object' && 'fsPath' in base) {
        basePath = (base as { fsPath: string }).fsPath;
      } else {
        basePath = '';
      }
      const fullPath = [basePath, ...paths].join('/').replace(/\/+/g, '/');
      return {
        toString: () => `file://${fullPath}`,
        fsPath: fullPath,
      };
    }),
    file: vi.fn((path: string) => ({
      fsPath: path,
    })),
  },
  ViewColumn: {},
  WebviewViewProvider: vi.fn(),
  ExtensionContext: {
    subscriptions: [],
    globalStorageUri: { fsPath: '/tmp/globalStorage' },
    extensionPath: 'C:/DNET/NEXIPI/apps/vscode-extension',
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

  it('should export activate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.activate).toBe('function');
  }, 10000);

  it('should export deactivate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.deactivate).toBe('function');
  }, 10000);

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
    let mockContext: { 
      extensionUri: { toString: () => string }; 
      subscriptions: unknown[];
      globalStorageUri: { fsPath: string };
      extensionPath: string;
    };
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
        globalStorageUri: { fsPath: '/tmp/globalStorage' },
        extensionPath: 'C:/DNET/NEXIPI/apps/vscode-extension',
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
        onDidDispose: vi.fn(),
      };
    });

    it('should handle openSettings message and execute workbench.action.openSettings command', async () => {
      await extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

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
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        '@ext:nexipi.nexipi'
      );
    });

    it('should handle openSettings message with model_status_click reason', async () => {
      await extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

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

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        '@ext:nexipi.nexipi'
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

    it('should handle sendMessage and send messageCreated/messageUpdated events', async () => {
      await extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

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

      // Wait for async message processing
      await new Promise(resolve => setTimeout(resolve, 50));

      const calls = mockWebviewView.webview.postMessage.mock.calls;
      // Should send messageCreated for user message
      expect(
        calls.some(
          call => call[0].type === 'messageCreated' && call[0].payload.message.role === 'user'
        )
      ).toBe(true);
      // Should send messageCreated for assistant message
      expect(
        calls.some(
          call => call[0].type === 'messageCreated' && call[0].payload.message.role === 'assistant'
        )
      ).toBe(true);
      // Should send messageUpdated for assistant status changes
      expect(calls.some(call => call[0].type === 'messageUpdated')).toBe(true);
    });

    it('should handle newChat message and send state update', async () => {
      await extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

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

      // Should send state update with welcome view mode
      expect(mockWebviewView.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state',
          payload: expect.objectContaining({
            viewMode: 'welcome',
            messages: [],
            currentInput: '',
            isLoading: false,
          }),
        })
      );
    });

    it('should send initial state on ready message', async () => {
      await extensionModule.activate(mockContext as unknown as vscode.ExtensionContext);

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
            modelConfigured: false,
            viewMode: 'welcome',
            isLoading: false,
          }),
        })
      );
    });
  });
