import * as vscode from 'vscode';
import * as path from 'path';
import { defaultConfig } from '@nexipi/core';
import type { Logger, LogLevel } from '@nexipi/shared';
import type { ChatService } from '@nexipi/models';
import { createChatService } from '@nexipi/models';
import { createProviderRegistry } from '@nexipi/models';
import type { StreamEvent, Message, ConversationId, MessageId } from '@nexipi/shared';
import { PersistenceFoundation } from '@nexipi/persistence';
import type { PersistencePortService } from '@nexipi/persistence';
import { createPersistenceService, SqlJsConversationRepository, SqlJsMessageRepository } from '@nexipi/persistence';
import { createPersistenceAdapter } from '@nexipi/models';
import { WorkspaceManager } from './workspace/workspace-manager.js';
import { VSCodeWorkspaceProvider } from './workspace/vscode-workspace-provider.js';
import { VSCodeFileSystemProvider } from './workspace/vscode-file-system-provider.js';
import { createToolRegistry, type ToolRegistry } from '@nexipi/models/tools';
import { ToolExecutor } from '@nexipi/models/tools';
import { ToolExecutionService, type ToolExecutionServiceConfig } from '@nexipi/models/tools';
import {
  createReadFileToolDefinition,
  createListDirectoryToolDefinition,
  createSearchCodeToolDefinition,
  createFindReferencesToolDefinition,
} from '@nexipi/workspace/tools';
import type { WorkspaceFolder } from '@nexipi/workspace';
import { createReadOnlyWorkspacePermissionPolicy } from './tools/permission-policy.js';

interface NexiPiContext {
  outputChannel: vscode.OutputChannel;
  statusBarItem: vscode.StatusBarItem;
  logger: Logger;
  disposables: vscode.Disposable[];
  chatService: ChatService;
  persistenceService?: PersistencePortService;
  toolRegistry: ToolRegistry;
  toolExecutionService: ToolExecutionService;
}

// Module-level variables for access in deactivate()
let gChatService: ChatService | undefined;
let gPersistenceService: PersistencePortService | undefined;
let gPersistenceAdapter: { dispose: () => void } | undefined;
let gLogger: Logger | undefined;
let gWorkspaceManager: WorkspaceManager | undefined;
let gToolRegistry: ToolRegistry | undefined;
let gToolExecutionService: ToolExecutionService | undefined;

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
  private _view: vscode.WebviewView | undefined;
  private readonly _extensionUri: vscode.Uri;
  private readonly _logger: Logger;
  private readonly _chatService: ChatService;
  private _isDisposed = false;

  constructor(extensionUri: vscode.Uri, logger: Logger, chatService: ChatService) {
    this._extensionUri = extensionUri;
    this._logger = logger;
    this._chatService = chatService;
    this._setupChatServiceListeners();
  }

  /** Check if the webview is disposed */
  isDisposed(): boolean {
    return this._isDisposed;
  }

  private _setupChatServiceListeners(): void {
    this._chatService.on('stream:event', ({ event, timestamp: _timestamp }) => {
      this._sendStreamEvent(event);
    });

    this._chatService.on('message:created', ({ message, timestamp: _timestamp }) => {
      this._sendMessageCreated(message);
    });

    this._chatService.on('message:updated', ({ message, timestamp: _timestamp }) => {
      this._sendMessageUpdated(message);
    });

    this._chatService.on('conversation:created', ({ conversation, timestamp: _timestamp }) => {
      this._logger.debug('Conversation created', { conversationId: conversation.id });
    });

    this._chatService.on(
      'chat:error',
      ({ error, conversationId, messageId, timestamp: _timestamp }) => {
        this._logger.error('Chat error', { conversationId, messageId, error: error.message });
      }
    );
  }

  private _sendStreamEvent(event: StreamEvent): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping stream event - webview disposed or not available', {
        eventType: event.type,
      });
      return;
    }
    void this._view.webview.postMessage({
      type: 'streamEvent',
      payload: { event },
    });
  }

  private _sendMessageCreated(message: Message): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping messageCreated - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage({
      type: 'messageCreated',
      payload: { message },
    });
  }

  private _sendMessageUpdated(message: Message): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping messageUpdated - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage({
      type: 'messageUpdated',
      payload: { message },
    });
  }

  private _sendInitialState(): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping initial state - webview disposed or not available');
      return;
    }
    const modelConfigured = false;

    void this._view.webview.postMessage({
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
    this._isDisposed = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => this._onMessage(message), undefined, []);

    // Handle webview disposal
    webviewView.onDidDispose(() => {
      this._logger.info('Webview disposed');
      this._isDisposed = true;
      this._view = undefined;
      // Cancel any active streams for this webview
      // Note: We don't dispose the chat service here as it's shared
    });

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

    void (async () => {
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

          let conversationId = payload.conversationId;
          if (!conversationId) {
            const conversation = this._chatService.createConversation();
            conversationId = conversation.id;
          }

          try {
            await this._chatService.sendMessage(conversationId as ConversationId, payload.content);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._logger.error('Failed to send message', { error: err.message });
            void this._view?.webview.postMessage({
              type: 'error',
              payload: { message: err.message },
            });
          }
          break;
        }
        case 'newChat': {
          this._logger.info('New chat requested from webview');
          const conversation = this._chatService.createConversation();
          if (!this._isDisposed && this._view) {
            void this._view.webview.postMessage({
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
          }
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
          if (!this._isDisposed && this._view) {
            void this._view.webview.postMessage({
              type: 'settingsOpened',
              payload: { timestamp: new Date().toISOString() },
            });
          }
          break;
        }
        case 'cancelMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('cancelMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Cancel message requested', { messageId: payload.messageId });
          this._chatService.cancelMessage(payload.messageId as MessageId);
          break;
        }
        case 'retryMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('retryMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Retry message requested', { messageId: payload.messageId });
          void this._chatService.retryMessage(
            payload.conversationId as ConversationId,
            payload.messageId as MessageId
          );
          break;
        }
        default:
          this._logger.warn('Unknown message type from webview', { type: msg.type });
      }
    })();
  }

  public postMessage(message: unknown): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping postMessage - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage(message);
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

