import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { Logger } from '@nexipi/shared';
import { WorkspaceManager } from '../workspace-manager.js';
import { VSCodeWorkspaceProvider } from '../vscode-workspace-provider.js';
import { VSCodeFileSystemProvider } from '../vscode-file-system-provider.js';

const mockFs = {
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  stat: vi.fn(),
};

function makeVsFolder(uri: string, name: string, index: number) {
  return { uri, name, index } as unknown as vscode.WorkspaceFolder;
}

function makeFakeUri(uriString: string) {
  const schemeMatch = uriString.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    const path = uriString.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return { scheme, path, toString: () => uriString } as unknown as vscode.Uri;
  }
  // No scheme: real VS Code Uri.parse returns an empty scheme.
  return { scheme: '', path: uriString, toString: () => uriString } as unknown as vscode.Uri;
}

function setupWorkspaceApi(initialFolders: vscode.WorkspaceFolder[]) {
  let folders = [...initialFolders];
  const listeners = new Set<(event: any) => void>();
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    get: () => folders,
    configurable: true,
  });
  vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mockImplementation((listener) => {
    listeners.add(listener);
    return { dispose: vi.fn() };
  });
  return {
    setFolders: (next: vscode.WorkspaceFolder[]) => {
      folders = [...next];
    },
    fireChange: (event: any) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function setupWatcherApi() {
  const watcher = {
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    onDidRename: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };
  vi.mocked(vscode.workspace.createFileSystemWatcher).mockReturnValue(watcher as any);
  (vscode.RelativePattern as any) = vi.fn();
  (vscode.Uri as any) = {
    parse: vi.fn((uri: string) => makeFakeUri(uri)),
  };
  return watcher;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('WorkspaceManager', () => {
  let logger: Logger;
  let api: ReturnType<typeof setupWorkspaceApi>;
  let watcher: ReturnType<typeof setupWatcherApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    mockFs.readFile.mockReset();
    mockFs.readDirectory.mockReset();
    mockFs.stat.mockReset();
    mockFs.readDirectory.mockResolvedValue([]);
    mockFs.stat.mockResolvedValue({ type: 1, size: 0, mtime: 0, ctime: 0 });
    mockFs.readFile.mockResolvedValue(Buffer.from(''));
    api = setupWorkspaceApi([makeVsFolder('file:///rootA', 'rootA', 0)]);
    watcher = setupWatcherApi();
    (vscode.workspace as any).fs = mockFs;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createManager(debounceMs = 0) {
    const provider = new VSCodeWorkspaceProvider();
    const fileSystem = new VSCodeFileSystemProvider();
    return new WorkspaceManager(provider, fileSystem, { logger, debounceMs });
  }

  function orchestratorOf(manager: WorkspaceManager) {
    return (manager as unknown as { orchestrator: { requestIncrementalRefresh: ReturnType<typeof vi.fn> } })
      .orchestrator;
  }

  it('initializes exactly once and creates watchers per folder', async () => {
    const manager = createManager();
    await manager.initialize();

    expect(manager.getStatus().initialized).toBe(true);
    expect(manager.getStatus().disposed).toBe(false);
    expect(vscode.workspace.onDidChangeWorkspaceFolders).toHaveBeenCalled();
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
    manager.dispose();
  });

  it('repeated initialization does not duplicate subscriptions or watchers', async () => {
    const manager = createManager();
    await manager.initialize();
    const subscriptionCalls = vscode.workspace.onDidChangeWorkspaceFolders.mock.calls.length;
    const watcherCalls = vscode.workspace.createFileSystemWatcher.mock.calls.length;

    await manager.initialize();
    await manager.initialize();

    expect(manager.getStatus().initialized).toBe(true);
    expect(vscode.workspace.onDidChangeWorkspaceFolders.mock.calls.length).toBe(subscriptionCalls);
    expect(vscode.workspace.createFileSystemWatcher.mock.calls.length).toBe(watcherCalls);
    manager.dispose();
  });

  it('handles a workspace-less environment', async () => {
    api.setFolders([]);
    const manager = createManager();
    await manager.initialize();
    expect(manager.getStatus().initialized).toBe(true);
    expect(manager.getWorkspaceId()).toBeNull();
    manager.dispose();
  });

  it('coordinates a full scan and exposes status and progress', async () => {
    const manager = createManager();
    const result = await manager.startFullScan();

    expect(result.workspaceId).toBeDefined();
    expect(result.workspaceId).toMatch(/^ws_[a-z0-9]+$/);
    expect(manager.getLatestScanResult()).toBe(result);
    expect(manager.getWorkspaceId()).toBe(result.workspaceId);

    const status = manager.getStatus();
    expect(status.workspaceId).toBe(result.workspaceId);
    expect(typeof status.orchestrator.activeScanCount).toBe('number');
    manager.dispose();
  });

  it('handles workspace folder changes by reconciling watchers and rescanning', async () => {
    const manager = createManager();
    await manager.initialize();

    const scanSpy = vi.spyOn(manager, 'startFullScan');

    api.fireChange({
      added: [makeVsFolder('file:///rootB', 'rootB', 1)],
      removed: [],
      changed: [],
      timestamp: 1000,
    });

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    expect(scanSpy).toHaveBeenCalled();

    manager.dispose();
  });

  it('cancellation is safe and returns a boolean', async () => {
    const manager = createManager();
    // No scan started: cancelling is safe and returns false.
    expect(await manager.cancel()).toBe(false);
    expect(await manager.cancel('unknown-scan-id')).toBe(false);
    manager.dispose();
  });

  it('error handling: provider failure during initialization propagates', async () => {
    vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mockImplementationOnce(() => {
      throw new Error('provider failure');
    });
    const manager = createManager();
    await expect(manager.initialize()).rejects.toThrow('provider failure');
  });

  it('disposal is idempotent and disposes owned resources exactly once', async () => {
    const manager = createManager();
    await manager.initialize();

    manager.dispose();
    expect(manager.getStatus().disposed).toBe(true);
    expect(manager.getStatus().initialized).toBe(false);
    expect(watcher.dispose).toHaveBeenCalled();

    manager.dispose();
    expect(watcher.dispose).toHaveBeenCalledTimes(1);
  });

  it('incremental refresh falls back to full scan when the index is stale', async () => {
    const manager = createManager();
    const refreshSpy = vi.spyOn(orchestratorOf(manager), 'requestIncrementalRefresh');

    const result = await manager.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/rootA/z.ts', timestamp: Date.now() }],
      workspaceId: 'nonexistent-workspace-id',
    });

    expect(result.requiresFullScan).toBe(true);
    expect(result.applied).toBe(false);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('debounces watcher events and flushes a single incremental refresh batch', async () => {
    vi.useFakeTimers();
    const manager = createManager(50);
    const refreshSpy = vi.spyOn(orchestratorOf(manager), 'requestIncrementalRefresh');
    // Prevent the flush's full-scan fallback from running a real scan.
    vi.spyOn(manager, 'startFullScan').mockResolvedValue({
      workspaceId: 'ws_stub',
    } as any);

    manager.onWatcherEvent({
      type: 'created',
      absolutePath: 'file:///rootA/a.ts',
      timestamp: Date.now(),
    });
    manager.onWatcherEvent({
      type: 'changed',
      absolutePath: 'file:///rootA/a.ts',
      timestamp: Date.now(),
    });

    expect(refreshSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const call = refreshSpy.mock.calls[0][0];
    expect(call.changes).toHaveLength(1);
    expect(call.changes[0].type).toBe('changed'); // latest wins

    vi.useRealTimers();
    manager.dispose();
  });

  it('exposes status changes to listeners for UI integration', async () => {
    const manager = createManager();
    const statuses: any[] = [];
    const sub = manager.onStatusChange((status) => statuses.push(status));

    await manager.initialize();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0].initialized).toBe(true);

    sub.dispose();
    manager.dispose();
  });

  /* ======================== URI / Windows path regression ======================== */

  function assertNormalizedPath(uri: string, expected: string) {
    vi.useFakeTimers();
    const manager = createManager(50);
    const refreshSpy = vi.spyOn(orchestratorOf(manager), 'requestIncrementalRefresh');
    // Prevent the flush's full-scan fallback from running a real scan on a
    // manager that is about to be disposed.
    vi.spyOn(manager, 'startFullScan').mockResolvedValue({
      workspaceId: 'ws_stub',
    } as any);
    manager.onWatcherEvent({ type: 'created', absolutePath: uri, timestamp: Date.now() });
    expect(refreshSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const call = refreshSpy.mock.calls[0][0];
    expect(call.changes[0].absolutePath).toBe(expected);
    refreshSpy.mockRestore();
    vi.useRealTimers();
    manager.dispose();
  }

  it('normalizes Windows drive-letter file URIs correctly', async () => {
    assertNormalizedPath('file:///C:/Users/test/project/file.ts', '/C:/Users/test/project/file.ts');
  });

  it('normalizes Windows paths containing spaces', async () => {
    assertNormalizedPath('file:///C:/Users/test/my project/file.ts', '/C:/Users/test/my project/file.ts');
  });

  it('normalizes Windows paths with percent-encoded characters', async () => {
    assertNormalizedPath('file:///C:/Users/test/my%20project/file.ts', '/C:/Users/test/my%20project/file.ts');
  });

  it('normalizes Windows paths with non-ASCII characters', async () => {
    assertNormalizedPath('file:///C:/Users/test/プロジェクト/file.ts', '/C:/Users/test/プロジェクト/file.ts');
  });

  it('preserves Unix file URIs with leading slash', async () => {
    assertNormalizedPath('file:///root/a.ts', '/root/a.ts');
  });

  it('preserves remote and virtual URI schemes unchanged', async () => {
    assertNormalizedPath('ssh://remote/home/user/project', 'ssh://remote/home/user/project');
    assertNormalizedPath('vscode-remote://remote+ssh/home/user/project', 'vscode-remote://remote+ssh/home/user/project');
  });

  it('normalizes rename old and new paths consistently', async () => {
    vi.useFakeTimers();
    const manager = createManager(50);
    const refreshSpy = vi.spyOn(orchestratorOf(manager), 'requestIncrementalRefresh');
    vi.spyOn(manager, 'startFullScan').mockResolvedValue({
      workspaceId: 'ws_stub',
    } as any);

    manager.onWatcherEvent({
      type: 'renamed',
      absolutePath: 'file:///C:/Users/test/project/new.ts',
      previousAbsolutePath: 'file:///C:/Users/test/project/old.ts',
      timestamp: Date.now(),
    });

    expect(refreshSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const call = refreshSpy.mock.calls[0][0];
    expect(call.changes).toHaveLength(1);
    expect(call.changes[0].type).toBe('renamed');
    expect(call.changes[0].absolutePath).toBe('/C:/Users/test/project/new.ts');
    expect(call.changes[0].previousAbsolutePath).toBe('/C:/Users/test/project/old.ts');

    refreshSpy.mockRestore();
    vi.useRealTimers();
    manager.dispose();
  });

  it('does not double-decode percent-encoded paths', async () => {
    // %25 is an encoded '%'. The path component preserves encoding; no manual decode.
    assertNormalizedPath('file:///C:/Users/test/my%25project/file.ts', '/C:/Users/test/my%25project/file.ts');
  });

  it('round-trips through filesystem provider consistently', async () => {
    const manager = createManager();
    const fsReadSpy = vi.spyOn(mockFs, 'readFile').mockResolvedValue(Buffer.from('x'));

    const fileSystem = new VSCodeFileSystemProvider();
    await fileSystem.readFile('/C:/Users/test/project/file.ts');

    expect(fsReadSpy).toHaveBeenCalledTimes(1);
    const calledUri = fsReadSpy.mock.calls[0][0];
    expect(calledUri.toString()).toBe('file:///C:/Users/test/project/file.ts');

    fsReadSpy.mockRestore();
    manager.dispose();
  });

  // Access the module-private function for round-trip testing.
  function toWorkspaceAbsolutePathForTest(uriString: string): string {
    const uri = vscode.Uri.parse(uriString);
    if (uri.scheme === 'file') {
      return uri.path.replace(/\\/g, '/').replace(/\/+$/, '');
    }
    return uriString;
  }
});
