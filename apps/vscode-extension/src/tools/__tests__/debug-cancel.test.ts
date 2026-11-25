import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { WorkspaceFolder } from '@nexipi/workspace';
import { createToolRegistry } from '@nexipi/models/tools';
import { ToolExecutor } from '@nexipi/models/tools';
import { ToolExecutionService } from '@nexipi/models/tools';
import { createReadOnlyWorkspacePermissionPolicy } from '../../tools/permission-policy.js';
import { createLogger } from '../../logger.js';
import { createRoutedReadFileTool } from '../../extension.js';
import { registerWorkspaceAdapters, workspaceAdapters } from '../../extension.js';
import type { ToolExecutionContext } from '@nexipi/models/tools';
import { InMemoryFileSystemProvider } from '../../test-utils/in-memory-file-system.js';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })), createStatusBarItem: vi.fn(() => ({ text: '', tooltip: '', command: '', show: vi.fn(), dispose: vi.fn() })), showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), registerWebviewViewProvider: vi.fn() },
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn((key: string, dv: unknown) => dv) })), onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })), workspaceFolders: [], onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })), createFileSystemWatcher: vi.fn(() => ({ onDidCreate: vi.fn(() => ({ dispose: vi.fn() })), onDidChange: vi.fn(() => ({ dispose: vi.fn() })), onDidDelete: vi.fn(() => ({ dispose: vi.fn() })), dispose: vi.fn() })) },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  Uri: { joinPath: vi.fn((base: any, ...paths: string[]) => ({ toString: () => `file://${[base, ...paths].join('/')}`, fsPath: [base, ...paths].join('/') })), file: vi.fn((p: string) => ({ fsPath: p })), parse: vi.fn((uri: string) => ({ scheme: uri.startsWith('file://') ? 'file' : 'unknown', path: uri.replace('file://', ''), toString: () => uri })) },
  ViewColumn: {}, WebviewViewProvider: vi.fn(), ExtensionContext: { subscriptions: [], globalStorageUri: { fsPath: '/tmp/globalStorage' }, extensionPath: 'C:/DNET/NEXIPI/apps/vscode-extension' }, StatusBarAlignment: { Right: 1 }, CancellationToken: {}, WebviewViewResolveContext: {}, Webview: { asWebviewUri: vi.fn((uri: any) => ({ toString: () => `vscode-webview://${uri}` })) }, RelativePattern: vi.fn((base: any, pattern: string) => ({ base, pattern }))
}));
vi.mock('../../../workspace/workspace-manager.js', () => ({ WorkspaceManager: vi.fn(() => ({ initialize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), onStatusChange: vi.fn(() => ({ dispose: vi.fn() })) })) }));

describe('debug cancel', () => {
  let logger: any; let toolRegistry: any; let toolExecutionService: any;
  const folderA: WorkspaceFolder = { id: 'ws_a' as any, uri: 'file:///workspaceA', name: 'workspaceA', index: 0 };
  beforeAll(() => { logger = createLogger({ name: 'test', version: '1.0.0', logLevel: 'debug', maxConcurrentTasks: 10, taskTimeoutMs: 30000, shutdownTimeoutMs: 10000, enableTelemetry: false }); });
  beforeEach(() => {
    workspaceAdapters.clear();
    toolRegistry = createToolRegistry();
    const permissionPolicy = createReadOnlyWorkspacePermissionPolicy(logger);
    const toolExecutor = new ToolExecutor(toolRegistry, { permissionPolicy, logger });
    toolExecutionService = new ToolExecutionService(toolExecutor, { logger });
    toolRegistry.register(createRoutedReadFileTool());
  });
  afterEach(async () => { await toolExecutionService.drain({ timeoutMs: 1000 }).catch(()=>{}); toolExecutionService.dispose(); workspaceAdapters.clear(); });
  it('case', async () => {
    const fsA = new InMemoryFileSystemProvider();
    fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
    const workspaceIdA = registerWorkspaceAdapters(folderA, fsA as any, logger);
    const turn = toolExecutionService.createTurn({ id: 't' });
    const context: ToolExecutionContext = { signal: new AbortController().signal, workspaceId: workspaceIdA, workspaceFolder: { uri: folderA.uri, id: folderA.id }, logger };
    const promise = turn.submitBatch([{ toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }], context);
    turn.cancel();
    let result; try { result = await promise; console.log('RESOLVED', JSON.stringify(result)); } catch (e) { console.log('REJECTED', e && e.code, e && e.message); }
  });
});

