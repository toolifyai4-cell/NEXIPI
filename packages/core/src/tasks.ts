import { randomUUID } from 'crypto';
import type { EngineError } from './errors.js';

export enum TaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export type TaskId = string;

export interface TaskPayload {
  [key: string]: unknown;
}

export interface TaskResult {
  [key: string]: unknown;
}

export interface TaskMetadata {
  createdAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  durationMs?: number | undefined;
}

export interface Task<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult> {
  readonly id: TaskId;
  readonly type: string;
  readonly payload: T;
  status: TaskStatus;
  result?: R;
  error?: EngineError;
  metadata: TaskMetadata;
}

export interface TaskOptions<T extends TaskPayload = TaskPayload> {
  id?: TaskId;
  type: string;
  payload: T;
  timeoutMs?: number;
}

export function createTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
  options: TaskOptions<T>
): Task<T, R> {
  const now = Date.now();
  return {
    id: options.id ?? randomUUID(),
    type: options.type,
    payload: options.payload,
    status: TaskStatus.PENDING,
    metadata: {
      createdAt: now,
    },
  };
}

export function startTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
  task: Task<T, R>
): Task<T, R> {
  if (task.status !== TaskStatus.PENDING) {
    throw new Error(`Cannot start task in status ${task.status}`);
  }
  return {
    ...task,
    status: TaskStatus.RUNNING,
    metadata: {
      ...task.metadata,
      startedAt: Date.now(),
    },
  };
}

export function completeTask<
  T extends TaskPayload = TaskPayload,
  R extends TaskResult = TaskResult,
>(task: Task<T, R>, result: R): Task<T, R> {
  if (task.status !== TaskStatus.RUNNING) {
    throw new Error(`Cannot complete task in status ${task.status}`);
  }
  const completedAt = Date.now();
  return {
    ...task,
    status: TaskStatus.COMPLETED,
    result,
    metadata: {
      ...task.metadata,
      completedAt,
      durationMs: completedAt - (task.metadata.startedAt ?? completedAt),
    },
  };
}

export function failTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
  task: Task<T, R>,
  error: EngineError
): Task<T, R> {
  if (task.status !== TaskStatus.RUNNING && task.status !== TaskStatus.PENDING) {
    throw new Error(`Cannot fail task in status ${task.status}`);
  }
  const completedAt = Date.now();
  return {
    ...task,
    status: TaskStatus.FAILED,
    error,
    metadata: {
      ...task.metadata,
      completedAt,
      durationMs: completedAt - (task.metadata.startedAt ?? completedAt),
    },
  };
}

export function cancelTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
  task: Task<T, R>
): Task<T, R> {
  if (
    task.status === TaskStatus.COMPLETED ||
    task.status === TaskStatus.FAILED ||
    task.status === TaskStatus.CANCELLED
  ) {
    throw new Error(`Cannot cancel task in status ${task.status}`);
  }
  const completedAt = Date.now();
  return {
    ...task,
    status: TaskStatus.CANCELLED,
    metadata: {
      ...task.metadata,
      completedAt,
      durationMs: task.metadata.startedAt ? completedAt - task.metadata.startedAt : undefined,
    },
  };
}

export function isTaskTerminal(task: Task): boolean {
  return (
    task.status === TaskStatus.COMPLETED ||
    task.status === TaskStatus.FAILED ||
    task.status === TaskStatus.CANCELLED
  );
}

export function isTaskActive(task: Task): boolean {
  return task.status === TaskStatus.RUNNING || task.status === TaskStatus.PENDING;
}

export interface TaskQueueOptions {
  maxConcurrent: number;
}

export class TaskQueue<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult> {
  private pending: Array<Task<T, R>> = [];
  private readonly running: Map<TaskId, Task<T, R>> = new Map();
  private readonly completed: Map<TaskId, Task<T, R>> = new Map();
  private readonly options: TaskQueueOptions;

  constructor(options: TaskQueueOptions) {
    this.options = options;
  }

  enqueue(task: Task<T, R>): void {
    if (
      this.running.has(task.id) ||
      this.completed.has(task.id) ||
      this.pending.some(t => t.id === task.id)
    ) {
      throw new Error(`Task ${task.id} already exists in queue`);
    }
    this.pending.push(task);
  }

  dequeue(): Task<T, R> | undefined {
    if (this.running.size >= this.options.maxConcurrent) {
      return undefined;
    }
    const task = this.pending.shift();
    if (task) {
      this.running.set(task.id, task);
    }
    return task;
  }

  getRunning(): Array<Task<T, R>> {
    return Array.from(this.running.values());
  }

  getPending(): Array<Task<T, R>> {
    return [...this.pending];
  }

  getCompleted(): Array<Task<T, R>> {
    return Array.from(this.completed.values());
  }

  getTask(id: TaskId): Task<T, R> | undefined {
    return this.running.get(id) ?? this.completed.get(id) ?? this.pending.find(t => t.id === id);
  }

  moveToCompleted(task: Task<T, R>): void {
    this.running.delete(task.id);
    this.completed.set(task.id, task);
  }

  updateTask(task: Task<T, R>): void {
    if (this.running.has(task.id)) {
      this.running.set(task.id, task);
    } else if (this.pending.some(t => t.id === task.id)) {
      this.pending = this.pending.map(t => (t.id === task.id ? task : t));
    } else if (this.completed.has(task.id)) {
      this.completed.set(task.id, task);
    }
  }

  cancelAll(): Array<Task<T, R>> {
    const cancelled: Array<Task<T, R>> = [];
    for (const task of this.running.values()) {
      cancelled.push(cancelTask(task));
    }
    this.running.clear();
    for (const task of this.pending) {
      cancelled.push(cancelTask(task));
    }
    this.pending.length = 0;
    for (const task of cancelled) {
      this.completed.set(task.id, task);
    }
    return cancelled;
  }

  size(): { pending: number; running: number; completed: number } {
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.completed.size,
    };
  }

  clear(): void {
    this.pending.length = 0;
    this.running.clear();
    this.completed.clear();
  }
}

export function createTaskQueue<
  T extends TaskPayload = TaskPayload,
  R extends TaskResult = TaskResult,
>(maxConcurrent: number): TaskQueue<T, R> {
  return new TaskQueue<T, R>({ maxConcurrent });
}
