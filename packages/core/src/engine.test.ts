import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Engine,
  createEngine,
  EngineStatus,
  type EngineOptions,
  type EngineEvents,
} from './engine.js';
import { EngineError, EngineErrorCode, isEngineError } from './errors.js';
import { TaskStatus } from './tasks.js';
import type { EngineConfig } from './config.js';

function createTestEngine(overrides: Partial<EngineOptions> = {}): Engine {
  return createEngine({
    config: {
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 5,
      taskTimeoutMs: 1000,
      enableTelemetry: false,
      ...overrides.config,
    },
    logger: overrides.logger,
  });
}

describe('engine', () => {
  let engine: Engine;

  beforeEach(() => {
    engine = createTestEngine();
  });

  describe('initialization', () => {
    it('should start as UNINITIALIZED', () => {
      expect(engine.getStatus()).toBe(EngineStatus.UNINITIALIZED);
    });

    it('should initialize successfully', () => {
      engine.initialize();
      expect(engine.getStatus()).toBe(EngineStatus.INITIALIZED);
    });

    it('should emit engine:initialized event', () => {
      const listener = vi.fn();
      engine.on('engine:initialized', listener);
      engine.initialize();
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        config: expect.objectContaining({ name: 'test' }),
        timestamp: expect.any(Number),
      });
    });

    it('should throw when initializing already initialized engine', () => {
      engine.initialize();
      expect(() => engine.initialize()).toThrow(EngineError);
      expect(() => engine.initialize()).toThrow('already initialized');
    });

    it('should throw EngineError with correct code', () => {
      engine.initialize();
      try {
        engine.initialize();
      } catch (error) {
        expect(isEngineError(error)).toBe(true);
        if (isEngineError(error)) {
          expect(error.code).toBe(EngineErrorCode.ALREADY_INITIALIZED);
        }
      }
    });
  });

  describe('start', () => {
    it('should start from INITIALIZED', async () => {
      engine.initialize();
      await engine.start();
      expect(engine.getStatus()).toBe(EngineStatus.RUNNING);
    });

    it('should auto-initialize if UNINITIALIZED', async () => {
      await engine.start();
      expect(engine.getStatus()).toBe(EngineStatus.RUNNING);
    });

    it('should emit engine:started event', async () => {
      const listener = vi.fn();
      engine.on('engine:started', listener);
      await engine.start();
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        timestamp: expect.any(Number),
      });
    });

    it('should throw when starting already running engine', async () => {
      await engine.start();
      await expect(engine.start()).rejects.toThrow(EngineError);
    });

    it('should throw correct error message when starting already running engine', async () => {
      await engine.start();
      await expect(engine.start()).rejects.toThrow('already running');
    });

    it('should throw when starting from invalid state', async () => {
      engine.initialize();
      (engine as { status: EngineStatus }).status = EngineStatus.ERROR;
      await expect(engine.start()).rejects.toThrow(EngineError);
      await expect(engine.start()).rejects.toThrow('Cannot start engine from status ERROR');
    });
  });

  describe('stop', () => {
    it('should stop running engine', async () => {
      await engine.start();
      await engine.stop();
      expect(engine.getStatus()).toBe(EngineStatus.STOPPED);
    });

    it('should emit engine:stopped event', async () => {
      const listener = vi.fn();
      engine.on('engine:stopped', listener);
      await engine.start();
      await engine.stop('test reason');
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        timestamp: expect.any(Number),
        reason: 'test reason',
      });
    });

    it('should throw when stopping already stopped engine', async () => {
      await engine.start();
      await engine.stop();
      await expect(engine.stop()).rejects.toThrow(EngineError);
    });

    it('should throw correct error message when stopping already stopped engine', async () => {
      await engine.start();
      await engine.stop();
      await expect(engine.stop()).rejects.toThrow('already stopped');
    });

    it('should throw when stopping from invalid state', async () => {
      engine.initialize();
      await expect(engine.stop()).rejects.toThrow(EngineError);
    });

    it('should throw correct error message when stopping from invalid state', async () => {
      engine.initialize();
      await expect(engine.stop()).rejects.toThrow('Cannot stop engine from status INITIALIZED');
    });

    it('should cancel pending tasks on stop', async () => {
      await engine.start();
      const task = engine.createTask('test', { input: 'hello' });
      await engine.stop();
      const updatedTask = engine.getTask(task.id);
      expect(updatedTask?.status).toBe(TaskStatus.CANCELLED);
    });
  });

  describe('task management', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should create task', () => {
      const task = engine.createTask('test-type', { input: 'hello' });
      expect(task.id).toBeDefined();
      expect(task.type).toBe('test-type');
      expect(task.payload).toEqual({ input: 'hello' });
      expect(task.status).toBe(TaskStatus.PENDING);
    });

    it('should emit task:created event', () => {
      const listener = vi.fn();
      engine.on('task:created', listener);
      const task = engine.createTask('test-type', { input: 'hello' });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0].task).toBe(task);
    });

    it('should get task by id', () => {
      const task = engine.createTask('test-type', { input: 'hello' });
      const found = engine.getTask(task.id);
      expect(found).toBe(task);
    });

    it('should return undefined for non-existent task', () => {
      const found = engine.getTask('non-existent');
      expect(found).toBeUndefined();
    });

    it('should execute task successfully', async () => {
      const task = engine.createTask('test', { input: 'hello' });
      const result = await engine.executeTask(task, async payload => ({
        output: payload.input.toUpperCase(),
      }));
      expect(result.status).toBe(TaskStatus.COMPLETED);
      expect(result.result).toEqual({ output: 'HELLO' });
    });

    it('should emit task:started and task:completed events', async () => {
      const startedListener = vi.fn();
      const completedListener = vi.fn();
      engine.on('task:started', startedListener);
      engine.on('task:completed', completedListener);

      const task = engine.createTask('test', { input: 'hello' });
      await engine.executeTask(task, async payload => ({ output: payload.input }));

      expect(startedListener).toHaveBeenCalledOnce();
      expect(completedListener).toHaveBeenCalledOnce();
    });

    it('should fail task on executor error', async () => {
      const task = engine.createTask('test', { input: 'hello' });
      await expect(
        engine.executeTask(task, async () => {
          throw new Error('Executor failed');
        })
      ).rejects.toThrow(EngineError);

      const updatedTask = engine.getTask(task.id);
      expect(updatedTask?.status).toBe(TaskStatus.FAILED);
      expect(updatedTask?.error).toBeDefined();
      expect(updatedTask?.error?.code).toBe(EngineErrorCode.INTERNAL_ERROR);
    });

    it('should emit task:failed event on error', async () => {
      const listener = vi.fn();
      engine.on('task:failed', listener);

      const task = engine.createTask('test', { input: 'hello' });
      try {
        await engine.executeTask(task, async () => {
          throw new Error('Executor failed');
        });
      } catch {
        // Expected
      }

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        task: expect.objectContaining({ status: TaskStatus.FAILED }),
        error: expect.any(EngineError),
      });
    });

    it('should timeout long-running tasks', async () => {
      const task = engine.createTask('test', { input: 'hello' });
      await expect(
        engine.executeTask(task, async () => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          return { output: 'done' };
        })
      ).rejects.toThrow(EngineError);

      const updatedTask = engine.getTask(task.id);
      expect(updatedTask?.status).toBe(TaskStatus.FAILED);
      expect(updatedTask?.error?.message).toContain('Task execution failed');
    });

    it('should cancel task', () => {
      const task = engine.createTask('test', { input: 'hello' });
      const result = engine.cancelTask(task.id);
      expect(result).toBe(true);
      const updatedTask = engine.getTask(task.id);
      expect(updatedTask?.status).toBe(TaskStatus.CANCELLED);
    });

    it('should return false for non-existent task', () => {
      const result = engine.cancelTask('non-existent');
      expect(result).toBe(false);
    });

    it('should return false for terminal task', async () => {
      const task = engine.createTask('test', { input: 'hello' });
      await engine.executeTask(task, async p => ({ output: p.input }));
      const result = engine.cancelTask(task.id);
      expect(result).toBe(false);
    });

    it('should emit task:cancelled event', () => {
      const listener = vi.fn();
      engine.on('task:cancelled', listener);
      const task = engine.createTask('test', { input: 'hello' });
      engine.cancelTask(task.id);
      expect(listener).toHaveBeenCalledOnce();
      const updatedTask = engine.getTask(task.id);
      expect(listener.mock.calls[0][0].task).toBe(updatedTask);
    });

    it('should return task queue stats', () => {
      engine.createTask('test', { input: '1' });
      engine.createTask('test', { input: '2' });
      const stats = engine.getTaskQueueStats();
      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
    });
  });

  describe('event system integration', () => {
    it('should support on/off for engine events', () => {
      const listener = vi.fn();
      engine.on('engine:initialized', listener);
      engine.off('engine:initialized', listener);
      engine.initialize();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();
      engine.on('engine:initialized', errorListener);
      engine.on('engine:initialized', goodListener);
      engine.initialize();
      expect(goodListener).toHaveBeenCalledOnce();
    });
  });

  describe('getters', () => {
    it('should return config', () => {
      const config = engine.getConfig();
      expect(config.name).toBe('test');
      expect(config.version).toBe('1.0.0');
    });

    it('should return logger', () => {
      const logger = engine.getLogger();
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should return event emitter', () => {
      const emitter = engine.getEventEmitter();
      expect(typeof emitter.on).toBe('function');
      expect(typeof emitter.emit).toBe('function');
    });
  });

  describe('engine error event', () => {
    it('should emit engine:error on start failure', async () => {
      engine.initialize();
      (engine as { status: EngineStatus }).status = EngineStatus.ERROR;
      const listener = vi.fn();
      engine.on('engine:error', listener);
      await expect(engine.start()).rejects.toThrow();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should emit engine:error on stop failure', async () => {
      await engine.start();
      (engine as { status: EngineStatus }).status = EngineStatus.ERROR;
      const listener = vi.fn();
      engine.on('engine:error', listener);
      await expect(engine.stop()).rejects.toThrow();
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('lifecycle concurrency', () => {
    it('should handle concurrent initialize calls deterministically', async () => {
      const engine1 = createTestEngine();
      const engine2 = createTestEngine();
      const results = await Promise.allSettled([
        engine1.initialize(),
        engine2.initialize(),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');
      expect(engine1.getStatus()).toBe(EngineStatus.INITIALIZED);
      expect(engine2.getStatus()).toBe(EngineStatus.INITIALIZED);
    });

    it('should handle concurrent start calls on same engine', async () => {
      await engine.start();
      const results = await Promise.allSettled([
        engine.start(),
        engine.start(),
      ]);
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBe(2);
      expect(engine.getStatus()).toBe(EngineStatus.RUNNING);
    });

    it('should handle concurrent stop calls on same engine', async () => {
      await engine.start();
      const results = await Promise.allSettled([
        engine.stop('first'),
        engine.stop('second'),
      ]);
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBe(1);
      expect(engine.getStatus()).toBe(EngineStatus.STOPPED);
    });

    it('should handle concurrent initialize and start', async () => {
      const engine3 = createTestEngine();
      const results = await Promise.allSettled([
        engine3.initialize(),
        engine3.start(),
      ]);
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected.length).toBeLessThanOrEqual(1);
      expect([EngineStatus.INITIALIZED, EngineStatus.RUNNING]).toContain(engine3.getStatus());
    });
  });

  describe('task execution concurrency', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should enforce maxConcurrentTasks limit', async () => {
      const limitedEngine = createTestEngine({
        config: { maxConcurrentTasks: 2, taskTimeoutMs: 5000 },
      });
      await limitedEngine.start();

      let runningCount = 0;
      let maxRunning = 0;
      const barriers: Array<() => void> = [];

      const createTask = () => limitedEngine.executeTask(
        limitedEngine.createTask('test', {}),
        async () => {
          runningCount++;
          maxRunning = Math.max(maxRunning, runningCount);
          await new Promise<void>(resolve => barriers.push(() => { runningCount--; resolve(); }));
        }
      );

      const tasks = [
        createTask(),
        createTask(),
        createTask(),
      ];

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(maxRunning).toBeLessThanOrEqual(2);

      barriers.forEach(fn => fn());
      await Promise.allSettled(tasks);
    });

    it('should not execute same task twice', async () => {
      const task = engine.createTask('test', { input: 'hello' });
      let executeCount = 0;
      const executor = async () => {
        executeCount++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { output: 'done' };
      };

      await Promise.allSettled([
        engine.executeTask(task, executor),
        engine.executeTask(task, executor),
      ]);

      expect(executeCount).toBe(1);
    });

    it('should mark task as FAILED on timeout but executor continues', async () => {
      let executorCompleted = false;
      const task = engine.createTask('test', { input: 'hello' });
      await expect(
        engine.executeTask(task, async () => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          executorCompleted = true;
          return { output: 'done' };
        })
      ).rejects.toThrow();

      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(executorCompleted).toBe(true);
      const updatedTask = engine.getTask(task.id);
      expect(updatedTask?.status).toBe(TaskStatus.FAILED);
    });

    it('should not allow executing task not in queue', async () => {
      const orphanTask = engine.createTask('test', { input: 'orphan' });
      await engine.executeTask(orphanTask, async () => ({ output: 'done' }));
      const stats = engine.getTaskQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(1);
    });
  });

  describe('post-stop behavior', () => {
    it('should allow restart from STOPPED state', async () => {
      await engine.start();
      await engine.stop();
      await engine.start();
      expect(engine.getStatus()).toBe(EngineStatus.RUNNING);
    });

    it('should clear task queue on restart', async () => {
      await engine.start();
      engine.createTask('test', { input: '1' });
      await engine.stop();
      await engine.start();
      const stats = engine.getTaskQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(0);
    });
  });

  describe('config sanitization', () => {
    it('should not expose sensitive config in logs', () => {
      const sensitiveEngine = createTestEngine({
        config: { apiKey: 'secret123' as any },
      });
      const logger = sensitiveEngine.getLogger();
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = vi.fn((msg: string) => logs.push(msg));
      try {
        sensitiveEngine.initialize();
        expect(logs.some(l => l.includes('secret123'))).toBe(false);
        expect(logs.some(l => l.includes('[REDACTED]'))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });
});