async function initializePersistence(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<PersistencePortService> {
  // Use globalStorageUri for application-wide data persistence
  const storagePath = context.globalStorageUri.fsPath;
  const dbPath = path.join(storagePath, 'nexipi.db');

  logger.info('Initializing persistence', { storagePath, dbPath });

  // Ensure storage directory exists
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(storagePath));
  } catch {
    // Directory may already exist
  }

  // Create locateFile function to resolve WASM file location
  const extensionPath = context.extensionPath;
  const locateFile = (file: string): string => {
    if (file === 'sql-wasm.wasm') {
      // In development, the WASM file is copied to dist/
      // In packaged extension, it's also in dist/
      return vscode.Uri.joinPath(vscode.Uri.file(extensionPath), 'dist', file).fsPath;
    }
    return file;
  };

  const foundationService = new PersistenceFoundation({
    dbPath,
    locateFile,
  });

  await foundationService.init();

  const conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
  const messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());

  const persistenceService = createPersistenceService(
    conversationRepo,
    messageRepo,
    foundationService
  );

  await persistenceService.initialize();

  logger.info('Persistence initialized successfully');
  return persistenceService;
}

function getWorkspaceId(_context: vscode.ExtensionContext): string {
  // Use workspace folder name or a hash of the workspace path for isolation
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    // Use the first workspace folder's name as the workspace ID
    const firstFolder = workspaceFolders[0];
    return firstFolder?.name ?? 'default';
  }
  return 'default';
}

interface WorkspaceToolSet {
  readonly folderUri: string;
  readonly folderId: string;
  readonly toolNames: readonly string[];
}

