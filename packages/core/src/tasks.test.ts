import { describe, it, expect } from 'vitest';
import {
  TaskStatus,
  type TaskId,
  type TaskPayload,
  type TaskResult,
  createTask,
  startTask,
  completeTask,
  failTask,
  cancelTask,
  isTaskTerminal,
  isTaskActive,
  TaskQueue,
  createTaskQueue,
} from './tasks.js';
import { EngineError, EngineErrorCode } from './errors.js';

interface TestPayload extends TaskPayload {
  input: string;
}

interface TestResult extends TaskResult {
  output: string;
}

describe('tasks', () => {
  describe('createTask', () => {
    it('should create task with generated id', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(task.id).toBeDefined();
      expect(typeof task.id).toBe('string');
      expect(task.id.length).toBeGreaterThan(0);
    });

    it('should create task with custom id', () => {
      const task = createTask<TestPayload, TestResult>({
        id: 'custom-id',
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(task.id).toBe('custom-id');
    });

    it('should set initial status to PENDING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(task.status).toBe(TaskStatus.PENDING);
    });

    it('should set metadata with createdAt', () => {
      const before = Date.now();
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const after = Date.now();
      expect(task.metadata.createdAt).toBeGreaterThanOrEqual(before);
      expect(task.metadata.createdAt).toBeLessThanOrEqual(after);
    });

    it('should not have result or error initially', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(task.result).toBeUndefined();
      expect(task.error).toBeUndefined();
    });
  });

  describe('startTask', () => {
    it('should change status to RUNNING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      expect(started.status).toBe(TaskStatus.RUNNING);
    });

    it('should set startedAt in metadata', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      expect(started.metadata.startedAt).toBeDefined();
      expect(typeof started.metadata.startedAt).toBe('number');
    });

    it('should throw for non-PENDING task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      expect(() => startTask(started)).toThrow('Cannot start task in status RUNNING');
    });
  });

  describe('completeTask', () => {
    it('should change status to COMPLETED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(completed.status).toBe(TaskStatus.COMPLETED);
    });

    it('should set result', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(completed.result).toEqual({ output: 'world' });
    });

    it('should set completedAt and durationMs', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(completed.metadata.completedAt).toBeDefined();
      expect(completed.metadata.durationMs).toBeDefined();
      expect(completed.metadata.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw for non-RUNNING task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(() => completeTask(task, { output: 'world' })).toThrow(
        'Cannot complete task in status PENDING'
      );
    });
  });

  describe('failTask', () => {
    it('should change status to FAILED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Something failed');
      const failed = failTask(started, error);
      expect(failed.status).toBe(TaskStatus.FAILED);
    });

    it('should set error', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Something failed');
      const failed = failTask(started, error);
      expect(failed.error).toBe(error);
    });

    it('should set completedAt and durationMs', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Something failed');
      const failed = failTask(started, error);
      expect(failed.metadata.completedAt).toBeDefined();
      expect(failed.metadata.durationMs).toBeDefined();
    });

    it('should work for PENDING task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Something failed');
      const failed = failTask(task, error);
      expect(failed.status).toBe(TaskStatus.FAILED);
    });

    it('should throw for terminal task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Something failed');
      expect(() => failTask(completed, error)).toThrow('Cannot fail task in status COMPLETED');
    });
  });

  describe('cancelTask', () => {
    it('should change status to CANCELLED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const cancelled = cancelTask(started);
      expect(cancelled.status).toBe(TaskStatus.CANCELLED);
    });

    it('should set completedAt', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const cancelled = cancelTask(started);
      expect(cancelled.metadata.completedAt).toBeDefined();
    });

    it('should throw for COMPLETED task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(() => cancelTask(completed)).toThrow('Cannot cancel task in status COMPLETED');
    });

    it('should throw for FAILED task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'fail');
      const failed = failTask(started, error);
      expect(() => cancelTask(failed)).toThrow('Cannot cancel task in status FAILED');
    });

    it('should throw for CANCELLED task', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const cancelled = cancelTask(started);
      expect(() => cancelTask(cancelled)).toThrow('Cannot cancel task in status CANCELLED');
    });
  });

  describe('isTaskTerminal', () => {
    it('should return true for COMPLETED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(isTaskTerminal(completed)).toBe(true);
    });

    it('should return true for FAILED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const failed = failTask(started, new EngineError(EngineErrorCode.INTERNAL_ERROR, 'fail'));
      expect(isTaskTerminal(failed)).toBe(true);
    });

    it('should return true for CANCELLED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const cancelled = cancelTask(started);
      expect(isTaskTerminal(cancelled)).toBe(true);
    });

    it('should return false for PENDING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(isTaskTerminal(task)).toBe(false);
    });

    it('should return false for RUNNING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      expect(isTaskTerminal(started)).toBe(false);
    });
  });

  describe('isTaskActive', () => {
    it('should return true for PENDING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      expect(isTaskActive(task)).toBe(true);
    });

    it('should return true for RUNNING', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      expect(isTaskActive(started)).toBe(true);
    });

    it('should return false for COMPLETED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const completed = completeTask(started, { output: 'world' });
      expect(isTaskActive(completed)).toBe(false);
    });

    it('should return false for FAILED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const failed = failTask(started, new EngineError(EngineErrorCode.INTERNAL_ERROR, 'fail'));
      expect(isTaskActive(failed)).toBe(false);
    });

    it('should return false for CANCELLED', () => {
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      const started = startTask(task);
      const cancelled = cancelTask(started);
      expect(isTaskActive(cancelled)).toBe(false);
    });
  });

  describe('TaskQueue', () => {
    it('should enqueue and dequeue tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const dequeued = queue.dequeue();
      expect(dequeued).toBe(task);
    });

    it('should respect maxConcurrent limit', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(1);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      const first = queue.dequeue();
      expect(first).toBe(task1);
      const second = queue.dequeue();
      expect(second).toBeUndefined();
    });

    it('should track running tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      queue.dequeue();
      queue.dequeue();
      const running = queue.getRunning();
      expect(running.length).toBe(2);
    });

    it('should track pending tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(1);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      const pending = queue.getPending();
      expect(pending.length).toBe(2);
      queue.dequeue();
      expect(queue.getPending().length).toBe(1);
    });

    it('should track completed tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const dequeued = queue.dequeue()!;
      queue.moveToCompleted(dequeued);
      const completed = queue.getCompleted();
      expect(completed.length).toBe(1);
      expect(completed[0]).toBe(dequeued);
    });

    it('should get task by id', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        id: 'task-1',
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const found = queue.getTask('task-1');
      expect(found).toBe(task);
    });

    it('should throw when enqueueing duplicate task', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        id: 'task-1',
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      expect(() => queue.enqueue(task)).toThrow('Task task-1 already exists in queue');
    });

    it('should cancel all tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      queue.dequeue();
      const cancelled = queue.cancelAll();
      expect(cancelled.length).toBe(2);
      expect(cancelled.every(t => t.status === TaskStatus.CANCELLED)).toBe(true);
      expect(queue.getRunning().length).toBe(0);
      expect(queue.getPending().length).toBe(0);
    });

    it('should return size stats', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      queue.dequeue();
      expect(queue.size()).toEqual({ pending: 1, running: 1, completed: 0 });
    });

    it('should clear all tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      queue.clear();
      expect(queue.size()).toEqual({ pending: 0, running: 0, completed: 0 });
    });
  });

  describe('TaskQueue edge cases', () => {
    it('should not allow dequeuing more than maxConcurrent', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      const task3 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '3' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      queue.enqueue(task3);
      queue.dequeue();
      queue.dequeue();
      expect(queue.dequeue()).toBeUndefined();
      expect(queue.dequeue()).toBeUndefined();
    });

    it('should move completed task from running to completed', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const dequeued = queue.dequeue()!;
      queue.moveToCompleted(dequeued);
      expect(queue.getRunning().length).toBe(0);
      expect(queue.getCompleted().length).toBe(1);
    });

    it('should update task in pending', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        id: 'task-1',
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const updated = { ...task, status: TaskStatus.RUNNING };
      queue.updateTask(updated);
      const found = queue.getTask('task-1');
      expect(found?.status).toBe(TaskStatus.RUNNING);
    });

    it('should update task in running', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        id: 'task-1',
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      queue.dequeue();
      const updated = { ...task, status: TaskStatus.COMPLETED, result: { output: 'done' } };
      queue.updateTask(updated);
      const found = queue.getTask('task-1');
      expect(found?.status).toBe(TaskStatus.COMPLETED);
    });

    it('should update task in completed', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task = createTask<TestPayload, TestResult>({
        id: 'task-1',
        type: 'test',
        payload: { input: 'hello' },
      });
      queue.enqueue(task);
      const dequeued = queue.dequeue()!;
      queue.moveToCompleted(dequeued);
      const updated = { ...task, result: { output: 'updated' } };
      queue.updateTask(updated);
      const found = queue.getTask('task-1');
      expect(found?.result).toEqual({ output: 'updated' });
    });

    it('should cancel all pending and running tasks', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const task1 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '1' } });
      const task2 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '2' } });
      const task3 = createTask<TestPayload, TestResult>({ type: 'test', payload: { input: '3' } });
      queue.enqueue(task1);
      queue.enqueue(task2);
      queue.enqueue(task3);
      queue.dequeue();
      const cancelled = queue.cancelAll();
      expect(cancelled.length).toBe(3);
      expect(cancelled.every(t => t.status === TaskStatus.CANCELLED)).toBe(true);
      expect(queue.getRunning().length).toBe(0);
      expect(queue.getPending().length).toBe(0);
      expect(queue.getCompleted().length).toBe(3);
    });

    it('should handle cancelAll on empty queue', () => {
      const queue = createTaskQueue<TestPayload, TestResult>(2);
      const cancelled = queue.cancelAll();
      expect(cancelled.length).toBe(0);
    });
  });
});
