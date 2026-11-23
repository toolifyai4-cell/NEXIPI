import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import {
  makeProvider,
  makeWorkspaceFolder,
  VirtualFileSystem,
  createTestOrchestrator,
  waitForEvent,
  startScanBlockedAtAnalysis,
} from './test-helpers.js';

describe('WorkspaceScanOrchestrator lifecycle', () => {
  let provider: ReturnType<typeof makeProvider>;
  let vfs: VirtualFileSystem;
  let orchestrator: WorkspaceScanOrchestrator;

  beforeEach(() => {
    provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    orchestrator = createTestOrchestrator(provider, vfs);
  });

  afterEach(() => {
    orchestrator.dispose();
  });

  it('should start in idle state with no result', () => {
    const status = orchestrator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.disposed).toBe(false);
    expect(status.activeScanCount).toBe(0);
    expect(status.queuedScanCount).toBe(0);
    expect(orchestrator.getCurrentScanId()).toBeNull();
    expect(orchestrator.getLatestResult()).toBeNull();
    expect(orchestrator.getProgress()).toBeNull();
  });

  it('should report completed scan result', async () => {
    const result = await orchestrator.startFullScan();
    expect(result.state).toBe('completed');
    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.count).toBe(1);
    expect(orchestrator.getLatestResult()).toBe(result);
  });

  it('should transition through scanning -> completed', async () => {
    const states: string[] = [];
    const sub = orchestrator.on('scan:state-changed', (e) => {
      states.push(e.newState);
    });
    await orchestrator.startFullScan();
    sub.unsubscribe();
    expect(states).toContain('scanning');
    expect(states[states.length - 1]).toBe('completed');
  });

  it('should not report a cancelled scan as completed', async () => {
    const { promise, release } = await startScanBlockedAtAnalysis(orchestrator, vfs, () =>
      orchestrator.startFullScan()
    );
    await orchestrator.cancel(orchestrator.getCurrentScanId());
    release();
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(true);
    // The orchestrator status should not report completion.
    expect(orchestrator.getStatus().state).not.toBe('completed');
  });

  it('should not report a failed scan as completed', async () => {
    const throwingProvider = {
      getWorkspaceFolders: async () => {
        throw new Error('boom');
      },
      onWorkspaceFoldersChange: () => ({ unsubscribe: () => {} }),
      dispose: () => {},
    };
    const orch2 = createTestOrchestrator(throwingProvider as any, vfs);
    try {
      await orch2.startFullScan();
    } catch {
      // expected - workspace discovery failure propagates
    }
    const status = orch2.getStatus();
    expect(status.state).not.toBe('completed');
    orch2.dispose();
  });

  it('should be idempotent on dispose', () => {
    orchestrator.dispose();
    orchestrator.dispose();
    expect(orchestrator.getStatus().state).toBe('disposed');
  });

  it('should dispose with no active scans', () => {
    expect(() => orchestrator.dispose()).not.toThrow();
  });

  it('should cancel active scans on dispose', async () => {
    const { promise, release } = await startScanBlockedAtAnalysis(orchestrator, vfs, () =>
      orchestrator.startFullScan()
    );
    orchestrator.dispose();
    release();
    const result = await promise;
    expect(result.state).toBe('cancelled');
    expect(orchestrator.getStatus().state).toBe('disposed');
  });

  it('should cancel queued scans on dispose', async () => {
    const provider2 = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs2 = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch2 = createTestOrchestrator(provider2, vfs2, {
      config: { concurrencyPolicy: 'queue', duplicateScanBehavior: 'allow', maxConcurrentScans: 1 },
    });
    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch2,
      vfs2,
      () => orch2.startFullScan()
    );
    const p2 = orch2.startFullScan();
    expect(orch2.getStatus().queuedScanCount).toBe(1);
    orch2.dispose();
    release1();
    let rejected2 = false;
    try {
      await p2;
    } catch {
      rejected2 = true;
    }
    expect(rejected2).toBe(true);
  });

  it('should remove all event listeners on dispose', () => {
    const listener = vi.fn();
    orchestrator.on('scan:progress', listener as any);
    orchestrator.emit('scan:progress', {} as any);
    expect(listener).toHaveBeenCalled();
    orchestrator.dispose();
    const listener2 = vi.fn();
    orchestrator.on('scan:progress', listener2 as any);
    orchestrator.emit('scan:progress', {} as any);
    expect(listener2).not.toHaveBeenCalled();
  });

  it('should report index after successful scan', async () => {
    const index = orchestrator.getIndex();
    expect(index.getFileCount()).toBe(0);
    await orchestrator.startFullScan();
    expect(index.getFileCount()).toBe(1);
  });
});