function registerWorkspaceTools(
  folder: WorkspaceFolder,
  fileSystem: VSCodeFileSystemProvider,
  toolRegistry: ToolRegistry,
  logger: Logger
): WorkspaceToolSet {
  const toolNames: string[] = [];

  try {
    const readFileTool = createReadFileToolDefinition({
      fileSystem,
      workspaceFolder: folder,
    });
    toolRegistry.register(readFileTool);
    toolNames.push('read_file');
  } catch (error) {
    logger.error('Failed to register read_file tool', {
      folderUri: folder.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const listDirectoryTool = createListDirectoryToolDefinition({
      fileSystem,
      workspaceFolder: folder,
    });
    toolRegistry.register(listDirectoryTool);
    toolNames.push('list_directory');
  } catch (error) {
    logger.error('Failed to register list_directory tool', {
      folderUri: folder.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const searchCodeTool = createSearchCodeToolDefinition({
      fileSystem,
      workspaceFolder: folder,
    });
    toolRegistry.register(searchCodeTool);
    toolNames.push('search_code');
  } catch (error) {
    logger.error('Failed to register search_code tool', {
      folderUri: folder.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const findReferencesTool = createFindReferencesToolDefinition({
      fileSystem,
      workspaceFolder: folder,
    });
    toolRegistry.register(findReferencesTool);
    toolNames.push('find_references');
  } catch (error) {
    logger.error('Failed to register find_references tool', {
      folderUri: folder.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Registered workspace tools', { folderUri: folder.uri, toolNames });
  return { folderUri: folder.uri, folderId: folder.id, toolNames };
}

function unregisterWorkspaceTools(
  folderUri: string,
  toolRegistry: ToolRegistry,
  logger: Logger
): void {
  const toolNames = ['read_file', 'list_directory', 'search_code', 'find_references'];
  for (const name of toolNames) {
    if (toolRegistry.has(name)) {
      try {
        toolRegistry.unregister(name);
        logger.debug('Unregistered tool', { toolName: name, folderUri });
      } catch (error) {
        logger.error('Failed to unregister tool', {
          toolName: name,
          folderUri,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  logger.info('Unregistered all workspace tools for folder', { folderUri });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('nexipi');
  const logLevel = config.get<LogLevel>('nexipi.logLevel', 'info');

  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  const logger = createLogger(outputChannel, logLevel);
  const statusBarItem = createStatusBarItem();

  logger.info(`Extension activating v${defaultConfig.version}`);
  outputChannel.appendLine(
    `[${new Date().toISOString()}] [INFO] NexiPi extension activating v${defaultConfig.version}`
  );

  // --- Workspace intelligence (Phase 08 Stage F) ---
  // Create and initialize the WorkspaceManager. Initialization kicks off the
  // initial full scan in the background so extension activation is not blocked.
  const workspaceProvider = new VSCodeWorkspaceProvider();
  const fileSystem = new VSCodeFileSystemProvider();
  const workspaceManager = new WorkspaceManager(workspaceProvider, fileSystem, { logger });
  gWorkspaceManager = workspaceManager;

  workspaceManager.onStatusChange((status) => {
    if (status.disposed) {
      updateStatusBar(statusBarItem, 'error', 'Workspace disposed');
      return;
    }
    const progress = status.progress;
    const detail = progress
      ? `${progress.stage} (${progress.filesDiscovered} files)`
      : `idle (${status.orchestrator.activeScanCount} active)`;
    updateStatusBar(statusBarItem, 'active', `Workspace: ${detail}`);
  });

  // Non-blocking: do not await so activation is not blocked by a large scan.
  void workspaceManager.initialize().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize workspace manager', { error: err.message });
  });

  // --- Tool infrastructure (Phase 09 Substage 7) ---
  // Create tool registry, executor with read-only permission policy, and execution service.
  const toolRegistry = createToolRegistry();
  gToolRegistry = toolRegistry;

  const permissionPolicy = createReadOnlyWorkspacePermissionPolicy(logger);
  const toolExecutor = new ToolExecutor(toolRegistry, { permissionPolicy, logger });

  const toolExecutionServiceConfig: ToolExecutionServiceConfig = {
    maxIterationsPerTurn: 10,
    maxCallsPerBatch: 5,
    maxCallsPerTurn: 25,
    maxConcurrentExecutions: 5,
    maxExecutionTimePerToolMs: 30_000,
    maxTotalExecutionTimePerTurnMs: 120_000,
    maxQueuedCalls: 100,
  };
  const toolExecutionService = new ToolExecutionService(toolExecutor, {
    config: toolExecutionServiceConfig,
    logger,
  });
  gToolExecutionService = toolExecutionService;

  // Register tools for each current workspace folder.
  const folders = await workspaceProvider.getWorkspaceFolders();
  for (const folder of folders) {
    registerWorkspaceTools(folder, fileSystem, toolRegistry, logger);
  }

  // Subscribe to workspace folder changes to register/unregister tools dynamically.
  const folderChangeSubscription = workspaceProvider.onWorkspaceFoldersChange((event) => {
    // Unregister tools for removed folders.
    for (const folder of event.removed) {
      unregisterWorkspaceTools(folder.uri, toolRegistry, logger);
    }

    // Register tools for added folders.
    for (const folder of event.added) {
      registerWorkspaceTools(folder, fileSystem, toolRegistry, logger);
    }

    // Changed folders (rename) are handled as remove + add by VS Code, but we log for clarity.
    if (event.changed.length > 0) {
      logger.info('Workspace folders changed (rename detected)', {
        changed: event.changed.map((f) => f.uri),
      });
    }
  });
  // Track subscription for disposal
  const folderChangeDisposable = { dispose: () => folderChangeSubscription.unsubscribe() };

  // Initialize persistence
  let persistenceService: PersistencePortService;
  try {
    persistenceService = await initializePersistence(context, logger);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize persistence', { error: err.message });
    updateStatusBar(statusBarItem, 'error', 'Persistence init failed');
    void vscode.window.showErrorMessage(`Failed to initialize NexiPi persistence: ${err.message}`);
    throw err;
  }

  const workspaceId = getWorkspaceId(context);
  logger.info('Workspace ID for persistence', { workspaceId });

  // Create persistence adapter
  const persistenceAdapter = createPersistenceAdapter({
    persistencePort: persistenceService,
    workspaceId,
  });

  await persistenceAdapter.initialize();

  const providerRegistry = createProviderRegistry();
  const chatService = createChatService({
    providerRegistry,
    logger,
    persistenceAdapter,
    workspaceId,
    toolRegistry,
    toolExecutionService,
  });

  // Initialize chat service (loads conversations from persistence)
  await chatService.initialize();

  // Store for deactivate()
  gChatService = chatService;
  gPersistenceService = persistenceService;
  gPersistenceAdapter = persistenceAdapter;
  gLogger = logger;

  const sidebarProvider = new NexiPiSidebarProvider(context.extensionUri, logger, chatService);

  const nexipiContext: NexiPiContext = {
    outputChannel,
    statusBarItem,
    logger,
    disposables: [],
    chatService,
    persistenceService,
    toolRegistry,
    toolExecutionService,
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
    folderChangeDisposable,
    ...commandDisposables
  );

  context.subscriptions.push(...nexipiContext.disposables);

  // Synchronous cleanup for context.subscriptions (not awaited by VS Code)
  context.subscriptions.push({
    dispose: () => {
      gLogger?.info('Synchronous disposal of persistence adapter');
      // Note: Async disposal is handled in deactivate() which IS awaited by VS Code
      gPersistenceAdapter?.dispose();
      // Note: persistenceService.dispose() is called by persistenceAdapter.dispose()
      // which closes the foundation service since it owns it
    },
  });

  gLogger.info('Extension activated successfully');
  updateStatusBar(statusBarItem, 'active');
}

// Track if deactivate has been called to ensure idempotency
let isDeactivated = false;

export async function deactivate(): Promise<void> {
  if (isDeactivated) {
    gLogger?.info('deactivate() called again, skipping (idempotent)');
    return;
  }
  isDeactivated = true;

  const logger = gLogger;
  const chatService = gChatService;
  const persistenceService = gPersistenceService;
  const toolExecutionService = gToolExecutionService;
  const toolRegistry = gToolRegistry;

  if (!logger || !chatService || !persistenceService) {
    logger?.warn('deactivate() called but services not initialized');
    return;
  }

  logger.info('Starting async deactivation sequence');

  // 1. Dispose tool execution service (cancels active tool executions and clears turns).
  // Must be before ChatService disposal so active tool turns are cancelled.
  try {
    toolExecutionService?.dispose();
    logger.info('ToolExecutionService disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose ToolExecutionService', { error: err.message });
  }

  // 2. Dispose workspace management and stop workspace activity.
  // Workspace cleanup errors are logged and must not prevent persistence saving.
  try {
    gWorkspaceManager?.dispose();
    gLogger?.info('Workspace manager disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    gLogger?.error('Failed to dispose workspace manager', { error: err.message });
  }

  // 3. Stop and dispose ChatService (waits for active streams to settle)
  try {
    await chatService.dispose();
    logger.info('ChatService disposed successfully');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose ChatService', { error: err.message });
  }

  // 4. Clear tool registry references (no async disposal needed).
  if (toolRegistry) {
    // ToolRegistry doesn't have a dispose method; clearing globals is sufficient.
    // Individual tool definitions are frozen and shared; no cleanup required.
    logger.debug('ToolRegistry references cleared');
  }
  gToolRegistry = undefined;
  gToolExecutionService = undefined;

  // 5. Save the database to disk
  try {
    persistenceService.save();
    logger.info('Database saved successfully on deactivation');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to save database on deactivation', { error: err.message });
    // Re-throw to signal failure to VS Code
    throw err;
  }

  logger.info('Async deactivation sequence completed');
}