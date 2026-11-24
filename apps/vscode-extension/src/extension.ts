import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
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
import type { WorkspaceFolder, ReadFileResult, ListDirectoryResult, CodeSearchResult, ReferenceDiscoveryResult } from '@nexipi/workspace';
import { createReadOnlyWorkspacePermissionPolicy } from './tools/permission-policy.js';
import type { ToolDefinition, ToolExecutionContext } from '@nexipi/models/tools';

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

// --- Multi-root workspace adapter registry ---
// Maps computed workspace ID -> adapter set for that workspace folder
interface WorkspaceAdapterSet {
  readonly folder: WorkspaceFolder;
  readonly readFile: (input: unknown, context: ToolExecutionContext) => Promise<ReadFileResult>;
  readonly listDirectory: (input: unknown, context: ToolExecutionContext) => Promise<ListDirectoryResult>;
  readonly searchCode: (input: unknown, context: ToolExecutionContext) => Promise<CodeSearchResult>;
  readonly findReferences: (input: unknown, context: ToolExecutionContext) => Promise<ReferenceDiscoveryResult>;
  readonly computedWorkspaceId: string;
}

const workspaceAdapters = new Map<string, WorkspaceAdapterSet>();

function computeWorkspaceId(folderUri: string): string {
  const normalized = folderUri.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

function computeMultiRootWorkspaceId(folders: readonly WorkspaceFolder[]): string {
  if (folders.length === 0) return 'ws_0';
  // Sort by URI for deterministic ordering
  const sortedUris = folders.map(f => f.uri).sort();
  const combined = sortedUris.join('|');
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

function createWorkspaceAdapters(
  folder: WorkspaceFolder,
  fileSystem: VSCodeFileSystemProvider
): WorkspaceAdapterSet {
  const computedWorkspaceId = computeWorkspaceId(folder.uri);

  const readFileTool = createReadFileToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const listDirectoryTool = createListDirectoryToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const searchCodeTool = createSearchCodeToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const findReferencesTool = createFindReferencesToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });

  return {
    folder,
    readFile: (input: unknown, context: ToolExecutionContext) => readFileTool.execute(input, context) as Promise<ReadFileResult>,
    listDirectory: (input: unknown, context: ToolExecutionContext) => listDirectoryTool.execute(input, context) as Promise<ListDirectoryResult>,
    searchCode: (input: unknown, context: ToolExecutionContext) => searchCodeTool.execute(input, context) as Promise<CodeSearchResult>,
    findReferences: (input: unknown, context: ToolExecutionContext) => findReferencesTool.execute(input, context) as Promise<ReferenceDiscoveryResult>,
    computedWorkspaceId,
  };
}

function registerWorkspaceAdapters(
  folder: WorkspaceFolder,
  fileSystem: VSCodeFileSystemProvider,
  logger: Logger
): string {
  const adapterSet = createWorkspaceAdapters(folder, fileSystem);
  const workspaceId = adapterSet.computedWorkspaceId;

  if (workspaceAdapters.has(workspaceId)) {
    logger.warn('Workspace adapter already registered, replacing', { workspaceId, folderUri: folder.uri });
  }
  workspaceAdapters.set(workspaceId, adapterSet);
  logger.info('Registered workspace adapters', { workspaceId, folderUri: folder.uri, folderId: folder.id });
  return workspaceId;
}

function unregisterWorkspaceAdapters(
  folderUri: string,
  logger: Logger
): void {
  // Find and remove by folder URI
  for (const [workspaceId, adapterSet] of workspaceAdapters.entries()) {
    if (adapterSet.folder.uri === folderUri) {
      workspaceAdapters.delete(workspaceId);
      logger.info('Unregistered workspace adapters', { workspaceId, folderUri });
      return;
    }
  }
  logger.warn('No workspace adapters found for folder', { folderUri });
}

function getRegisteredWorkspaceIds(): readonly string[] {
  return Array.from(workspaceAdapters.keys());
}

function hasWorkspaceAdapter(workspaceId: string): boolean {
  return workspaceAdapters.has(workspaceId);
}

function getWorkspaceAdapter(workspaceId: string): WorkspaceAdapterSet | undefined {
  return workspaceAdapters.get(workspaceId);
}

// --- Routed tool definitions (single registration per capability) ---
const ReadFileInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  workspaceId: z.string().min(1, 'workspaceId is required'),
});

const ListDirectoryInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
});

const SearchCodeInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  filePattern: z.string().optional(),
  caseSensitive: z.boolean().optional(),
});

