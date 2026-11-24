import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { WorkspaceFolder } from '@nexipi/workspace';
import { createToolRegistry } from '@nexipi/models/tools';
import { ToolExecutor } from '@nexipi/models/tools';
import { ToolExecutionService } from '@nexipi/models/tools';
import { createReadFileToolDefinition } from '@nexipi/workspace/tools';
import { createListDirectoryToolDefinition } from '@nexipi/workspace/tools';
import { createSearchCodeToolDefinition } from '@nexipi/workspace/tools';
import { createFindReferencesToolDefinition } from '@nexipi/workspace/tools';
import { createReadOnlyWorkspacePermissionPolicy } from '../../tools/permission-policy.js';
import { createLogger } from '../../logger.js';
import { createRoutedReadFileTool } from '../../extension.js';
import { createRoutedListDirectoryTool } from '../../extension.js';
import { createRoutedSearchCodeTool } from '../../extension.js';
import { createRoutedFindReferencesTool } from '../../extension.js';
import { registerWorkspaceAdapters, getWorkspaceAdapter, workspaceAdapters } from '../../extension.js';
import type { ToolExecutionContext } from '@nexipi/models/tools';
import { InMemoryFileSystemProvider } from '../../test-utils/in-memory-file-system.js';

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
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: [],
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
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
    parse: vi.fn((uri: string) => ({
      scheme: uri.startsWith('file://') ? 'file' : 'unknown',
      path: uri.replace('file://', ''),
      toString: () => uri,
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
  RelativePattern: vi.fn((base: unknown, pattern: string) => ({ base, pattern })),
}));

// Mock WorkspaceManager to avoid real initialization
vi.mock('../../../workspace/workspace-manager.js', () => ({
  WorkspaceManager: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
  }))
}));

