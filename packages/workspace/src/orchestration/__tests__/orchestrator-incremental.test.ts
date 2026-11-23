import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import {
  makeProvider,
  makeWorkspaceFolder,
  VirtualFileSystem,
  createTestOrchestrator,
} from './test-helpers.js';

describe('WorkspaceScanOrchestrator incremental refresh', () => {
  let provider: ReturnType<typeof makeProvider>;
  let vfs: VirtualFileSystem;
  let orchestrator: WorkspaceScanOrchestrator;

  beforeEach(async () => {
    provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    vfs = new VirtualFileSystem({ 'a.ts': 'x', 'b.ts': 'y' }, 'file:///root');
    orchestrator = createTestOrchestrator(provider, vfs);
    await orchestrator.startFullScan();
  });

  afterEach(() => {
    orchestrator.dispose();
  });

  it('should add a created file to the index', async () => {
    const vfs2 = new VirtualFileSystem({ 'a.ts': 'x', 'b.ts': 'y', 'd.ts': 'd' }, 'file:///root');
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const orch2 = createTestOrchestrator(provider2, vfs2);
    await orch2.startFullScan();

    const result = await orch2.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/root/d.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(result.filesAdded).toBe(1);
    expect(orch2.getIndex().getByPath('/root/d.ts')).toBeDefined();
    orch2.dispose();
  });

  it('should refresh metadata for a changed file', async () => {
    const before = orchestrator.getIndex().getByPath('/root/a.ts');
    expect(before).toBeDefined();
    const originalMtime = before!.mtime;

    // Change stat (mtime) without changing VFS content; stat is driven by VFS stats map.
    // Update the VFS stat for a.ts.
    (vfs as any).setStat('/root/a.ts', { type: 'file', size: 999, mtime: 1700000000000 });

    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'changed', absolutePath: '/root/a.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(result.filesChanged).toBe(1);
    const after = orchestrator.getIndex().getByPath('/root/a.ts');
    expect(after?.size).toBe(999);
    expect(after?.mtime).toBe(1700000000000);
  });

  it('should remove a deleted file from the index', async () => {
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'deleted', absolutePath: '/root/a.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(result.filesRemoved).toBe(1);
    expect(orchestrator.getIndex().getByPath('/root/a.ts')).toBeUndefined();
    expect(orchestrator.getIndex().getByPath('/root/b.ts')).toBeDefined();
  });

  it('should handle a rename by removing old and adding new', async () => {
    // Add c.ts first so rename target exists.
    const vfs2 = new VirtualFileSystem({ 'a.ts': 'x', 'c.ts': 'z', 'd.ts': 'd' }, 'file:///root');
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const orch2 = createTestOrchestrator(provider2, vfs2);
    await orch2.startFullScan();

    const result = await orch2.requestIncrementalRefresh({
      changes: [
        {
          type: 'renamed',
          absolutePath: '/root/d.ts',
          previousAbsolutePath: '/root/c.ts',
          timestamp: Date.now(),
        },
      ],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(orch2.getIndex().getByPath('/root/c.ts')).toBeUndefined();
    expect(orch2.getIndex().getByPath('/root/d.ts')).toBeDefined();
    orch2.dispose();
  });

  it('should ignore excluded files on create', async () => {
    const vfs2 = new VirtualFileSystem({ 'a.ts': 'x', 'node_modules': { 'pkg': { 'index.js': 'x' } } }, 'file:///root');
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const orch2 = createTestOrchestrator(provider2, vfs2);
    await orch2.startFullScan();

    const result = await orch2.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/root/node_modules/pkg/index.js', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(result.filesAdded).toBe(0);
    expect(orch2.getIndex().getByPath('/root/node_modules/pkg/index.js')).toBeUndefined();
    orch2.dispose();
  });

  it('should reject paths outside the workspace', async () => {
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/outside/evil.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain('outside the associated workspace');
    expect(orchestrator.getIndex().getByPath('/outside/evil.ts')).toBeUndefined();
  });

  it('should require a full scan when there is no prior index', async () => {
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs2 = new VirtualFileSystem({ 'a.ts': 'x' }, 'file:///root');
    const orch2 = createTestOrchestrator(provider2, vfs2);
    // No startFullScan called, index is empty.

    const result = await orch2.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/root/a.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(true);
    expect(result.applied).toBe(false);
    orch2.dispose();
  });

  it('should handle duplicate notifications safely', async () => {
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [
        { type: 'deleted', absolutePath: '/root/a.ts', timestamp: Date.now() },
        { type: 'deleted', absolutePath: '/root/a.ts', timestamp: Date.now() },
      ],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(orchestrator.getIndex().getByPath('/root/a.ts')).toBeUndefined();
  });

  it('should handle stale delete events without corrupting the index', async () => {
    const beforeCount = orchestrator.getIndex().getFileCount();
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'deleted', absolutePath: '/root/nonexistent.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    expect(orchestrator.getIndex().getFileCount()).toBe(beforeCount);
    expect(result.errors.length).toBe(0);
  });

  it('should preserve the existing index after a failed change', async () => {
    const beforeCount = orchestrator.getIndex().getFileCount();
    const beforeFile = orchestrator.getIndex().getByPath('/root/b.ts');
    expect(beforeFile).toBeDefined();

    // Change a path that cannot be statted (does not exist in VFS).
    const result = await orchestrator.requestIncrementalRefresh({
      changes: [{ type: 'changed', absolutePath: '/root/missing.ts', timestamp: Date.now() }],
    });
    expect(result.requiresFullScan).toBe(false);
    // The change produced an error but the index is preserved.
    expect(orchestrator.getIndex().getFileCount()).toBe(beforeCount);
    expect(orchestrator.getIndex().getByPath('/root/b.ts')).toBe(beforeFile);
  });

  it('should handle created then deleted as a net no-op', async () => {
    const vfs2 = new VirtualFileSystem({ 'a.ts': 'x', 'temp.ts': 't' }, 'file:///root');
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const orch2 = createTestOrchestrator(provider2, vfs2);
    await orch2.startFullScan();

    await orch2.requestIncrementalRefresh({
      changes: [{ type: 'created', absolutePath: '/root/temp.ts', timestamp: Date.now() }],
    });
    expect(orch2.getIndex().getByPath('/root/temp.ts')).toBeDefined();

    await orch2.requestIncrementalRefresh({
      changes: [{ type: 'deleted', absolutePath: '/root/temp.ts', timestamp: Date.now() }],
    });
    expect(orch2.getIndex().getByPath('/root/temp.ts')).toBeUndefined();
    expect(orch2.getIndex().getFileCount()).toBe(2); // back to a.ts and b.ts
    orch2.dispose();
  });
});
