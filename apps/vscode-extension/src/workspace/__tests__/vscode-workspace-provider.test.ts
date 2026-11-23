import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { VSCodeWorkspaceProvider } from '../vscode-workspace-provider.js';
import type { WorkspaceFolder, WorkspaceFoldersChangeEvent } from '@nexipi/workspace';

function makeVsFolder(uri: string, name: string, index: number): vscode.WorkspaceFolder {
  return { uri, name, index } as unknown as vscode.WorkspaceFolder;
}

function mockWorkspaceProviderApi(initialFolders: vscode.WorkspaceFolder[]) {
  let folders = [...initialFolders];
  const listeners = new Set<(event: vscode.WorkspaceFoldersChangeEvent) => void>();
  vi.mocked(vscode.workspace.workspaceFolders); // ensure mocked
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    get: () => folders,
    configurable: true,
  });
  vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders).mockImplementation((listener) => {
    listeners.add(listener);
    const dispose = vi.fn(() => listeners.delete(listener));
    return { dispose };
  });
  return {
    setFolders: (next: vscode.WorkspaceFolder[]) => {
      folders = [...next];
    },
    fireChange: (event: vscode.WorkspaceFoldersChangeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('VSCodeWorkspaceProvider', () => {
  let api: ReturnType<typeof mockWorkspaceProviderApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = mockWorkspaceProviderApi([
      makeVsFolder('file:///rootA', 'rootA', 0),
      makeVsFolder('file:///rootB', 'rootB', 1),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers workspace folders with stable URIs and indices', async () => {
    const provider = new VSCodeWorkspaceProvider();
    const folders = await provider.getWorkspaceFolders();

    expect(folders).toHaveLength(2);
    expect(folders[0]).toMatchObject({
      uri: 'file:///rootA',
      name: 'rootA',
      index: 0,
    });
    expect(folders[1]).toMatchObject({
      uri: 'file:///rootB',
      name: 'rootB',
      index: 1,
    });
    expect(typeof folders[0].id).toBe('string');
    expect(folders[0].id.length).toBeGreaterThan(0);
  });

  it('returns an empty array for a workspace-less environment', async () => {
    api.setFolders([]);
    const provider = new VSCodeWorkspaceProvider();
    const folders = await provider.getWorkspaceFolders();
    expect(folders).toHaveLength(0);
  });

  it('preserves non-file (remote/virtual) URIs unchanged', async () => {
    api.setFolders([
      makeVsFolder('ssh://remote/home/user/project', 'remote', 0),
    ]);
    const provider = new VSCodeWorkspaceProvider();
    const folders = await provider.getWorkspaceFolders();
    expect(folders[0].uri).toBe('ssh://remote/home/user/project');
    expect(folders[0].name).toBe('remote');
  });

  it('forwards folder added/removed/changed events', () => {
    const provider = new VSCodeWorkspaceProvider();
    const events: WorkspaceFoldersChangeEvent[] = [];
    const sub = provider.onWorkspaceFoldersChange((event) => events.push(event));

    const added: WorkspaceFolder = {
      id: 'folder_remote' as any,
      uri: 'file:///rootC',
      name: 'rootC',
      index: 2,
    };
    const removed: WorkspaceFolder = {
      id: 'folder_a' as any,
      uri: 'file:///rootA',
      name: 'rootA',
      index: 0,
    };

    api.fireChange({
      added: [added as any],
      removed: [removed as any],
      changed: [],
      timestamp: 123,
    });

    expect(events).toHaveLength(1);
    expect(events[0].added).toHaveLength(1);
    expect(events[0].added[0].uri).toBe('file:///rootC');
    expect(events[0].removed).toHaveLength(1);
    expect(events[0].removed[0].uri).toBe('file:///rootA');
    expect(events[0].timestamp).toBeGreaterThan(0);

    sub.unsubscribe();
    api.fireChange({ added: [], removed: [], changed: [], timestamp: 124 });
    expect(events).toHaveLength(1); // no new events after unsubscribe
  });

  it('dispose is idempotent and releases the subscription', () => {
    const provider = new VSCodeWorkspaceProvider();
    provider.onWorkspaceFoldersChange(() => {});
    const disposable = vi.mocked(vscode.workspace.onDidChangeWorkspaceFolders)
      .mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> };

    provider.dispose();
    expect(disposable.dispose).toHaveBeenCalled();

    // Second dispose is a no-op.
    provider.dispose();
    expect(disposable.dispose).toHaveBeenCalledTimes(1);
  });
});