describe('Real Tool Execution Integration', () => {
  let logger: ReturnType<typeof createLogger>;
  let toolRegistry: ReturnType<typeof createToolRegistry>;
  let toolExecutor: ToolExecutor;
  let toolExecutionService: ToolExecutionService;
  let permissionPolicy: ReturnType<typeof createReadOnlyWorkspacePermissionPolicy>;
  
  // Two test workspace folders
  const folderA: WorkspaceFolder = { id: 'ws_a' as any, uri: 'file:///workspaceA', name: 'workspaceA', index: 0 };
  const folderB: WorkspaceFolder = { id: 'ws_b' as any, uri: 'file:///workspaceB', name: 'workspaceB', index: 1 };

  beforeAll(async () => {
    vi.resetModules();
    logger = createLogger({ name: 'test', version: '1.0.0', logLevel: 'debug', maxConcurrentTasks: 10, taskTimeoutMs: 30000, shutdownTimeoutMs: 10000, enableTelemetry: false });
  });

  afterAll(async () => {
    vi.resetModules();
  });

  beforeEach(() => {
    // Clear the workspace adapters map
    workspaceAdapters.clear();
    
    // Create tool infrastructure
    toolRegistry = createToolRegistry();
    permissionPolicy = createReadOnlyWorkspacePermissionPolicy(logger);
    toolExecutor = new ToolExecutor(toolRegistry, { permissionPolicy, logger });
    toolExecutionService = new ToolExecutionService(toolExecutor, {
      config: {
        maxIterationsPerTurn: 10,
        maxCallsPerBatch: 5,
        maxCallsPerTurn: 25,
        maxConcurrentExecutions: 5,
        maxExecutionTimePerToolMs: 30_000,
        maxTotalExecutionTimePerTurnMs: 120_000,
        maxQueuedCalls: 100,
      },
      logger,
    });
    
    // Register the routed tools (single registration per capability)
    const routedReadFile = createRoutedReadFileTool();
    const routedListDir = createRoutedListDirectoryTool();
    const routedSearchCode = createRoutedSearchCodeTool();
    const routedFindRefs = createRoutedFindReferencesTool();
    toolRegistry.register(routedReadFile);
    toolRegistry.register(routedListDir);
    toolRegistry.register(routedSearchCode);
    toolRegistry.register(routedFindRefs);
  });

  afterEach(async () => {
    await toolExecutionService.drain({ timeoutMs: 1000 });
    toolExecutionService.dispose();
    workspaceAdapters.clear();
  });

  describe('Workspace adapter registration and routed tool execution', () => {
    it('should register adapters for both folders and execute read_file on each via routed tool', async () => {
      // Create fresh filesystem for each folder
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      // Setup test files in folder A
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;\nfunction fooA() { return "A"; }');
      fsA.writeFile('/workspaceA/.gitignore', '*.log\nnode_modules/');
      
      // Setup test files in folder B
      fsB.writeFile('/workspaceB/fileB.txt', 'Hello from folder B');
      fsB.writeFile('/workspaceB/subdir/fileB2.ts', 'export const b = 2;\nfunction fooB() { return "B"; }');
      fsB.writeFile('/workspaceB/.gitignore', '*.tmp\ndist/');
      
      // Register workspace adapters for both folders
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      // Verify both adapters are registered
      const adapterA = getWorkspaceAdapter('ws_a');
      const adapterB = getWorkspaceAdapter('ws_b');
      expect(adapterA).toBeDefined();
      expect(adapterB).toBeDefined();
      expect(adapterA?.folder.uri).toBe('file:///workspaceA');
      expect(adapterB?.folder.uri).toBe('file:///workspaceB');
      
      // Create turn and execute on folder A via routed tool
      const turn = toolExecutionService.createTurn({ id: 'test-turn-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const resultA = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_a' } }
      ], contextA);
      
      expect(resultA[0].kind).toBe('success');
      expect((resultA[0] as any).output.content).toContain('Hello from folder A');
      
      // Execute on folder B via routed tool
      const turn2 = toolExecutionService.createTurn({ id: 'test-turn-2' });
      const contextB: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_b', 
        workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
        logger 
      };
      
      const resultB = await turn2.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceB/fileB.txt', workspaceId: 'ws_b' } }
      ], contextB);
      
      expect(resultB[0].kind).toBe('success');
      expect((resultB[0] as any).output.content).toContain('Hello from folder B');
    });

    it('should execute list_directory on each folder via routed tool', async () => {
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;\nfunction fooA() { return "A"; }');
      
      fsB.writeFile('/workspaceB/fileB.txt', 'Hello from folder B');
      fsB.writeFile('/workspaceB/subdir/fileB2.ts', 'export const b = 2;\nfunction fooB() { return "B"; }');
      
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-list-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'list_directory', input: { uri: '/workspaceA', workspaceId: 'ws_a' } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.entries.some((e: any) => e.name === 'fileA.txt')).toBe(true);
      expect(output.entries.some((e: any) => e.name === 'subdir')).toBe(true);
    });

    it('should execute search_code on each folder via routed tool', async () => {
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;\nfunction fooA() { return "A"; }');
      fsB.writeFile('/workspaceB/subdir/fileB2.ts', 'export const b = 2;\nfunction fooB() { return "B"; }');
      
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-search-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'search_code', input: { pattern: 'fooA', filePattern: '*.ts', workspaceId: 'ws_a' } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.matches.length).toBeGreaterThan(0);
      expect(output.matches.some((m: any) => m.matchText.includes('fooA'))).toBe(true);
    });

    it('should execute find_references on each folder via routed tool', async () => {
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;\nfunction fooA() { return "A"; }');
      fsB.writeFile('/workspaceB/subdir/fileB2.ts', 'export const b = 2;\nfunction fooB() { return "B"; }');
      
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-refs-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'find_references', input: { symbol: 'fooA', filePattern: '*.ts', workspaceId: 'ws_a' } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.references.length).toBeGreaterThan(0);
    });
  });

  describe('Workspace isolation', () => {
    it('should isolate folder A from folder B (different workspaceFolder in context)', async () => {
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsB.writeFile('/workspaceB/fileB.txt', 'Hello from folder B');
      
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-iso-1' });
      // Request folder B's workspace but with folder A's context
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_b',  // Request folder B's workspace
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceB/fileB.txt', workspaceId: 'ws_b' } }
      ], contextA);
      
      // The routed tool should find the adapter for ws_b and execute it
      // The adapter for ws_b should reject the request because the file is in folder B but
      // the context's workspaceFolder is folderA (mismatch)
      expect(result[0].kind).toBe('failure');
    });

    it('should reject cross-folder search access', async () => {
      const fsA = new InMemoryFileSystemProvider();
      const fsB = new InMemoryFileSystemProvider();
      
      fsA.writeFile('/workspaceA/fileA.txt', 'content A');
      fsB.writeFile('/workspaceB/fileB.txt', 'content B');
      
      registerWorkspaceAdapters(folderA, fsA, logger);
      registerWorkspaceAdapters(folderB, fsB, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-iso-2' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_b', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'search_code', input: { pattern: 'content B', filePattern: '*.txt', workspaceId: 'ws_b' } }
      ], contextA);
      
      expect(result[0].kind).toBe('failure');
    });
  });

  describe('Workspace identity validation', () => {
    it('should reject tool calls with mismatched workspace identity', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-identity-1' });
      // Use folder B's identity but folder A's adapter context
      const contextWrong: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_a' } }
      ], contextWrong);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.message).toContain('Workspace identity mismatch');
    });

    it('should reject invalid workspace IDs', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-identity-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_invalid', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_invalid' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.message).toContain('not registered');
    });
  });

  describe('Cancellation propagation', () => {
    it('should cancel active tool execution when turn is cancelled', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-cancel-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Start a read operation
      const promise = turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_a' } }
      ], context);
      
      // Cancel the turn
      turn.cancel();
      
      const result = await promise;
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_CANCELLED');
    });

    it('should cancel queued calls when turn is cancelled', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-cancel-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Submit multiple calls to fill the queue
      const promises = [
        turn.submitBatch([{ toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_a' } }], context),
        turn.submitBatch([{ toolName: 'read_file', input: { uri: '/workspaceA/subdir/fileA2.ts', workspaceId: 'ws_a' } }], context),
      ];
      
      // Cancel the turn
      turn.cancel();
      
      const results = await Promise.all(promises);
      for (const result of results) {
        expect(result[0].kind).toBe('failure');
        expect((result[0] as any).error.code).toBe('TOOL_CANCELLED');
      }
    });
  });

  describe('Concurrent execution limits', () => {
    it('should respect maxConcurrentExecutions limit', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-concurrent-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Submit more calls than maxConcurrentExecutions (5)
      const promises = Array.from({ length: 7 }, (_, i) => 
        turn.submitBatch([{ toolName: 'read_file', input: { uri: `/workspaceA/fileA.txt`, workspaceId: 'ws_a' } }], context)
      );
      
      const results = await Promise.all(promises);
      // All should succeed (some queued, some concurrent)
      for (const result of results) {
        expect(result[0].kind).toBe('success');
      }
    });
  });

  describe('Shutdown drain behavior', () => {
    it('should drain active executions on shutdown', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-drain-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Start some executions
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: 'ws_a' } }
      ], context);
      
      // Drain should wait for them to complete
      const drainResult = await toolExecutionService.drain({ timeoutMs: 5000 });
      expect(drainResult.settled).toBe(true);
      expect(drainResult.activeExecutions).toBe(0);
    });

    it('should cancel queued work on drain', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-drain-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Queue up some work (more than concurrency limit)
      const promises = Array.from({ length: 10 }, (_, i) => 
        turn.submitBatch([{ toolName: 'read_file', input: { uri: `/workspaceA/fileA.txt`, workspaceId: 'ws_a' } }], context)
      );
      
      // Give a moment for queue to build up
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Drain should cancel queued work
      const drainResult = await toolExecutionService.drain({ timeoutMs: 5000 });
      expect(drainResult.queuedCalls).toBe(0);
      
      // Wait for all promises to settle
      await Promise.allSettled(promises);
    });

    it('should wait for underlying promises on waitForUnderlyings', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-wait-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/file.txt', workspaceId: 'ws_a' } }
      ], context);
      
      await toolExecutionService.waitForUnderlyings(2000);
      // Should complete without timeout
    });
  });

  describe('ToolExecutionService disposal', () => {
    it('should dispose cleanly', async () => {
      const fsA = new InMemoryFileSystemProvider();
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'test-dispose-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: 'ws_a', 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/file.txt', workspaceId: 'ws_a' } }
      ], context);
      
      toolExecutionService.dispose();
      expect(toolExecutionService.getGlobalSnapshot().activeExecutions).toBe(0);
    });

    it('should handle repeated dispose calls', async () => {
      toolExecutionService.dispose();
      toolExecutionService.dispose(); // Should not throw
    });

    it('should reject new turns after disposal', async () => {
      toolExecutionService.dispose();
      expect(() => toolExecutionService.createTurn()).toThrow();
    });
  });
});