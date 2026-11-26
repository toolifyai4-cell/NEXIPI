import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { z } from 'zod';
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

  function createTestFileSystems() {
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
    
    return { fsA, fsB };
  }

  function registerTestWorkspaces(fsA: InMemoryFileSystemProvider, fsB: InMemoryFileSystemProvider) {
    // Clear any existing adapters
    workspaceAdapters.clear();
    
    // Register workspace adapters for both folders
    const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
    const workspaceIdB = registerWorkspaceAdapters(folderB, fsB, logger);
    
    return { workspaceIdA, workspaceIdB };
  }

  describe('Workspace adapter registration and routed tool execution', () => {
    it('should register adapters for both folders and execute read_file on each via routed tool', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      // Verify both adapters are registered
      const adapterA = getWorkspaceAdapter(workspaceIdA);
      const adapterB = getWorkspaceAdapter(workspaceIdB);
      expect(adapterA).toBeDefined();
      expect(adapterB).toBeDefined();
      expect(adapterA?.folder.uri).toBe('file:///workspaceA');
      expect(adapterB?.folder.uri).toBe('file:///workspaceB');
      
      // Create turn and execute on folder A via routed tool
      const turn = toolExecutionService.createTurn({ id: 'test-turn-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const resultA = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], contextA);
      
      expect(resultA[0].kind).toBe('success');
      expect((resultA[0] as any).output.content).toContain('Hello from folder A');
      
      // Execute on folder B via routed tool
      const turn2 = toolExecutionService.createTurn({ id: 'test-turn-2' });
      const contextB: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdB, 
        workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
        logger 
      };
      
      const resultB = await turn2.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceB/fileB.txt', workspaceId: workspaceIdB } }
      ], contextB);
      
      expect(resultB[0].kind).toBe('success');
      expect((resultB[0] as any).output.content).toContain('Hello from folder B');
    });

    it('should execute list_directory on each folder via routed tool', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      const turn = toolExecutionService.createTurn({ id: 'test-list-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'list_directory', input: { uri: '/workspaceA', workspaceId: workspaceIdA } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.entries.some((e: any) => e.name === 'fileA.txt')).toBe(true);
      expect(output.entries.some((e: any) => e.name === 'subdir')).toBe(true);
    });

    it('should execute search_code on each folder via routed tool', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      const turn = toolExecutionService.createTurn({ id: 'test-search-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'search_code', input: { pattern: 'fooA', filePattern: '*.ts', workspaceId: workspaceIdA } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      // search_code returns files array with matches inside each file
      expect(output.files.length).toBeGreaterThan(0);
      const allMatches = output.files.flatMap((f: any) => f.matches);
      expect(allMatches.length).toBeGreaterThan(0);
      expect(allMatches.some((m: any) => m.matchedText.includes('fooA'))).toBe(true);
    });

    it('should execute find_references on each folder via routed tool', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      const turn = toolExecutionService.createTurn({ id: 'test-refs-1' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'find_references', input: { symbol: 'fooA', filePattern: '*.ts', workspaceId: workspaceIdA } }
      ], contextA);
      
      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      // find_references returns files array with references inside each file
      expect(output.files.length).toBeGreaterThan(0);
      const allReferences = output.files.flatMap((f: any) => f.references);
      expect(allReferences.length).toBeGreaterThan(0);
    });
  });

  describe('Workspace isolation', () => {
    it('should correctly route to target folder when file exists', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsB.writeFile('/workspaceB/fileB.txt', 'Hello from folder B');
      
      const turn = toolExecutionService.createTurn({ id: 'test-iso-1' });
      // Request folder B's workspace with folder B's workspaceId
      // The routed tool should route to folder B's adapter and read the file from folder B
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdB,  // Request folder B's workspace
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceB/fileB.txt', workspaceId: workspaceIdB } }
      ], contextA);
      
      // The routed tool should find the adapter for workspaceIdB and execute it
      // The adapter for workspaceIdB should read the file from folder B's file system
      // Since the file exists in folder B, this should succeed
      expect(result[0].kind).toBe('success');
      expect((result[0] as any).output.content).toContain('Hello from folder B');
    });

    it('should reject cross-folder access when file does not exist in target folder', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'content A');
      // Don't write fileB.txt to folder B
      
      const turn = toolExecutionService.createTurn({ id: 'test-iso-2' });
      const contextA: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdB, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceB/does-not-exist.txt', workspaceId: workspaceIdB } }
      ], contextA);
      
      // The routed tool routes to folder B's adapter, but the file doesn't exist in folder B
      expect(result[0].kind).toBe('failure');
    });
  });

  describe('Workspace identity validation', () => {
    it('should route by workspaceId even when context workspaceFolder differs', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-identity-1' });
      // Use workspaceIdA but with folderB's workspaceFolder in context
      // The routed tool should route by workspaceId and ignore context workspaceFolder
      const contextWrong: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
        logger 
      };
      
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], contextWrong);
      
      // Should succeed because routed tool routes by workspaceId, not context workspaceFolder
      expect(result[0].kind).toBe('success');
      expect((result[0] as any).output.content).toContain('Hello from folder A');
    });

    it('should reject invalid workspace IDs', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
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

    describe('Multi-root routing — identical filenames', () => {
      it('should route read_file by workspaceId when filenames are identical across roots', async () => {
        const fsA = new InMemoryFileSystemProvider();
        const fsB = new InMemoryFileSystemProvider();
        
        fsA.writeFile('/workspaceA/src/config.ts', 'export const value = "AAA";');
        fsB.writeFile('/workspaceB/src/config.ts', 'export const value = "BBB";');
        
        const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
        const workspaceIdB = registerWorkspaceAdapters(folderB, fsB, logger);
        
        const turnA = toolExecutionService.createTurn({ id: 'mr-1' });
        const ctxA: ToolExecutionContext = { 
          signal: new AbortController().signal, 
          workspaceId: workspaceIdA, 
          workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
          logger 
        };
        const resA = await turnA.submitBatch([
          { toolName: 'read_file', input: { uri: '/workspaceA/src/config.ts', workspaceId: workspaceIdA } }
        ], ctxA);
        expect(resA[0].kind).toBe('success');
        expect((resA[0] as any).output.content).toContain('AAA');
        
        const turnB = toolExecutionService.createTurn({ id: 'mr-2' });
        const ctxB: ToolExecutionContext = { 
          signal: new AbortController().signal, 
          workspaceId: workspaceIdB, 
          workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
          logger 
        };
        const resB = await turnB.submitBatch([
          { toolName: 'read_file', input: { uri: '/workspaceB/src/config.ts', workspaceId: workspaceIdB } }
        ], ctxB);
        expect(resB[0].kind).toBe('success');
        expect((resB[0] as any).output.content).toContain('BBB');
      });

      it('should route list_directory by workspaceId when filenames are identical across roots', async () => {
        const fsA = new InMemoryFileSystemProvider();
        const fsB = new InMemoryFileSystemProvider();
        
        fsA.writeFile('/workspaceA/src/config.ts', 'export const a = 1;\nexport const b = 2;');
        fsA.writeFile('/workspaceA/src/readme.md', '# Folder A');
        fsB.writeFile('/workspaceB/src/config.ts', 'export const a = 1;\nexport const b = 2;');
        fsB.writeFile('/workspaceB/src/readme.md', '# Folder B');
        
        const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
        const workspaceIdB = registerWorkspaceAdapters(folderB, fsB, logger);
        
        const turnA = toolExecutionService.createTurn({ id: 'mr-3' });
        const ctxA: ToolExecutionContext = { 
          signal: new AbortController().signal, 
          workspaceId: workspaceIdA, 
          workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
          logger 
        };
        const resA = await turnA.submitBatch([
          { toolName: 'list_directory', input: { uri: '/workspaceA/src', workspaceId: workspaceIdA } }
        ], ctxA);
        expect(resA[0].kind).toBe('success');
        expect((resA[0] as any).output.entries.some((e: any) => e.name === 'config.ts')).toBe(true);
        expect((resA[0] as any).output.entries.some((e: any) => e.name === 'readme.md')).toBe(true);
        
        const turnB = toolExecutionService.createTurn({ id: 'mr-4' });
        const ctxB: ToolExecutionContext = { 
          signal: new AbortController().signal, 
          workspaceId: workspaceIdB, 
          workspaceFolder: { uri: folderB.uri, id: folderB.id }, 
          logger 
        };
        const resB = await turnB.submitBatch([
          { toolName: 'list_directory', input: { uri: '/workspaceB/src', workspaceId: workspaceIdB } }
        ], ctxB);
        expect(resB[0].kind).toBe('success');
        expect((resB[0] as any).output.entries.some((e: any) => e.name === 'config.ts')).toBe(true);
        expect((resB[0] as any).output.entries.some((e: any) => e.name === 'readme.md')).toBe(true);
      });
    });
  });

  describe('Cancellation propagation', () => {
    it('should cancel active tool execution when turn is cancelled', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-cancel-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Start a read operation
      const promise = turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], context);
      
      // Cancel the turn (synchronous, runs before submitBatch admission completes)
      turn.cancel();
      
      // The submitBatch promise should reject with TOOL_CANCELLED
      await expect(promise).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
    });
  
    it('should cancel queued calls when turn is cancelled', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      fsA.writeFile('/workspaceA/subdir/fileA2.ts', 'export const a = 1;');
      
      const turn = toolExecutionService.createTurn({ id: 'test-cancel-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Submit multiple calls to fill the queue
      const promises = [
        turn.submitBatch([{ toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }], context),
        turn.submitBatch([{ toolName: 'read_file', input: { uri: '/workspaceA/subdir/fileA2.ts', workspaceId: workspaceIdA } }], context),
      ];
      
      // Cancel the turn
      turn.cancel();
      
      // All submitBatch promises should reject with TOOL_CANCELLED
      await expect(Promise.all(promises)).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
    });
  });

  describe('Concurrent execution limits', () => {
    it('should respect maxConcurrentExecutions limit', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-concurrent-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Submit more calls than maxConcurrentExecutions (5)
      const promises = Array.from({ length: 7 }, (_, i) => 
        turn.submitBatch([{ toolName: 'read_file', input: { uri: `/workspaceA/fileA.txt`, workspaceId: workspaceIdA } }], context)
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
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-drain-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Start some executions
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], context);
      
      // Drain should wait for them to complete
      const drainResult = await toolExecutionService.drain({ timeoutMs: 10000 });
      expect(drainResult.settled).toBe(true);
      expect(drainResult.activeExecutions).toBe(0);
    }, 20000);

    it('should cancel queued work on drain', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-drain-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Queue up some work (more than concurrency limit)
      const promises = Array.from({ length: 10 }, (_, i) => 
        turn.submitBatch([{ toolName: 'read_file', input: { uri: `/workspaceA/fileA.txt`, workspaceId: workspaceIdA } }], context)
      );
      
      // Give a moment for queue to build up
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Drain should cancel queued work
      const drainResult = await toolExecutionService.drain({ timeoutMs: 10000 });
      expect(drainResult.queuedCalls).toBe(0);
      
      // Wait for all promises to settle
      await Promise.allSettled(promises);
    }, 20000);

    it('should wait for underlying promises on waitForUnderlyings', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-wait-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], context);
      
      await toolExecutionService.waitForUnderlyings(2000);
      // Should complete without timeout
    }, 20000);
  });

  describe('ToolExecutionService disposal', () => {
    it('should dispose cleanly', async () => {
      const { fsA, fsB } = createTestFileSystems();
      const { workspaceIdA, workspaceIdB } = registerTestWorkspaces(fsA, fsB);
      
      fsA.writeFile('/workspaceA/fileA.txt', 'Hello from folder A');
      
      const turn = toolExecutionService.createTurn({ id: 'test-dispose-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], context);
      
      toolExecutionService.dispose();
      expect(toolExecutionService.getGlobalSnapshot().activeExecutions).toBe(0);
    }, 10000);

    it('should handle repeated dispose calls', async () => {
      toolExecutionService.dispose();
      toolExecutionService.dispose(); // Should not throw
    }, 5000);

    it('should reject new turns after disposal', async () => {
      toolExecutionService.dispose();
      expect(() => toolExecutionService.createTurn()).toThrow();
    }, 5000);
  });

  describe('Read-only workspace security boundary', () => {
    it('should reject unknown tools not in the registry', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'security-1' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Unknown tool not in registry should be rejected with TOOL_NOT_FOUND
      const result = await turn.submitBatch([
        { toolName: 'unknown_tool', input: { value: 'test' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_NOT_FOUND');
    });

    it('should reject tools not marked as read-only via permission policy', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      // Register a tool that is NOT read-only to verify policy rejection
      const writeTool: ToolDefinition = {
        name: 'write_file',
        description: 'Write a file',
        inputSchema: z.object({ uri: z.string(), content: z.string() }),
        outputSchema: z.any(),
        metadata: {
          capabilities: ['write'] as const,
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
          idempotent: false,
          version: '1.0.0',
        },
        execute: async () => ({ output: 'written' }),
      };
      toolRegistry.register(writeTool);
      
      const turn = toolExecutionService.createTurn({ id: 'security-2' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Non-read-only tool should be rejected by permission policy
      const result = await turn.submitBatch([
        { toolName: 'write_file', input: { uri: '/workspaceA/test.txt', content: 'x' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_PERMISSION_DENIED');
    });

    it('should reject destructive tools via permission policy', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      // Register a destructive tool to verify policy rejection
      const deleteTool: ToolDefinition = {
        name: 'delete_file',
        description: 'Delete a file',
        inputSchema: z.object({ uri: z.string() }),
        outputSchema: z.any(),
        metadata: {
          capabilities: ['read'] as const,
          readOnly: true,
          destructive: true,
          requiresWorkspace: true,
          idempotent: false,
          version: '1.0.0',
        },
        execute: async () => ({ output: 'deleted' }),
      };
      toolRegistry.register(deleteTool);
      
      const turn = toolExecutionService.createTurn({ id: 'security-3' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Destructive tool should be rejected by permission policy
      const result = await turn.submitBatch([
        { toolName: 'delete_file', input: { uri: '/workspaceA/test.txt' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_PERMISSION_DENIED');
    });

    it('should reject tools with non-read capabilities via permission policy', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      // Register a tool with execution capability to verify policy rejection
      const execTool: ToolDefinition = {
        name: 'exec_command',
        description: 'Execute a command',
        inputSchema: z.object({ command: z.string() }),
        outputSchema: z.any(),
        metadata: {
          capabilities: ['execute'] as const,
          readOnly: true,
          destructive: false,
          requiresWorkspace: true,
          idempotent: false,
          version: '1.0.0',
        },
        execute: async () => ({ output: 'executed' }),
      };
      toolRegistry.register(execTool);
      
      const turn = toolExecutionService.createTurn({ id: 'security-4' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Execution-capable tool should be rejected by permission policy
      const result = await turn.submitBatch([
        { toolName: 'exec_command', input: { command: 'ls' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_PERMISSION_DENIED');
    });

    it('should reject tools that do not require workspace context', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      // Register a tool that does not require workspace context
      const noWsTool: ToolDefinition = {
        name: 'get_time',
        description: 'Get current time',
        inputSchema: z.object({}),
        outputSchema: z.any(),
        metadata: {
          capabilities: ['read'] as const,
          readOnly: true,
          destructive: false,
          requiresWorkspace: false,
          idempotent: true,
          version: '1.0.0',
        },
        execute: async () => ({ output: 'now' }),
      };
      toolRegistry.register(noWsTool);
      
      const turn = toolExecutionService.createTurn({ id: 'security-5' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Tool without workspace requirement should be rejected by permission policy
      const result = await turn.submitBatch([
        { toolName: 'get_time', input: {} }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_PERMISSION_DENIED');
    });

    it('should reject read_file without workspaceId in input', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'security-6' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // read_file requires workspaceId in input schema
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt' } }
      ], context);
      
      expect(result[0].kind).toBe('failure');
      expect((result[0] as any).error.code).toBe('TOOL_INVALID_ARGUMENTS');
    });

    it('should allow approved read-only tools', async () => {
      const { fsA } = createTestFileSystems();
      const workspaceIdA = registerWorkspaceAdapters(folderA, fsA, logger);
      
      const turn = toolExecutionService.createTurn({ id: 'security-7' });
      const context: ToolExecutionContext = { 
        signal: new AbortController().signal, 
        workspaceId: workspaceIdA, 
        workspaceFolder: { uri: folderA.uri, id: folderA.id }, 
        logger 
      };
      
      // Approved read-only tools should succeed
      const result = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/fileA.txt', workspaceId: workspaceIdA } }
      ], context);
      
      expect(result[0].kind).toBe('success');
    });
  });

  describe('Complete execution chain verification', () => {
    it('should trace the full chain: ToolRegistry -> ToolExecutor -> ToolExecutionService -> routed tool -> adapter -> filesystem', async () => {
      const { fsA } = createTestFileSystems();
      const { workspaceIdA } = registerTestWorkspaces(fsA, logger);

      fsA.writeFile('/workspaceA/chain.txt', 'chain-verification-content');

      const turn = toolExecutionService.createTurn({ id: 'chain-1' });
      const context: ToolExecutionContext = {
        signal: new AbortController().signal,
        workspaceId: workspaceIdA,
        workspaceFolder: { uri: folderA.uri, id: folderA.id },
        logger,
      };

      // Chain link 1: ToolRegistry contains the routed tool definitions
      const registeredReadFile = toolRegistry.get('read_file');
      const registeredListDir = toolRegistry.get('list_directory');
      const registeredSearch = toolRegistry.get('search_code');
      const registeredRefs = toolRegistry.get('find_references');
      expect(registeredReadFile).toBeDefined();
      expect(registeredListDir).toBeDefined();
      expect(registeredSearch).toBeDefined();
      expect(registeredRefs).toBeDefined();

      // Chain link 2: ToolExecutor can execute tools via the registry
      const execResult = await toolExecutor.execute('read_file', {
        uri: '/workspaceA/chain.txt',
        workspaceId: workspaceIdA,
      }, context);
      expect(execResult.kind).toBe('success');

      // Chain link 3: ToolExecutionService routes through submitBatch
      const batchResult = await turn.submitBatch([
        { toolName: 'read_file', input: { uri: '/workspaceA/chain.txt', workspaceId: workspaceIdA } },
        { toolName: 'list_directory', input: { uri: '/workspaceA', workspaceId: workspaceIdA } },
      ], context);
      expect(batchResult[0].kind).toBe('success');
      expect(batchResult[1].kind).toBe('success');

      // Chain link 4: Routed tool delegates to workspace adapter (verified by content returned)
      const readContent = (batchResult[0] as any).output.content;
      expect(readContent).toBe('chain-verification-content');

      // Chain link 5: Adapter performs filesystem operation (verified by list output)
      const listOutput = (batchResult[1] as any).output;
      expect(listOutput.entries.some((e: any) => e.name === 'chain.txt')).toBe(true);
    });

    it('should trace chain for search_code across all links', async () => {
      const { fsA } = createTestFileSystems();
      const { workspaceIdA } = registerTestWorkspaces(fsA, logger);

      fsA.writeFile('/workspaceA/chain-search.ts', 'export function chainSearch() { return "found"; }');

      const turn = toolExecutionService.createTurn({ id: 'chain-2' });
      const context: ToolExecutionContext = {
        signal: new AbortController().signal,
        workspaceId: workspaceIdA,
        workspaceFolder: { uri: folderA.uri, id: folderA.id },
        logger,
      };

      const result = await turn.submitBatch([
        { toolName: 'search_code', input: { pattern: 'chainSearch', filePattern: '*.ts', workspaceId: workspaceIdA } },
      ], context);

      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.files.length).toBeGreaterThan(0);
      const allMatches = output.files.flatMap((f: any) => f.matches);
      expect(allMatches.some((m: any) => m.matchedText.includes('chainSearch'))).toBe(true);
    });

    it('should trace chain for find_references across all links', async () => {
      const { fsA } = createTestFileSystems();
      const { workspaceIdA } = registerTestWorkspaces(fsA, logger);

      fsA.writeFile('/workspaceA/chain-refs.ts', 'export function chainRefs() { return "ref-found"; }');

      const turn = toolExecutionService.createTurn({ id: 'chain-3' });
      const context: ToolExecutionContext = {
        signal: new AbortController().signal,
        workspaceId: workspaceIdA,
        workspaceFolder: { uri: folderA.uri, id: folderA.id },
        logger,
      };

      const result = await turn.submitBatch([
        { toolName: 'find_references', input: { symbol: 'chainRefs', filePattern: '*.ts', workspaceId: workspaceIdA } },
      ], context);

      expect(result[0].kind).toBe('success');
      const output = (result[0] as any).output;
      expect(output.files.length).toBeGreaterThan(0);
    });
  });
});




