import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import type {
  WorkspaceFolder,
  WorkspaceFoldersChangeEvent,
} from '../../discovery/workspace-provider.js';
import { createWorkspaceFolderId } from '../../types.js';
import { VirtualFileSystem } from './test-helpers.js';

interface TriggerableProvider {
  getWorkspaceFolders: () => Promise<readonly WorkspaceFolder[]>;
  onWorkspaceFoldersChange: (
    listener: (event: WorkspaceFoldersChangeEvent) => void
  ) => { unsubscribe(): void };
  triggerChange: (event: WorkspaceFoldersChangeEvent) => void;
  dispose: () => void;
}

function createTriggerableProvider(initialFolders: WorkspaceFolder[]): TriggerableProvider {
  let folders = [...initialFolders];
  const listeners = new Set<(event: WorkspaceFoldersChangeEvent) => void>();

  return {
    getWorkspaceFolders: () => Promise.resolve([...folders]),
    onWorkspaceFoldersChange: (listener) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    triggerChange: (event: WorkspaceFoldersChangeEvent) => {
      for (const removed of event.removed) {
        folders = folders.filter((f) => f.uri !== removed.uri);
      }
      for (const added of event.added) {
        folders.push(added);
      }
      for (const changed of event.changed) {
        const idx = folders.findIndex((f) => f.uri === changed.uri);
        if (idx >= 0) {
          folders[idx] = changed;
        }
      }
      for (const listener of listeners) {
        listener(event);
      }
    },
    dispose: vi.fn(),
  };
}

function makeFolder(uri: string, name: string, index: number): WorkspaceFolder {
  return {
    id: createWorkspaceFolderId(uri),
    uri,
    name,
    index,
  };
}

describe('WorkspaceScanOrchestrator workspace cache invalidation', () => {
  let provider: TriggerableProvider;
  let vfs: VirtualFileSystem;
  let orchestrator: WorkspaceScanOrchestrator;

  beforeEach(async () => {
    provider = createTriggerableProvider([makeFolder('file:///rootA', 'rootA', 0)]);
    vfs = new VirtualFileSystem({ 'a.ts': 'x' }, 'file:///rootA');
    orchestrator = new WorkspaceScanOrchestrator(provider, vfs);
    await orchestrator.startFullScan();
  });

  afterEach(() => {
    orchestrator.dispose();
  });

  it('reuses the cached workspace for repeated scans when no change occurs', async () => {
    const first = orchestrator.getLatestResult()!;
    await orchestrator.startFullScan();
    const second = orchestrator.getLatestResult()!;
    expect(second.workspaceId).toBe(first.workspaceId);
  });

  it('invalidates the cache and uses the new workspace when a folder is added', async () => {
    const firstId = orchestrator.getLatestResult()!.workspaceId;

    provider.triggerChange({
      added: [makeFolder('file:///rootB', 'rootB', 1)],
      removed: [],
      changed: [],
      timestamp: Date.now(),
    });

    await orchestrator.startFullScan();
    const result = orchestrator.getLatestResult()!;

    expect(result.workspaceId).not.toBe(firstId);
    expect(result.workspaceId).toMatch(/^ws_[a-z0-9]+$/);
    expect(orchestrator.getIndex().getWorkspaceId()).toBe(result.workspaceId);
  });

  it('invalidates the cache and uses the new workspace when a folder is removed', async () => {
    provider.triggerChange({
      added: [makeFolder('file:///rootB', 'rootB', 1)],
      removed: [],
      changed: [],
      timestamp: Date.now(),
    });
    await orchestrator.startFullScan();
    const withB = orchestrator.getLatestResult()!.workspaceId;

    provider.triggerChange({
      added: [],
      removed: [makeFolder('file:///rootB', 'rootB', 1)],
      changed: [],
      timestamp: Date.now(),
    });
    await orchestrator.startFullScan();
    const result = orchestrator.getLatestResult()!;

    expect(result.workspaceId).not.toBe(withB);
  });

  it('invalidates the cache when workspace folders are replaced', async () => {
    const firstId = orchestrator.getLatestResult()!.workspaceId;

    provider.triggerChange({
      added: [makeFolder('file:///rootC', 'rootC', 0)],
      removed: [makeFolder('file:///rootA', 'rootA', 0)],
      changed: [],
      timestamp: Date.now(),
    });
    await orchestrator.startFullScan();
    const result = orchestrator.getLatestResult()!;

    expect(result.workspaceId).not.toBe(firstId);
  });

  it('disposal removes the workspace change subscription and rejects new scans', async () => {
    orchestrator.dispose();

    await expect(orchestrator.startFullScan()).rejects.toThrow();

    // Triggering a change after disposal must not throw: the subscription is
    // removed and the change handler guards against disposed state.
    expect(() =>
      provider.triggerChange({
        added: [makeFolder('file:///rootB', 'rootB', 1)],
        removed: [],
        changed: [],
        timestamp: Date.now(),
      })
    ).not.toThrow();
  });

  it('detects workspace id mismatch and requires a full scan', async () => {
    const firstId = orchestrator.getLatestResult()!.workspaceId;
    expect(orchestrator.getIndex().getWorkspaceId()).toBe(firstId);

    // A workspace id that does not match the index means incremental refresh
    // cannot be trusted and must report that a full scan is required.
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/rootA/z.ts', timestamp: Date.now() }],
      workspaceId: 'nonexistent-workspace-id',
    });

    expect(result.requiresFullScan).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.changesProcessed).toBe(0);
  });
});