const FindReferencesInputSchema = z.object({
  symbol: z.string().min(1, 'symbol is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  filePattern: z.string().optional(),
});

function createRoutedReadFileTool(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read the contents of a file from a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: ReadFileInputSchema,
    outputSchema: z.any(), // Output schema validated by underlying adapter
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ReadFileResult> => {
      const { uri, lineStart, lineEnd, workspaceId } = input as z.infer<typeof ReadFileInputSchema>;
      
      if (!hasWorkspaceAdapter(workspaceId)) {
        throw new Error(`Workspace '${workspaceId}' is not registered. Available: ${getRegisteredWorkspaceIds().join(', ')}`);
      }
      
      const adapter = getWorkspaceAdapter(workspaceId)!;
      
      // Validate workspace identity matches
      if (context.workspaceId && context.workspaceId !== adapter.computedWorkspaceId) {
        throw new Error(`Workspace identity mismatch: context=${context.workspaceId}, adapter=${adapter.computedWorkspaceId}`);
      }
      
      return adapter.readFile(
        { uri, lineStart, lineEnd, workspaceFolder: adapter.folder, signal: context.signal },
        context
      );
    },
  };
}

function createRoutedListDirectoryTool(): ToolDefinition {
  return {
    name: 'list_directory',
    description: 'List the contents of a directory in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: ListDirectoryInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ListDirectoryResult> => {
      const { uri, workspaceId } = input as z.infer<typeof ListDirectoryInputSchema>;
      
      if (!hasWorkspaceAdapter(workspaceId)) {
        throw new Error(`Workspace '${workspaceId}' is not registered. Available: ${getRegisteredWorkspaceIds().join(', ')}`);
      }
      
      const adapter = getWorkspaceAdapter(workspaceId)!;
      
      if (context.workspaceId && context.workspaceId !== adapter.computedWorkspaceId) {
        throw new Error(`Workspace identity mismatch: context=${context.workspaceId}, adapter=${adapter.computedWorkspaceId}`);
      }
      
      return adapter.listDirectory(
        { uri, workspaceFolder: adapter.folder, signal: context.signal },
        context
      );
    },
  };
}

function createRoutedSearchCodeTool(): ToolDefinition {
  return {
    name: 'search_code',
    description: 'Search for code patterns in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: SearchCodeInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<CodeSearchResult> => {
      const { pattern, workspaceId, filePattern, caseSensitive } = input as z.infer<typeof SearchCodeInputSchema>;
      
      if (!hasWorkspaceAdapter(workspaceId)) {
        throw new Error(`Workspace '${workspaceId}' is not registered. Available: ${getRegisteredWorkspaceIds().join(', ')}`);
      }
      
      const adapter = getWorkspaceAdapter(workspaceId)!;
      
      if (context.workspaceId && context.workspaceId !== adapter.computedWorkspaceId) {
        throw new Error(`Workspace identity mismatch: context=${context.workspaceId}, adapter=${adapter.computedWorkspaceId}`);
      }
      
      return adapter.searchCode(
        { pattern, workspaceFolder: adapter.folder, filePattern, caseSensitive, signal: context.signal },
        context
      );
    },
  };
}

function createRoutedFindReferencesTool(): ToolDefinition {
  return {
    name: 'find_references',
    description: 'Find references to a symbol in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: FindReferencesInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ReferenceDiscoveryResult> => {
      const { symbol, workspaceId, filePattern } = input as z.infer<typeof FindReferencesInputSchema>;
      
      if (!hasWorkspaceAdapter(workspaceId)) {
        throw new Error(`Workspace '${workspaceId}' is not registered. Available: ${getRegisteredWorkspaceIds().join(', ')}`);
      }
      
      const adapter = getWorkspaceAdapter(workspaceId)!;
      
      if (context.workspaceId && context.workspaceId !== adapter.computedWorkspaceId) {
        throw new Error(`Workspace identity mismatch: context=${context.workspaceId}, adapter=${adapter.computedWorkspaceId}`);
      }
      
      return adapter.findReferences(
        { symbol, workspaceFolder: adapter.folder, filePattern, signal: context.signal },
        context
      );
    },
  };
}

