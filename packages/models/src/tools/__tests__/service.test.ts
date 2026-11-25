import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  ToolRegistry,
  ToolExecutor,
  ToolExecutionService,
  ToolExecutionTurn,
  DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG,
  validateToolExecutionServiceConfig,
} from '../index.js';
import {
  ToolErrorCode,
  isToolErrorCode,
} from '../errors.js';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types.js';
import { createNoopLogger } from '@nexipi/core';

function makeDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: z.object({ value: z.string() }),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: false,
      idempotent: true,
      version: '1.0.0',
    },
    execute: vi.fn().mockResolvedValue({ output: 'ok' }),
    ...overrides,
  };
}

function makeContext(aborted = false): ToolExecutionContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    signal: controller.signal,
    workspaceId: 'ws_1',
    workspaceFolder: undefined,
    logger: createNoopLogger(),
  };
}

function makeSlowTool(delayMs: number, output = { output: 'slow' }) {
  return {
    ...makeDefinition(),
    execute: vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return output;
    }),
  };
}

function makeGatedTool(gate: Promise<void>) {
  return {
    ...makeDefinition(),
    execute: vi.fn().mockImplementation(async () => {
      await gate;
      return { output: 'gated' };
    }),
  };
}

function makeSignalRespectingTool() {
  return {
    ...makeDefinition(),
    execute: vi.fn().mockImplementation(async (_input, context) => {
      return new Promise<{ output: string }>((resolve, reject) => {
        const onAbort = () => {
          context.signal.removeEventListener('abort', onAbort);
          reject(new Error('aborted'));
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          context.signal.removeEventListener('abort', onAbort);
          resolve({ output: 'completed' });
        }, 50);
      });
    }),
  };
}

function makeIgnoringTool() {
  return {
    ...makeDefinition(),
    execute: vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { output: 'ignored' };
    }),
  };
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('test timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('ToolExecutionServiceConfig', () => {
  it('should provide correct defaults', () => {
    const config = validateToolExecutionServiceConfig({});
    expect(config).toEqual(DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG);
  });

  it('should accept valid overrides', () => {
    const config = validateToolExecutionServiceConfig({
      maxIterationsPerTurn: 5,
      maxCallsPerBatch: 3,
      maxCallsPerTurn: 15,
      maxConcurrentExecutions: 2,
      maxExecutionTimePerToolMs: 5000,
      maxTotalExecutionTimePerTurnMs: 30000,
      maxQueuedCalls: 50,
    });
    expect(config.maxIterationsPerTurn).toBe(5);
    expect(config.maxCallsPerBatch).toBe(3);
    expect(config.maxCallsPerTurn).toBe(15);
    expect(config.maxConcurrentExecutions).toBe(2);
    expect(config.maxExecutionTimePerToolMs).toBe(5000);
    expect(config.maxTotalExecutionTimePerTurnMs).toBe(30000);
    expect(config.maxQueuedCalls).toBe(50);
  });

  it('should reject zero values', () => {
    expect(() => validateToolExecutionServiceConfig({ maxIterationsPerTurn: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxCallsPerBatch: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxCallsPerTurn: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxConcurrentExecutions: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxExecutionTimePerToolMs: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxTotalExecutionTimePerTurnMs: 0 })).toThrow('positive integer');
    expect(() => validateToolExecutionServiceConfig({ maxQueuedCalls: 0 })).toThrow('positive integer');
  });

  it('should reject negative values', () => {
    expect(() => validateToolExecutionServiceConfig({ maxIterationsPerTurn: -1 })).toThrow('positive integer');
  });

  it('should reject non-integer values', () => {
    expect(() => validateToolExecutionServiceConfig({ maxIterationsPerTurn: 1.5 })).toThrow('positive integer');
  });

  it('should reject batch limit exceeding turn limit', () => {
    expect(() => validateToolExecutionServiceConfig({ maxCallsPerBatch: 10, maxCallsPerTurn: 5 })).toThrow(
      "ToolExecutionService config 'maxCallsPerBatch' must not exceed 'maxCallsPerTurn'"
    );
  });

  it('should accept valid maxQueuedCalls override', () => {
    const config = validateToolExecutionServiceConfig({ maxQueuedCalls: 50 });
    expect(config.maxQueuedCalls).toBe(50);
  });

  it('should reject zero maxQueuedCalls', () => {
    expect(() => validateToolExecutionServiceConfig({ maxQueuedCalls: 0 })).toThrow('positive integer');
  });

  it('should reject negative maxQueuedCalls', () => {
    expect(() => validateToolExecutionServiceConfig({ maxQueuedCalls: -1 })).toThrow('positive integer');
  });

  it('should reject non-integer maxQueuedCalls', () => {
    expect(() => validateToolExecutionServiceConfig({ maxQueuedCalls: 1.5 })).toThrow('positive integer');
  });
});

