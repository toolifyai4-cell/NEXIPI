import { describe, it, expect } from 'vitest';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import {
  makeProvider,
  makeWorkspaceFolder,
  VirtualFileSystem,
  createTestOrchestrator,
  startScanBlockedAtAnalysis,
} from './test-helpers.js';

describe('WorkspaceScanOrchestrator cancellation', () => {
  it('cancel before start should be safe and return false for unknown scan', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs);

    const cancelled = await orch.cancel('unknown-scan-id' as any);
    expect(cancelled).toBe(false);
    orch.dispose();
  });

  it('cancel during discovery should produce a cancelled result', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs);

    const { promise, release } = await startScanBlockedAtAnalysis(orch, vfs, () =>
      orch.startFullScan()
    );
    await orch.cancel(orch.getCurrentScanId());
    release();
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
    orch.dispose();
  });

  it('cancel during metadata processing should cancel', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem(
      { 'a.ts': 'x', 'b.ts': 'y', 'c.ts': 'z' },
      'file:///root'
    );
    const orch2 = createTestOrchestrator(provider, vfs);

    const { promise, release } = await startScanBlockedAtAnalysis(orch2, vfs, () =>
      orch2.startFullScan()
    );
    await orch2.cancel(orch2.getCurrentScanId());
    release();
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(result.completed).toBe(false);
    orch2.dispose();
  });

  it('repeated cancellation should be safe', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs);

    const { promise, release } = await startScanBlockedAtAnalysis(orch, vfs, () =>
      orch.startFullScan()
    );
    const first = await orch.cancel(orch.getCurrentScanId());
    const second = await orch.cancel(orch.getCurrentScanId());
    const third = await orch.cancel();
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
    release();
    await promise;
    orch.dispose();
  });

  it('late event protection should not overwrite cancelled state as completed', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs);

    const { promise, release } = await startScanBlockedAtAnalysis(orch, vfs, () =>
      orch.startFullScan()
    );
    await orch.cancel(orch.getCurrentScanId());
    release();
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(result.completed).toBe(false);
    expect(orch.getStatus().state).not.toBe('completed');
    orch.dispose();
  });

  it('should not allow a cancelled scan to be reported as successful', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs);

    const { promise, release } = await startScanBlockedAtAnalysis(orch, vfs, () =>
      orch.startFullScan()
    );
    await orch.cancel();
    release();
    const result = await promise;
    expect(result.completed).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.state).toBe('cancelled');
    orch.dispose();
  });
});
