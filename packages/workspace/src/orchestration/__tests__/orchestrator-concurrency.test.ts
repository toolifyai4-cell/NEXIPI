import { describe, it, expect } from 'vitest';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import {
  makeProvider,
  makeWorkspaceFolder,
  VirtualFileSystem,
  createTestOrchestrator,
  startScanBlockedAtAnalysis,
  flushMicrotasks,
} from './test-helpers.js';

describe('WorkspaceScanOrchestrator concurrency', () => {
  it('cancel-previous should cancel the active scan before starting a new one', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'cancel-previous', maxConcurrentScans: 1, duplicateScanBehavior: 'allow' },
    });

    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );

    // Starting a second scan cancels the first (cancel-previous).
    const p2 = orch.startFullScan();
    const result1 = await p1;
    expect(result1.state).toBe('cancelled');
    expect(result1.cancelled).toBe(true);
    expect(result1.completed).toBe(false);

    release1();
    const result2 = await p2;
    expect(result2.state).toBe('completed');
    orch.dispose();
  });

  it('queue should execute scans sequentially', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'queue', maxConcurrentScans: 1, duplicateScanBehavior: 'allow' },
    });

    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );

    const p2 = orch.startFullScan();
    await flushMicrotasks();
    expect(orch.getStatus().queuedScanCount).toBe(1);

    release1();
    const r1 = await p1;
    expect(r1.state).toBe('completed');

    const r2 = await p2;
    expect(r2.state).toBe('completed');
    orch.dispose();
  });

  it('allow-all should run scans concurrently up to the limit', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'allow-all', maxConcurrentScans: 2, duplicateScanBehavior: 'allow' },
    });

    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );
    const p2 = orch.startFullScan();
    await flushMicrotasks();
    expect(orch.getStatus().activeScanCount).toBe(2);

    release1();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.state).toBe('completed');
    expect(r2.state).toBe('completed');
    orch.dispose();
  });

  it('queue should reject with QueueOverflowError when the queue is full', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'queue', maxConcurrentScans: 1, maxQueuedScans: 1, duplicateScanBehavior: 'allow' },
    });

    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );

    const p2 = orch.startFullScan();
    await flushMicrotasks();
    expect(orch.getStatus().queuedScanCount).toBe(1);

    let overflowed = false;
    try {
      await orch.startFullScan();
    } catch (error) {
      overflowed = true;
      expect(error.message).toContain('queue is full');
    }
    expect(overflowed).toBe(true);

    release1();
    await p1;
    await p2;
    orch.dispose();
  });

  it('allow-all should enforce the concurrent scan limit', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'allow-all', maxConcurrentScans: 1, duplicateScanBehavior: 'allow' },
    });

    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );

    const p2 = orch.startFullScan();
    await flushMicrotasks();
    expect(orch.getStatus().queuedScanCount).toBe(1);

    release1();
    await p1;
    await p2;
    orch.dispose();
  });

  it('should cancel one scan without cancelling unrelated scans', async () => {
    const provider = makeProvider([makeWorkspaceFolder('file:///root', 'root', 0)]);
    const vfs = new VirtualFileSystem({ src: { 'main.ts': 'x' } }, 'file:///root');
    const orch = createTestOrchestrator(provider, vfs, {
      config: { concurrencyPolicy: 'allow-all', maxConcurrentScans: 2, duplicateScanBehavior: 'allow' },
    });

    const started: string[] = [];
    const sub = orch.on('scan:started', (e) => started.push(e.scanId));
    const { promise: p1, release: release1 } = await startScanBlockedAtAnalysis(
      orch,
      vfs,
      () => orch.startFullScan()
    );
    const p2 = orch.startFullScan();
    await flushMicrotasks();
    expect(started.length).toBe(2);

    await orch.cancel(started[0]!);
    release1();
    const r1 = await p1.catch(() => ({ state: 'cancelled' } as any));
    const r2 = await p2;
    expect(r1.state).toBe('cancelled');
    expect(r2.state).toBe('completed');
    sub.unsubscribe();
    orch.dispose();
  });
});