function registerRoutedTools(toolRegistry: ToolRegistry, logger: Logger): void {
  const tools = [
    createRoutedReadFileTool(),
    createRoutedListDirectoryTool(),
    createRoutedSearchCodeTool(),
    createRoutedFindReferencesTool(),
  ];
  
  for (const tool of tools) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
      logger.info('Registered routed tool', { toolName: tool.name });
    } else {
      logger.debug('Routed tool already registered', { toolName: tool.name });
    }
  }
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

  // Initialize workspace manager and wait for initial scan to complete
  // before registering tools, to ensure workspace identity is stable.
  try {
    await workspaceManager.initialize();
    logger.info('Workspace manager initialized');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize workspace manager', { error: err.message });
    updateStatusBar(statusBarItem, 'error', 'Workspace init failed');
    throw err;
  }

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

  // Register the four routed tools (single registration per capability)
  registerRoutedTools(toolRegistry, logger);

  // Register workspace adapters for each current workspace folder.
  const folders = await workspaceProvider.getWorkspaceFolders();
  for (const folder of folders) {
    registerWorkspaceAdapters(folder, fileSystem, logger);
  }

  // Subscribe to workspace folder changes to register/unregister adapters dynamically.
  const folderChangeSubscription = workspaceProvider.onWorkspaceFoldersChange((event) => {
    // Unregister adapters for removed folders.
    for (const folder of event.removed) {
      unregisterWorkspaceAdapters(folder.uri, logger);
    }

    // Register adapters for added folders.
    for (const folder of event.added) {
      registerWorkspaceAdapters(folder, fileSystem, logger);
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

  // Compute stable multi-root workspace ID for persistence
  const workspaceId = computeMultiRootWorkspaceId(folders);
  logger.info('Multi-root workspace ID for persistence', { workspaceId, folderCount: folders.length });

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

  // NOTE: Persistence adapter disposal is handled ONLY in async deactivate()
  // to avoid double-disposal and ensure correct shutdown ordering.

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

  // 1. Stop accepting new work and cancel active ChatService requests/streams.
  //    This initiates cancellation which propagates to ToolExecutionService turns.
  try {
    await chatService.dispose();
    logger.info('ChatService disposed successfully');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose ChatService', { error: err.message });
  }

  // 2. Dispose ToolExecutionService - await active executions with timeout.
  //    This ensures tools receive AbortSignal and have time to settle.
  try {
    await disposeToolExecutionServiceWithTimeout(toolExecutionService, logger, 5000);
    logger.info('ToolExecutionService disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose ToolExecutionService', { error: err.message });
  }

  // 3. Dispose workspace management and stop workspace activity.
  //    Now safe because ChatService and ToolExecutionService have stopped using filesystem.
  try {
    gWorkspaceManager?.dispose();
    gLogger?.info('Workspace manager disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    gLogger?.error('Failed to dispose workspace manager', { error: err.message });
  }

  // 4. Clear tool registry references and workspace adapters.
  workspaceAdapters.clear();
  if (toolRegistry) {
    logger.debug('ToolRegistry references cleared');
  }
  gToolRegistry = undefined;
  gToolExecutionService = undefined;

  // 5. Save the database to disk, then dispose persistence adapter.
  try {
    persistenceService.save();
    logger.info('Database saved successfully on deactivation');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to save database on deactivation', { error: err.message });
    throw err;
  }

  // 6. Dispose persistence adapter (closes foundation service)
  try {
    gPersistenceAdapter?.dispose();
    logger.info('Persistence adapter disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose persistence adapter', { error: err.message });
  }

  logger.info('Async deactivation sequence completed');
}

/**
 * Dispose ToolExecutionService with a bounded wait for active executions to settle.
 * This ensures tools receive cancellation signals and have time to complete cooperatively.
 */
async function disposeToolExecutionServiceWithTimeout(
  service: ToolExecutionService | undefined,
  logger: Logger,
  timeoutMs: number
): Promise<void> {
  if (!service) return;

  // Signal cancellation to all active turns
  service.dispose();

  // Wait for active executions to complete or timeout
  const startTime = Date.now();
  for (;;) {
    const snapshot = service.getGlobalSnapshot();
    if (snapshot.activeExecutions === 0 && snapshot.queuedCalls === 0) {
      logger.debug('ToolExecutionService: all executions settled', { elapsedMs: Date.now() - startTime });
      break;
    }
    if (Date.now() - startTime > timeoutMs) {
      logger.warn('ToolExecutionService disposal timeout, active executions may still be running', {
        activeExecutions: snapshot.activeExecutions,
        queuedCalls: snapshot.queuedCalls,
        elapsedMs: Date.now() - startTime,
      });
      break;
    }
    // Yield to allow async completions
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}