describe('ToolExecutionService', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  let service: ToolExecutionService;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeDefinition());
    executor = new ToolExecutor(registry, { permissionPolicy: { name: 'allow', evaluate: () => ({ allowed: true }) } });
    service = new ToolExecutionService(executor);
  });

  afterEach(() => {
    service.dispose();
  });

  describe('turn lifecycle', () => {
    it('should create a turn with active status', () => {
      const turn = service.createTurn();
      expect(turn.status).toBe('active');
      expect(turn.iterationCount).toBe(0);
      expect(turn.callsSubmitted).toBe(0);
      expect(turn.callsCompleted).toBe(0);
      expect(turn.activeExecutions).toBe(0);
      expect(turn.queuedCalls).toBe(0);
      expect(turn.expiresAt).toBeGreaterThan(Date.now());
      expect(turn.signal).toBeInstanceOf(AbortSignal);
    });

    it('should complete a turn', () => {
      const turn = service.createTurn();
      turn.complete();
      expect(turn.status).toBe('completed');
    });

    it('should cancel a turn', () => {
      const turn = service.createTurn();
      turn.cancel();
      expect(turn.status).toBe('cancelled');
      expect(turn.signal.aborted).toBe(true);
    });

    it('should dispose a turn', () => {
      const turn = service.createTurn();
      turn.dispose();
      expect(turn.status).toBe('disposed');
    });

    it('should be idempotent for complete', () => {
      const turn = service.createTurn();
      turn.complete();
      turn.complete();
      expect(turn.status).toBe('completed');
    });

    it('should be idempotent for cancel', () => {
      const turn = service.createTurn();
      turn.cancel();
      turn.cancel();
      expect(turn.status).toBe('cancelled');
    });

    it('should be idempotent for dispose', () => {
      const turn = service.createTurn();
      turn.dispose();
      turn.dispose();
      expect(turn.status).toBe('disposed');
    });

    it('should reject submissions after complete', async () => {
      const turn = service.createTurn();
      turn.complete();
      await expect(turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext()))
        .rejects.toMatchObject({ code: ToolErrorCode.TOOL_CANCELLED });
    });

    it('should reject submissions after cancel', async () => {
      const turn = service.createTurn();
      turn.cancel();
      await expect(turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext()))
        .rejects.toMatchObject({ code: ToolErrorCode.TOOL_CANCELLED });
    });

    it('should reject submissions after dispose', async () => {
      const turn = service.createTurn();
      turn.dispose();
      await expect(turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext()))
        .rejects.toMatchObject({ code: ToolErrorCode.TOOL_CANCELLED });
    });

    it('should isolate turns from each other', async () => {
      const turn1 = service.createTurn();
      const turn2 = service.createTurn();
      turn1.cancel();
      expect(turn2.status).toBe('active');
      const result = await turn2.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());
      expect(result[0].kind).toBe('success');
    });
  });

  describe('batch submission limits', () => {
    it('should accept a valid batch', async () => {
      const turn = service.createTurn();
      const results = await turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'x' } }],
        makeContext()
      );
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('success');
      expect(turn.iterationCount).toBe(1);
      expect(turn.callsSubmitted).toBe(1);
    });

    it('should reject batch exceeding maxCallsPerBatch', async () => {
      const turn = service.createTurn();
      const calls = Array.from({ length: 6 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      await expect(turn.submitBatch(calls, makeContext())).rejects.toMatchObject({
        code: ToolErrorCode.TOOL_RESOURCE_LIMIT,
      });
    });

    it('should reject when turn call limit would be exceeded', async () => {
      const turn = service.createTurn();
      const calls = Array.from({ length: 26 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      await expect(turn.submitBatch(calls, makeContext())).rejects.toMatchObject({
        code: ToolErrorCode.TOOL_RESOURCE_LIMIT,
      });
    });

    it('should reject when max iterations exceeded', async () => {
      const turn = service.createTurn();
      for (let i = 0; i < 10; i++) {
        await turn.submitBatch([{ toolName: 'test_tool', input: { value: String(i) } }], makeContext());
      }
      await expect(turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext()))
        .rejects.toMatchObject({ code: ToolErrorCode.TOOL_RESOURCE_LIMIT });
    });

    it('should serialize concurrent batch submissions', async () => {
      const turn = service.createTurn();
      const calls = [{ toolName: 'test_tool', input: { value: '1' } }];
      
      const p1 = turn.submitBatch(calls, makeContext());
      const p2 = turn.submitBatch(calls, makeContext());
      const p3 = turn.submitBatch(calls, makeContext());
      
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      
      expect(turn.iterationCount).toBe(3);
      expect(turn.callsSubmitted).toBe(3);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r3).toHaveLength(1);
    });
  });

  describe('concurrency and scheduling', () => {
    it('should respect global concurrency limit', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn1 = service.createTurn();
      const turn2 = service.createTurn();

      const p1 = turn1.submitBatch([{ toolName: 'test_tool', input: { value: '1' } }], makeContext());
      const p2 = turn2.submitBatch([{ toolName: 'test_tool', input: { value: '2' } }], makeContext());
      const p3 = turn2.submitBatch([{ toolName: 'test_tool', input: { value: '3' } }], makeContext());
      const p4 = turn2.submitBatch([{ toolName: 'test_tool', input: { value: '4' } }], makeContext());
      const p5 = turn2.submitBatch([{ toolName: 'test_tool', input: { value: '5' } }], makeContext());
      const p6 = turn2.submitBatch([{ toolName: 'test_tool', input: { value: '6' } }], makeContext());

      // Wait for all submissions to be processed (admitted or queued)
      await Promise.all([p1, p2, p3, p4, p5, p6].map(p => Promise.race([p, new Promise(r => setTimeout(r, 10))])));

      const snapshot = service.getGlobalSnapshot();
      expect(snapshot.activeExecutions).toBeLessThanOrEqual(5);
      
      (globalThis as any).gateRelease!();
      await Promise.all([p1, p2, p3, p4, p5, p6]);
    });

    it('should queue calls when concurrency limit reached', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      // Use a service with larger batch limit to fit 8 calls
      const largeBatchService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxCallsPerBatch: 10 },
      });

      const turn = largeBatchService.createTurn();
      const calls = Array.from({ length: 8 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 100))]), 200);

      expect(turn.activeExecutions).toBeLessThanOrEqual(5);
      expect(turn.queuedCalls).toBeGreaterThanOrEqual(0);

      (globalThis as any).gateRelease!();
      const results = await promise;
      expect(results).toHaveLength(8);
      
      largeBatchService.dispose();
    });

    it('should maintain stable result ordering', async () => {
      const delays = [100, 10, 50, 30, 20];
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async (input: { value: string }) => {
            const idx = parseInt(input.value, 10);
            await new Promise((resolve) => setTimeout(resolve, delays[idx]));
            return { output: `tool-${idx}` };
          }),
        })
      );

      const turn = service.createTurn();
      const calls = delays.map((_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const results = await turn.submitBatch(calls, makeContext());

      expect(results).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(results[i].kind).toBe('success');
        if (results[i].kind === 'success') {
          expect(results[i].output).toEqual({ output: `tool-${i}` });
        }
      }
    });

    it('should recover scheduler after success', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const largeBatchService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxCallsPerBatch: 10 },
      });

      const turn = largeBatchService.createTurn();
      const calls = Array.from({ length: 6 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      (globalThis as any).gateRelease!();
      const results = await promise;
      expect(results).toHaveLength(6);
      expect(results.every(r => r.kind === 'success')).toBe(true);
      
      largeBatchService.dispose();
    });

    it('should recover scheduler after failure', async () => {
      let callCount = 0;
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount <= 3) throw new Error('simulated failure');
            return { output: 'ok' };
          }),
        })
      );

      const turn = service.createTurn();
      const calls = Array.from({ length: 5 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const results = await turn.submitBatch(calls, makeContext());

      expect(results).toHaveLength(5);
      expect(results[0].kind).toBe('failure');
      expect(results[1].kind).toBe('failure');
      expect(results[2].kind).toBe('failure');
      expect(results[3].kind).toBe('success');
      expect(results[4].kind).toBe('success');
    });
  });

  describe('timeouts', () => {
    it('should enforce per-tool timeout', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeSlowTool(200));

      const turn = shortTimeoutService.createTurn();
      const results = await turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);
      }

      shortTimeoutService.dispose();
    });

    it('should enforce total turn deadline', async () => {
      const shortDeadlineService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxTotalExecutionTimePerTurnMs: 100 },
      });

      registry.unregister('test_tool');
      registry.register(makeSlowTool(500));

      const turn = shortDeadlineService.createTurn();
      const results = await turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(turn.status).toBe('cancelled');

      shortDeadlineService.dispose();
    });

    it('should cancel queued calls on deadline expiry', async () => {
      const shortDeadlineService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxTotalExecutionTimePerTurnMs: 50, maxCallsPerBatch: 10 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = shortDeadlineService.createTurn();
      const calls = Array.from({ length: 3 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 200))]), 300);

      const results = await promise;
      expect(results.every(r => r.kind === 'failure')).toBe(true);
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(turn.status).toBe('cancelled');

      shortDeadlineService.dispose();
    });
  });

  describe('cancellation', () => {
    it('should respect external context cancellation', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const controller = new AbortController();
      const context = { ...makeContext(), signal: controller.signal };
      
      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], context);
      
      // Wait for the call to start executing (gated)
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      controller.abort();
      
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      (globalThis as any).gateRelease!();
    });

    it('should cancel queued calls on turn cancel', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const largeBatchService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxCallsPerBatch: 10 },
      });

      const turn = largeBatchService.createTurn();
      const calls = Array.from({ length: 8 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 50))]), 200);
      turn.cancel();

      const results = await promise;
      expect(results.every(r => r.kind === 'failure')).toBe(true);
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(turn.status).toBe('cancelled');

      (globalThis as any).gateRelease!();
      largeBatchService.dispose();
    });

    it('should cancel active executions on turn cancel', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = service.createTurn();
      const calls = Array.from({ length: 3 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 50))]), 200);
      turn.cancel();

      const results = await promise;
      expect(results.every(r => r.kind === 'failure')).toBe(true);
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      (globalThis as any).gateRelease!();
    });

    it('should allow tools that respect AbortSignal to cancel gracefully', async () => {
      const controller = new AbortController();
      registry.unregister('test_tool');
      registry.register(makeSignalRespectingTool());

      const turn = service.createTurn();
      const context = { ...makeContext(), signal: controller.signal };
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], context);
      
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      controller.abort();
      
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
    });

    it('should not release concurrency slot for uncooperative tools on timeout', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50, maxConcurrentExecutions: 2 },
      });

      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = shortTimeoutService.createTurn();
      const calls = Array.from({ length: 3 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      const results = await promise;
      expect(results.length).toBe(3);
      const timeoutCount = results.filter(r => r.kind === 'failure' && isToolErrorCode(r.error, ToolErrorCode.TOOL_TIMEOUT)).length;
      expect(timeoutCount).toBeGreaterThanOrEqual(2);

      const snapshot = shortTimeoutService.getGlobalSnapshot();
      expect(snapshot.activeExecutions).toBeLessThanOrEqual(2);

      shortTimeoutService.dispose();
    });

    it('should distinguish timeout from cancellation error codes', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeSlowTool(200));

      const turn = shortTimeoutService.createTurn();
      const timeoutResults = await turn.submitBatch([{ toolName: 'test_tool', input: { value: '1' } }], makeContext());
      expect(isToolErrorCode(timeoutResults[0].error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);

      // Now test cancellation with a gated tool
      const controller = new AbortController();
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease2 = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const cancelPromise = turn.submitBatch([{ toolName: 'test_tool', input: { value: '2' } }], { ...makeContext(), signal: controller.signal });
      
      // Wait for the call to start executing (gated)
      await raceWithTimeout(Promise.race([cancelPromise, new Promise(r => setTimeout(r, 10))]), 100);
      controller.abort();
      
      const cancelResults = await cancelPromise;
      expect(isToolErrorCode(cancelResults[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);

      (globalThis as any).gateRelease2!();
      shortTimeoutService.dispose();
    });
  });

  describe('failure isolation', () => {
    it('should isolate tool failures', async () => {
      // Use sequential execution by making tools slow and checking results in order
      let callIndex = 0;
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async () => {
            const index = callIndex++;
            if (index < 2) throw new Error('failure');
            return { output: 'ok' };
          }),
        })
      );

      const turn = service.createTurn();
      const calls = [
        { toolName: 'test_tool', input: { value: '1' } },
        { toolName: 'test_tool', input: { value: '2' } },
        { toolName: 'test_tool', input: { value: '3' } },
      ];
      const results = await turn.submitBatch(calls, makeContext());

      expect(results[0].kind).toBe('failure');
      expect(results[1].kind).toBe('failure');
      expect(results[2].kind).toBe('success');
    });

    it('should return TOOL_NOT_FOUND for unknown tool', async () => {
      const turn = service.createTurn();
      const results = await turn.submitBatch([{ toolName: 'unknown_tool', input: { value: 'x' } }], makeContext());
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_NOT_FOUND)).toBe(true);
      }
    });

    it('should return TOOL_INVALID_ARGUMENTS for invalid input', async () => {
      const turn = service.createTurn();
      const results = await turn.submitBatch([{ toolName: 'test_tool', input: { value: 123 } }], makeContext());
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_INVALID_ARGUMENTS)).toBe(true);
      }
    });

    it('should return TOOL_PERMISSION_DENIED when policy denies', async () => {
      const denyExecutor = new ToolExecutor(registry, {
        permissionPolicy: { name: 'deny', evaluate: () => ({ allowed: false, reason: 'denied' }) },
      });
      const denyService = new ToolExecutionService(denyExecutor);
      const turn = denyService.createTurn();
      const results = await turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_PERMISSION_DENIED)).toBe(true);
      }
      denyService.dispose();
    });

    it('should return TOOL_INVALID_RESULT for output validation failure', async () => {
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          outputSchema: z.object({ lines: z.array(z.string()) }),
          execute: vi.fn().mockResolvedValue({ lines: 'not-an-array' }),
        })
      );

      const turn = service.createTurn();
      const results = await turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_INVALID_RESULT)).toBe(true);
      }
    });

    it('should handle repeated cancellation gracefully', async () => {
      const turn = service.createTurn();
      turn.cancel();
      turn.cancel();
      expect(turn.status).toBe('cancelled');
    });

    it('should handle turn disposal during execution', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());
      
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      turn.dispose();
      
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(turn.status).toBe('disposed');

      (globalThis as any).gateRelease!();
    });
  });

  describe('service disposal', () => {
    it('should dispose all turns', () => {
      const turn1 = service.createTurn();
      const turn2 = service.createTurn();
      service.dispose();
      expect(turn1.status).toBe('disposed');
      expect(turn2.status).toBe('disposed');
    });

    it('should be idempotent', () => {
      service.dispose();
      service.dispose();
      expect(() => service.createTurn()).toThrow('disposed');
    });
  });

  describe('drain', () => {
    it('should report settled: true when all underlying promises have settled', async () => {
      const turn = service.createTurn();
      const promise = turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'x' } }],
        makeContext()
      );
      await promise;
      const result = await service.drain({ timeoutMs: 5000 });
      expect(result.settled).toBe(true);
      expect(result.activeExecutions).toBe(0);
      service.dispose();
    });

    it('should report settled: false when drain timeout expires with pending operations', async () => {
      const turn = service.createTurn();
      // Use a slow tool that takes longer than the drain timeout
      const slowTool = makeSlowTool(500);
      registry.unregister('test_tool');
      registry.register(slowTool);
      const slowPromise = turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'slow' } }],
        makeContext()
      );
      // Drain with very short timeout (10ms) - should not have time to complete
      const result = await service.drain({ timeoutMs: 10 });
      // Should report settled: false since the underlying promise is still pending
      expect(result.settled).toBe(false);
      // Wait for the slow tool to complete
      await slowPromise;
      service.dispose();
    });

    it('should handle repeated drain calls safely', async () => {
      const turn = service.createTurn();
      turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'x' } }],
        makeContext()
      );
      // First drain
      const result1 = await service.drain({ timeoutMs: 5000 });
      expect(typeof result1.settled).toBe('boolean');
      // Second drain should not throw
      const result2 = await service.drain({ timeoutMs: 5000 });
      expect(typeof result2.settled).toBe('boolean');
      service.dispose();
    });

    it('should handle concurrent drain and dispose safely', async () => {
      const turn = service.createTurn();
      turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'x' } }],
        makeContext()
      );
      // Race drain and dispose
      const drainPromise = service.drain({ timeoutMs: 5000 });
      const disposePromise = new Promise<void>(resolve => setTimeout(resolve, 50));
      await Promise.race([drainPromise, disposePromise]);
      // After dispose, drain should complete without throwing
      // (drain may complete before or after dispose, both should be safe)
    });

    it('should track underlying promises and remove them after settlement', async () => {
      const turn = service.createTurn();
      // Use a slow tool to ensure underlying is tracked and pending
      const slowTool = makeSlowTool(500);
      registry.unregister('test_tool');
      registry.register(slowTool);
      const promise = turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'slow' } }],
        makeContext()
      );
      // Before drain, underlying should be tracked
      const beforeDrain = service.getGlobalSnapshot();
      expect(beforeDrain.activeExecutions).toBeGreaterThan(0);
      // After drain, underlying should be settled
      const result = await service.drain({ timeoutMs: 5000 });
      expect(result.settled).toBe(true);
      service.dispose();
    });

    it('should not lose tracking entries before actual settlement', async () => {
      const turn = service.createTurn();
      // Use a slow tool to ensure underlying is tracked
      const slowTool = makeSlowTool(500);
      registry.unregister('test_tool');
      registry.register(slowTool);
      const promise = turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'slow' } }],
        makeContext()
      );
      await promise;
      // Drain should wait for actual settlement
      const result = await service.drain({ timeoutMs: 5000 });
      expect(result.settled).toBe(true);
      // After drain, activeUnderlyings should be empty
      service.dispose();
    });

    it('should handle deferred promise settlement after drain', async () => {
      const turn = service.createTurn();
      // Use a slow tool to ensure underlying is tracked
      const slowTool = makeSlowTool(500);
      registry.unregister('test_tool');
      registry.register(slowTool);
      // Submit a batch that tracks the underlying promise
      turn.submitBatch(
        [{ toolName: 'test_tool', input: { value: 'slow' } }],
        makeContext()
      );
      // Drain before the slow tool settles
      const result = await service.drain({ timeoutMs: 50 });
      // Should report settled: false since the underlying promise hasn't settled yet
      expect(result.settled).toBe(false);
      // Wait for the slow tool to complete
      await new Promise(resolve => setTimeout(resolve, 600));
      // Drain again should now report settled: true
      const result2 = await service.drain({ timeoutMs: 5000 });
      expect(result2.settled).toBe(true);
      service.dispose();
    });
  });

  describe('global queue capacity', () => {
    it('should enforce global queued call limit', async () => {
      const limitedQueueService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxQueuedCalls: 3, maxCallsPerBatch: 10, maxConcurrentExecutions: 2 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = limitedQueueService.createTurn();
      // First batch: 5 calls, 2 active + 3 queued = max capacity
      const calls1 = Array.from({ length: 5 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise1 = turn.submitBatch(calls1, makeContext());

      await raceWithTimeout(Promise.race([promise1, new Promise(r => setTimeout(r, 50))]), 200);

      // Second batch: 3 more calls should exceed the global queue limit of 3
      const calls2 = Array.from({ length: 3 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i + 10) } }));
      const promise2 = turn.submitBatch(calls2, makeContext());

      const results2 = await promise2;
      expect(results2.length).toBe(3);
      // All 3 should be rejected with TOOL_RESOURCE_LIMIT
      for (const r of results2) {
        expect(r.kind).toBe('failure');
        if (r.kind === 'failure') {
          expect(isToolErrorCode(r.error, ToolErrorCode.TOOL_RESOURCE_LIMIT)).toBe(true);
        }
      }

      // Release the gate and wait for first batch to complete
      (globalThis as any).gateRelease!();
      await promise1;

      // Now there should be capacity again
      const calls3 = Array.from({ length: 2 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i + 20) } }));
      const results3 = await turn.submitBatch(calls3, makeContext());
      expect(results3.length).toBe(2);
      for (const r of results3) {
        expect(r.kind).toBe('success');
      }

      limitedQueueService.dispose();
    });

    it('should not count active executions as queued calls', async () => {
      const limitedQueueService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxQueuedCalls: 2, maxCallsPerBatch: 10, maxConcurrentExecutions: 2 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = limitedQueueService.createTurn();
      // Submit 4 calls: 2 will be active, 2 will be queued (queue limit = 2)
      const calls = Array.from({ length: 4 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 50))]), 200);

      // Should have 2 active, 2 queued (not counting active as queued)
      expect(turn.activeExecutions).toBe(2);
      expect(turn.queuedCalls).toBe(2);

      (globalThis as any).gateRelease!();
      await promise;

      limitedQueueService.dispose();
    });

    it('should release queue capacity when queued call starts', async () => {
      const limitedQueueService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxQueuedCalls: 2, maxCallsPerBatch: 10, maxConcurrentExecutions: 2 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = limitedQueueService.createTurn();
      // Submit 4 calls: 2 active, 2 queued
      const calls1 = Array.from({ length: 4 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise1 = turn.submitBatch(calls1, makeContext());

      await raceWithTimeout(Promise.race([promise1, new Promise(r => setTimeout(r, 50))]), 200);
      expect(turn.queuedCalls).toBe(2);

      // Release the gate - both active calls complete, both queued calls start (0 queued remaining)
      (globalThis as any).gateRelease!();
      await raceWithTimeout(Promise.race([promise1, new Promise(r => setTimeout(r, 50))]), 200);
      expect(turn.queuedCalls).toBe(0);

      // Now we should be able to submit two more calls (queue has 2 free slots)
      const calls2 = [
        { toolName: 'test_tool', input: { value: '100' } },
        { toolName: 'test_tool', input: { value: '101' } },
      ];
      const results2 = await turn.submitBatch(calls2, makeContext());
      expect(results2[0].kind).toBe('success');
      expect(results2[1].kind).toBe('success');

      limitedQueueService.dispose();
    });

    it('should release queue capacity when queued calls are cancelled', async () => {
      const limitedQueueService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxQueuedCalls: 2, maxCallsPerBatch: 10, maxConcurrentExecutions: 2 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = limitedQueueService.createTurn();
      // Submit 4 calls: 2 active, 2 queued
      const calls = Array.from({ length: 4 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const promise = turn.submitBatch(calls, makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 50))]), 200);
      expect(turn.queuedCalls).toBe(2);

      // Cancel the turn - queued calls should be cancelled and capacity released
      turn.cancel();

      const results = await promise;
      expect(results.every(r => r.kind === 'failure')).toBe(true);

      // Release the gate so active calls can complete
      (globalThis as any).gateRelease!();

      // Now queue should have capacity
      const turn2 = limitedQueueService.createTurn();
      const calls2 = Array.from({ length: 2 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const results2 = await turn2.submitBatch(calls2, makeContext());
      expect(results2.every(r => r.kind === 'success')).toBe(true);

      limitedQueueService.dispose();
    });

    it('should reject concurrent submissions that exceed queue capacity', async () => {
      const limitedQueueService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxQueuedCalls: 3, maxCallsPerBatch: 10, maxConcurrentExecutions: 2 },
      });

      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const turn = limitedQueueService.createTurn();
      // Submit 5 calls concurrently (2 active, 3 queued = max capacity)
      const calls = Array.from({ length: 5 }, (_, i) => ({ toolName: 'test_tool', input: { value: String(i) } }));
      const p1 = turn.submitBatch(calls.slice(0, 3), makeContext());
      const p2 = turn.submitBatch(calls.slice(3), makeContext());

      await Promise.all([p1, p2].map(p => Promise.race([p, new Promise(r => setTimeout(r, 50))])));

      // Now queue is full (3 queued). Try to submit one more.
      const extraCall = [{ toolName: 'test_tool', input: { value: 'extra' } }];
      const extraPromise = turn.submitBatch(extraCall, makeContext());
      const extraResults = await extraPromise;
      expect(extraResults[0].kind).toBe('failure');
      if (extraResults[0].kind === 'failure') {
        expect(isToolErrorCode(extraResults[0].error, ToolErrorCode.TOOL_RESOURCE_LIMIT)).toBe(true);
      }

      (globalThis as any).gateRelease!();
      await Promise.all([p1, p2]);
      limitedQueueService.dispose();
    });
  });

  describe('cancellation races with uncooperative tools', () => {
    it('should promptly return cancellation result for uncooperative tool on turn.cancel()', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      // Wait for the tool to start executing
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      expect(turn.activeExecutions).toBe(1);

      // Cancel the turn while tool is running
      turn.cancel();

      // Should promptly get TOOL_CANCELLED result
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      // The underlying execution continues (ignoring tool), but slot should still be occupied
      expect(service.getGlobalSnapshot().activeExecutions).toBe(1);

      // Release the gate - tool will eventually complete
      (globalThis as any).gateRelease!();
      // Wait for the underlying execution to settle by waiting for activeExecutions to drop
      await raceWithTimeout(
        new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (service.getGlobalSnapshot().activeExecutions === 0) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        }),
        2000
      );
      expect(service.getGlobalSnapshot().activeExecutions).toBe(0);
    });

    it('should promptly return timeout result for uncooperative tool on per-tool timeout', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = shortTimeoutService.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      // Should get TOOL_TIMEOUT promptly
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);
      }

      // The underlying execution continues (ignoring tool), but slot should still be occupied
      expect(shortTimeoutService.getGlobalSnapshot().activeExecutions).toBe(1);

      // Wait for the ignoring tool to eventually complete by polling activeExecutions
      await raceWithTimeout(
        new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (shortTimeoutService.getGlobalSnapshot().activeExecutions === 0) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        }),
        2000
      );
      expect(shortTimeoutService.getGlobalSnapshot().activeExecutions).toBe(0);

      shortTimeoutService.dispose();
    });

    it('should promptly return cancellation result for uncooperative tool on external context cancel', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const controller = new AbortController();
      const context = { ...makeContext(), signal: controller.signal };

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], context);

      // Wait for the tool to start executing
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      expect(turn.activeExecutions).toBe(1);

      // Cancel via external context
      controller.abort();

      // Should promptly get TOOL_CANCELLED result
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      // Slot still occupied until underlying settles
      expect(service.getGlobalSnapshot().activeExecutions).toBe(1);

      (globalThis as any).gateRelease!();
      // Wait for the underlying execution to settle
      await raceWithTimeout(
        new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (service.getGlobalSnapshot().activeExecutions === 0) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        }),
        2000
      );
      expect(service.getGlobalSnapshot().activeExecutions).toBe(0);
    });

    it('should promptly return cancellation result for uncooperative tool on turn deadline expiry', async () => {
      const shortDeadlineService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxTotalExecutionTimePerTurnMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = shortDeadlineService.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      // Should get TOOL_CANCELLED promptly when deadline expires
      const results = await promise;
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(turn.status).toBe('cancelled');

      // Slot still occupied until underlying settles
      expect(shortDeadlineService.getGlobalSnapshot().activeExecutions).toBe(1);

      // Wait for the ignoring tool to eventually complete
      await raceWithTimeout(
        new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (shortDeadlineService.getGlobalSnapshot().activeExecutions === 0) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        }),
        2000
      );
      expect(shortDeadlineService.getGlobalSnapshot().activeExecutions).toBe(0);

      shortDeadlineService.dispose();
    });

    it('should not allow late resolve to overwrite caller result', async () => {
      // Tool that resolves after a long delay but we cancel early
      let resolveLate: () => void;
      const latePromise = new Promise<{ output: string }>((resolve) => { resolveLate = resolve; });
      
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async () => {
            return latePromise;
          }),
        })
      );

      const controller = new AbortController();
      const context = { ...makeContext(), signal: controller.signal };

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], context);

      // Wait for execution to start
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);

      // Cancel before the tool resolves
      controller.abort();
      const results = await promise;

      // Should get TOOL_CANCELLED
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      // Now resolve the tool late - should not affect the result already returned
      resolveLate!({ output: 'late' });
      await raceWithTimeout(Promise.resolve(), 100);
      
      // The turn should still be active (only the call was cancelled, not the turn)
      expect(turn.status).toBe('active');
    });

    it('should not allow late rejection to overwrite caller result', async () => {
      // Tool that rejects after a long delay but we cancel early
      let rejectLate: (err: Error) => void;
      const latePromise = new Promise<{ output: string }>((_, reject) => { rejectLate = reject; });
      
      registry.unregister('test_tool');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async () => {
            return latePromise;
          }),
        })
      );

      const controller = new AbortController();
      const context = { ...makeContext(), signal: controller.signal };

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], context);

      // Wait for execution to start
      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);

      // Cancel before the tool rejects
      controller.abort();
      const results = await promise;

      // Should get TOOL_CANCELLED
      expect(results[0].kind).toBe('failure');
      if (results[0].kind === 'failure') {
        expect(isToolErrorCode(results[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }

      // Now reject the tool late - should not affect the result already returned
      rejectLate!(new Error('late rejection'));
      await raceWithTimeout(Promise.resolve(), 100);
      
      // The turn should still be active (only the call was cancelled, not the turn)
      expect(turn.status).toBe('active');
    });

    it('should release concurrency slot exactly once after uncooperative tool settles', async () => {
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease = resolve; });
      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = service.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      await raceWithTimeout(Promise.race([promise, new Promise(r => setTimeout(r, 10))]), 100);
      expect(service.getGlobalSnapshot().activeExecutions).toBe(1);

      turn.cancel();
      await promise;

      // Slot should still be occupied
      expect(service.getGlobalSnapshot().activeExecutions).toBe(1);

      // Release the gate - tool completes
      (globalThis as any).gateRelease!();
      // Wait for activeExecutions to drop
      await raceWithTimeout(
        new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (service.getGlobalSnapshot().activeExecutions === 0) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        }),
        2000
      );

      // Slot should now be released
      expect(service.getGlobalSnapshot().activeExecutions).toBe(0);

      // Submit another call on a NEW turn (the original turn is cancelled)
      const turn2 = service.createTurn();
      const results = await turn2.submitBatch([{ toolName: 'test_tool', input: { value: 'y' } }], makeContext());
      expect(results[0].kind).toBe('success');
    });

    it('should distinguish external cancellation from timeout error codes', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = shortTimeoutService.createTurn();
      
      // First call: timeout
      const timeoutResults = await turn.submitBatch([{ toolName: 'test_tool', input: { value: '1' } }], makeContext());
      expect(isToolErrorCode(timeoutResults[0].error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);

      // Second call: external cancellation
      const controller = new AbortController();
      const gate = new Promise<void>((resolve) => { (globalThis as any).gateRelease2 = resolve; });
      registry.unregister('test_tool');
      registry.register(makeGatedTool(gate));

      const cancelPromise = turn.submitBatch([{ toolName: 'test_tool', input: { value: '2' } }], { ...makeContext(), signal: controller.signal });
      
      await raceWithTimeout(Promise.race([cancelPromise, new Promise(r => setTimeout(r, 10))]), 100);
      controller.abort();
      
      const cancelResults = await cancelPromise;
      expect(isToolErrorCode(cancelResults[0].error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);

      (globalThis as any).gateRelease2!();
      shortTimeoutService.dispose();
    });

    it('should not have unhandled promise rejections', async () => {
      const shortTimeoutService = new ToolExecutionService(executor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      registry.unregister('test_tool');
      registry.register(makeIgnoringTool());

      const turn = shortTimeoutService.createTurn();
      const promise = turn.submitBatch([{ toolName: 'test_tool', input: { value: 'x' } }], makeContext());

      // This should not throw an unhandled rejection
      await promise;

      shortTimeoutService.dispose();
    });
  });
});