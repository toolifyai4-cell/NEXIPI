import * as vscode from 'vscode';
import { defaultConfig } from '@nexipi/core';
import type { Logger, LogLevel } from '@nexipi/shared';
import { ChatService, createChatService } from '@nexipi/models';
import { createProviderRegistry } from '@nexipi/models';
import type { StreamEvent, Message, ConversationId, MessageId } from '@nexipi/shared';

interface NexiPiContext {
  outputChannel: vscode.OutputChannel;
  statusBarItem: vscode.StatusBarItem;
  logger: Logger;
  disposables: vscode.Disposable[];
  chatService: ChatService;
}

function createLogger(outputChannel: vscode.OutputChannel, level: LogLevel): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (messageLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (levels[messageLevel] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      outputChannel.appendLine(
        `[${timestamp}] [${messageLevel.toUpperCase()}] ${message}${metaStr}`
      );
    }
  };

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  };
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'nexipi.showOutput';
  item.tooltip = 'Click to open NexiPi output channel';
  item.text = '$(plug) NexiPi: Initializing...';
  item.show();
  return item;
}

function updateStatusBar(
  statusBarItem: vscode.StatusBarItem,
  status: 'initializing' | 'active' | 'error',
  message?: string
): void {
  const icons = { initializing: '$(loading~spin)', active: '$(plug)', error: '$(error)' };
  const texts = {
    initializing: 'NexiPi: Initializing...',
    active: 'NexiPi: Active',
    error: 'NexiPi: Error',
  };
  statusBarItem.text = `${icons[status]} ${texts[status]}${message ? ` - ${message}` : ''}`;
}

class NexiPiSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nexipi.sidebar';
  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;
  private readonly _logger: Logger;
  private readonly _chatService: ChatService;

  constructor(extensionUri: vscode.Uri, logger: Logger, chatService: ChatService) {
    this._extensionUri = extensionUri;
    this._logger = logger;
    this._chatService = chatService;
    this._setupChatServiceListeners();
  }

  private _setupChatServiceListeners(): void {
    this._chatService.on('stream:event', ({ event, timestamp }) => {
      this._sendStreamEvent(event);
    });

    this._chatService.on('message:created', ({ message, timestamp }) => {
      this._sendMessageCreated(message);
    });

    this._chatService.on('message:updated', ({ message, timestamp }) => {
      this._sendMessageUpdated(message);
    });

    this._chatService.on('conversation:created', ({ conversation, timestamp }) => {
      this._logger.debug('Conversation created', { conversationId: conversation.id });
    });

    this._chatService.on('chat:error', ({ error, conversationId, messageId, timestamp }) => {
      this._logger.error('Chat error', { conversationId, messageId, error: error.message });
    });
  }

  private _sendStreamEvent(event: StreamEvent): void {
    this._view?.webview.postMessage({
      type: 'streamEvent',
      payload: { event },
    });
  }

  private _sendMessageCreated(message: Message): void {
    this._view?.webview.postMessage({
      type: 'messageCreated',
      payload: { message },
    });
  }

  private _sendMessageUpdated(message: Message): void {
    this._view?.webview.postMessage({
      type: 'messageUpdated',
      payload: { message },
    });
  }

  private _sendInitialState(): void {
    const modelConfigured = false;

    this._view?.webview.postMessage({
      type: 'state',
      payload: {
        messages: [],
        currentInput: '',
        viewMode: 'welcome',
        isLoading: false,
        modelConfigured,
        conversationId: null,
      },
    });
    this._logger.debug('Sent initial state to webview', { modelConfigured });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => this._onMessage(message), undefined, []);

    this._logger.info('Sidebar webview resolved');
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.js'))
      .toString();
    const styleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.css'))
      .toString();

    this._logger.debug('Webview resource URIs', { scriptUri, styleUri });

    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" nonce="${nonce}">
  <title>NexiPi</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private _onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const msg = message as { type: string; payload?: unknown };

    (async () => {
      switch (msg.type) {
        case 'ready':
          this._logger.debug('Webview ready');
          this._sendInitialState();
          break;
        case 'sendMessage': {
          this._logger.info('Message from webview', { payload: msg.payload });
          const payload = msg.payload as { content: string; conversationId?: string } | undefined;
          if (!payload?.content) {
            this._logger.warn('sendMessage: missing content');
            return;
          }

          let conversationId = payload.conversationId as ConversationId | undefined;
          if (!conversationId) {
            const conversation = this._chatService.createConversation();
            conversationId = conversation.id;
          }

          try {
            await this._chatService.sendMessage(conversationId!, payload.content);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._logger.error('Failed to send message', { error: err.message });
            this._view?.webview.postMessage({
              type: 'error',
              payload: { message: err.message },
            });
          }
          break;
        }
        case 'newChat': {
          this._logger.info('New chat requested from webview');
          const conversation = this._chatService.createConversation();
          this._view?.webview.postMessage({
            type: 'state',
            payload: {
              messages: [],
              currentInput: '',
              viewMode: 'welcome',
              isLoading: false,
              modelConfigured: false,
              conversationId: conversation.id,
            },
          });
          break;
        }
        case 'promptSelected': {
          this._logger.debug('Prompt selected from webview', { payload: msg.payload });
          break;
        }
        case 'openSettings': {
          this._logger.info('Open settings requested from webview', { payload: msg.payload });
          try {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:nexipi.nexipi'
            );
            this._logger.info('Settings opened successfully');
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._logger.error('Failed to open settings', { error: err.message });
          }
          this._view?.webview.postMessage({
            type: 'settingsOpened',
            payload: { timestamp: new Date().toISOString() },
          });
          break;
        }
        case 'cancelMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('cancelMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Cancel message requested', { messageId: payload.messageId });
          this._chatService.cancelMessage(payload.messageId);
          break;
        }
        case 'retryMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('retryMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Retry message requested', { messageId: payload.messageId });
          this._chatService.retryMessage(payload.conversationId, payload.messageId);
          break;
        }
        default:
          this._logger.warn('Unknown message type from webview', { type: msg.type });
      }
    })();
  }

  public postMessage(message: unknown): void {
    void this._view?.webview.postMessage(message);
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  nexipiContext: NexiPiContext,
  config: vscode.WorkspaceConfiguration,
  _sidebarProvider: NexiPiSidebarProvider
): vscode.Disposable[] {
  const { outputChannel, statusBarItem, logger } = nexipiContext;
  const disposables: vscode.Disposable[] = [];

  const startDisposable = vscode.commands.registerCommand('nexipi.start', async () => {
    logger.info('Command executed: nexipi.start');
    updateStatusBar(statusBarItem, 'initializing');

    try {
      const enabled = config.get<boolean>('nexipi.enabled', true);
      if (!enabled) {
        logger.warn('NexiPi is disabled via configuration');
        void vscode.window.showWarningMessage(
          'NexiPi is disabled. Enable it in settings to start.'
        );
        updateStatusBar(statusBarItem, 'error', 'Disabled');
        return;
      }

      logger.info('Starting NexiPi...');
      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('NexiPi started successfully');
      updateStatusBar(statusBarItem, 'active');
      void vscode.window.showInformationMessage('NexiPi started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to start NexiPi', { error: err.message });
      updateStatusBar(statusBarItem, 'error', err.message);
      void vscode.window.showErrorMessage(`Failed to start NexiPi: ${err.message}`);
    }
  });

  const showOutputDisposable = vscode.commands.registerCommand('nexipi.showOutput', () => {
    logger.info('Command executed: nexipi.showOutput');
    outputChannel.show();
  });

  const showInformationDisposable = vscode.commands.registerCommand(
    'nexipi.showInformation',
    () => {
      logger.info('Command executed: nexipi.showInformation');
      const info = [
        `NexiPi v${defaultConfig.version}`,
        'Extensible AI coding agent for VS Code',
        '',
        'Commands:',
        '  nexipi.start - Initialize and start NexiPi',
        '  nexipi.showOutput - Show the output channel',
        '  nexipi.showInformation - Show this information',
        '  nexipi.focusSidebar - Focus the NexiPi sidebar',
      ].join('\n');
      void vscode.window.showInformationMessage(info, { modal: true });
    }
  );

  const focusSidebarDisposable = vscode.commands.registerCommand('nexipi.focusSidebar', () => {
    logger.info('Command executed: nexipi.focusSidebar');
    void vscode.commands.executeCommand('workbench.view.extension.nexipi');
  });

  disposables.push(
    startDisposable,
    showOutputDisposable,
    showInformationDisposable,
    focusSidebarDisposable
  );
  return disposables;
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('nexipi');
  const logLevel = config.get<LogLevel>('nexipi.logLevel', 'info');

  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  const logger = createLogger(outputChannel, logLevel);
  const statusBarItem = createStatusBarItem();

  logger.info(`Extension activating v${defaultConfig.version}`);
  outputChannel.appendLine(
    `[${new Date().toISOString()}] [INFO] NexiPi extension activating v${defaultConfig.version}`
  );

  const providerRegistry = createProviderRegistry();
  const chatService = createChatService({
    providerRegistry,
    logger,
  });

  const sidebarProvider = new NexiPiSidebarProvider(context.extensionUri, logger, chatService);

  const nexipiContext: NexiPiContext = {
    outputChannel,
    statusBarItem,
    logger,
    disposables: [],
    chatService,
  };

  const sidebarDisposable = vscode.window.registerWebviewViewProvider(
    NexiPiSidebarProvider.viewType,
    sidebarProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  const commandDisposables = registerCommands(context, nexipiContext, config, sidebarProvider);
  nexipiContext.disposables.push(...commandDisposables);

  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('nexipi')) {
      const newConfig = vscode.workspace.getConfiguration('nexipi');
      const newLogLevel = newConfig.get<LogLevel>('nexipi.logLevel', 'info');
      logger.info('Configuration changed', { logLevel: newLogLevel });
    }
  });
  nexipiContext.disposables.push(configChangeDisposable);

  nexipiContext.disposables.push(
    outputChannel,
    statusBarItem,
    sidebarDisposable,
    ...commandDisposables
  );

  context.subscriptions.push(...nexipiContext.disposables);

  // Dispose chat service on deactivation
  context.subscriptions.push({
    dispose: async () => {
      await chatService.dispose();
    },
  });

  logger.info('Extension activated successfully');
  updateStatusBar(statusBarItem, 'active');
}

export function deactivate(): void {
  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  outputChannel.appendLine(`[${new Date().toISOString()}] [INFO] NexiPi extension deactivated`);
  outputChannel.dispose();
}