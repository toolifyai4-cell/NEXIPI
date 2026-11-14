import { EventEmitter, type EventMap, type EventName } from './events.js';
import { createLogger, type Logger } from './logger.js';
import {
  type EngineConfig,
  defaultEngineConfig,
  validateEngineConfig,
  mergeEngineConfig,
} from './config.js';
import { EngineError, EngineErrorCode, isEngineError, type EngineErrorOptions } from './errors.js';
import {
  type Task,
  type TaskQueue,
  type TaskId,
  type TaskPayload,
  type TaskResult,
  createTask,
  startTask,
  completeTask,
  failTask,
  cancelTask,
  isTaskTerminal,
  createTaskQueue,
  TaskStatus,
} from './tasks.js';
import { sanitize } from './sanitize.js';

export enum EngineStatus {
  UNINITIALIZED = 'UNINITIALIZED',
  INITIALIZED = 'INITIALIZED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

export interface EngineEvents extends EventMap {
  'engine:initialized': { config: EngineConfig; timestamp: number };
  'engine:started': { timestamp: number };
  'engine:stopped': { timestamp: number; reason?: string };
  'engine:error': { error: EngineError; timestamp: number };
  'task:created': { task: Task };
  'task:started': { task: Task };
  'task:completed': { task: Task };
  'task:failed': { task: Task; error: EngineError };
  'task:cancelled': { task: Task };
  'task:timeout': { task: Task };
}

export interface EngineOptions {
  config?: Partial<EngineConfig>;
  logger?: Logger;
}

function createMutex() {
  let locked = false;
  const waitQueue: Array<() => void> = [];

  return {
    async acquire(): Promise<() => void> {
      if (!locked) {
        locked = true;
        return () => {
          locked = false;
          const next = waitQueue.shift();
          if (next) next();
        };
      }
      return new Promise<() => void>(resolve => {
        waitQueue.push(() => {
          locked = true;
          resolve(() => {
            locked = false;
            const next = waitQueue.shift();
            if (next) next();
          });
        });
      });
    },
  };
}

export class Engine {
  private status: EngineStatus = EngineStatus.UNINITIALIZED;
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly eventEmitter: EventEmitter<EngineEvents>;
  private readonly taskQueue: TaskQueue;
  private initError?: EngineError;
  private readonly lifecycleMutex = createMutex();
  private readonly executionMutex = createMutex();
  private readonly activeExecutors = new Map<TaskId, Promise<unknown>>();

  constructor(options: EngineOptions = {}) {
    this.config = mergeEngineConfig(defaultEngineConfig, options.config ?? {});
    this.logger = options.logger ?? createLogger(this.config);
    this.eventEmitter = new EventEmitter<EngineEvents>({
      onListenerError: (error, eventName) => {
        this.logger.error(`Listener error for event ${eventName}`, { error: error.message });
      },
    });
    this.taskQueue = createTaskQueue(this.config.maxConcurrentTasks);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getConfig(): EngineConfig {
    return this.config;
  }

  getLogger(): Logger {
    return this.logger;
  }

  getEventEmitter(): EventEmitter<EngineEvents> {
    return this.eventEmitter;
  }

  initialize(): void {
    if (this.status !== EngineStatus.UNINITIALIZED) {
      const error = new EngineError(
        EngineErrorCode.ALREADY_INITIALIZED,
        `Engine already initialized (current status: ${this.status})`
      );
      this.logger.error('Initialization failed', { error: error.message });
      throw error;
    }

    try {
      validateEngineConfig(this.config);
      this.status = EngineStatus.INITIALIZED;
      this.logger.info('Engine initialized', { config: this.sanitizeConfig(this.config) });
      this.eventEmitter.emit('engine:initialized', {
        config: this.config,
        timestamp: Date.now(),
      });
    } catch (error) {
      const engineError = isEngineError(error)
        ? error
        : new EngineError(
            EngineErrorCode.INITIALIZATION_FAILED,
            `Failed to initialize engine: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error instanceof Error ? error : undefined,
              context: undefined,
            } as EngineErrorOptions
          );
      this.initError = engineError;
      this.status = EngineStatus.ERROR;
      this.logger.error('Engine initialization failed', { error: engineError.message });
      this.eventEmitter.emit('engine:error', { error: engineError, timestamp: Date.now() });
      throw engineError;
    }
  }

  async start(): Promise<void> {
    const release = await this.lifecycleMutex.acquire();
    try {
      if (this.status === EngineStatus.RUNNING) {
        const error = new EngineError(EngineErrorCode.ALREADY_STARTED, 'Engine is already running');
        this.logger.warn('Start called on already running engine');
        throw error;
      }

      if (this.status === EngineStatus.UNINITIALIZED) {
        this.initialize();
      } else if (this.status !== EngineStatus.INITIALIZED && this.status !== EngineStatus.STOPPED) {
        const error = new EngineError(
          EngineErrorCode.INVALID_LIFECYCLE_TRANSITION,
          `Cannot start engine from status ${this.status}`
        );
        this.logger.error('Invalid lifecycle transition', { status: this.status });
        throw error;
      }

      if (this.status === EngineStatus.STOPPED) {
        this.taskQueue.clear();
      }

      this.status = EngineStatus.STARTING;
      this.logger.info('Engine starting');

      await this.performStart();
      this.status = EngineStatus.RUNNING;
      this.logger.info('Engine started');
      this.eventEmitter.emit('engine:started', { timestamp: Date.now() });
    } catch (error) {
      // Don't transition to ERROR for expected lifecycle errors
      if (
        isEngineError(error) &&
        [EngineErrorCode.ALREADY_STARTED, EngineErrorCode.INVALID_LIFECYCLE_TRANSITION].includes(
          error.code
        )
      ) {
        throw error;
      }
      this.status = EngineStatus.ERROR;
      const engineError = isEngineError(error)
        ? error
        : new EngineError(
            EngineErrorCode.INTERNAL_ERROR,
            `Failed to start engine: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error instanceof Error ? error : undefined,
              context: undefined,
            } as EngineErrorOptions
          );
      this.logger.error('Engine start failed', { error: engineError.message });
      this.eventEmitter.emit('engine:error', { error: engineError, timestamp: Date.now() });
      throw engineError;
    } finally {
      release();
    }
  }

  private async performStart(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async stop(reason?: string): Promise<void> {
    const release = await this.lifecycleMutex.acquire();
    try {
      if (this.status === EngineStatus.STOPPED) {
        const error = new EngineError(EngineErrorCode.ALREADY_STOPPED, 'Engine is already stopped');
        this.logger.warn('Stop called on already stopped engine');
        throw error;
      }

      if (this.status !== EngineStatus.RUNNING && this.status !== EngineStatus.STARTING) {
        const error = new EngineError(
          EngineErrorCode.INVALID_LIFECYCLE_TRANSITION,
          `Cannot stop engine from status ${this.status}`
        );
        this.logger.error('Invalid lifecycle transition', { status: this.status });
        throw error;
      }

      this.status = EngineStatus.STOPPING;
      this.logger.info('Engine stopping', { reason });

      await this.performStop(reason);
      this.status = EngineStatus.STOPPED;
      this.logger.info('Engine stopped', { reason });
      this.eventEmitter.emit('engine:stopped', { timestamp: Date.now(), reason: reason ?? '' });
    } catch (error) {
      // Don't transition to ERROR for expected lifecycle errors
      if (
        isEngineError(error) &&
        [EngineErrorCode.ALREADY_STOPPED, EngineErrorCode.INVALID_LIFECYCLE_TRANSITION].includes(
          error.code
        )
      ) {
        throw error;
      }
      this.status = EngineStatus.ERROR;
      const engineError = isEngineError(error)
        ? error
        : new EngineError(
            EngineErrorCode.INTERNAL_ERROR,
            `Failed to stop engine: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error instanceof Error ? error : undefined,
              context: undefined,
            } as EngineErrorOptions
          );
      this.logger.error('Engine stop failed', { error: engineError.message });
      this.eventEmitter.emit('engine:error', { error: engineError, timestamp: Date.now() });
      throw engineError;
    } finally {
      release();
    }
  }

  private async performStop(_reason?: string): Promise<void> {
    const cancelledTasks = this.taskQueue.cancelAll();
    for (const task of cancelledTasks) {
      this.eventEmitter.emit('task:cancelled', { task });
    }

    // Wait for all active executors to settle before completing stop,
    // but with a bounded timeout to prevent indefinite hanging.
    // Note: JavaScript cannot forcibly terminate arbitrary promises;
    // this timeout only bounds the *wait*, not the executor execution.
    if (this.activeExecutors.size > 0) {
      const executorPromises = Array.from(this.activeExecutors.values());
      const shutdownTimeoutMs = this.config.shutdownTimeoutMs;

      const waitPromise = Promise.allSettled(executorPromises);
      const timeoutPromise = new Promise<void>(resolve =>
        setTimeout(() => resolve(), shutdownTimeoutMs)
      );

      await Promise.race([waitPromise, timeoutPromise]);

      const remainingCount = this.activeExecutors.size;
      if (remainingCount > 0) {
        this.logger.warn('Shutdown timeout reached, some executors did not settle', {
          remainingExecutors: remainingCount,
          shutdownTimeoutMs,
        });
      }
      this.activeExecutors.clear();
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  createTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
    type: string,
    payload: T
  ): Task<T, R> {
    const task = createTask<T, R>({ type, payload });
    this.taskQueue.enqueue(task);
    this.logger.debug('Task created', { taskId: task.id, type: task.type });
    this.eventEmitter.emit('task:created', { task });
    return task;
  }

  getTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
    id: TaskId
  ): Task<T, R> | undefined {
    return this.taskQueue.getTask(id) as Task<T, R> | undefined;
  }

  async executeTask<T extends TaskPayload = TaskPayload, R extends TaskResult = TaskResult>(
    task: Task<T, R>,
    executor: (payload: T) => Promise<R>
  ): Promise<Task<T, R>> {
    let dequeuedTask: Task<T, R> | undefined;
    let startedTask: Task<T, R>;

    // Acquire mutex only for the check-and-dequeue operation
    const release = await this.executionMutex.acquire();
    try {
      const currentTask = this.taskQueue.getTask(task.id);
      if (!currentTask) {
        const error = new EngineError(
          EngineErrorCode.TASK_NOT_FOUND,
          `Task ${task.id} not found in queue`
        );
        this.logger.error('Task execution failed', { taskId: task.id, error: error.message });
        throw error;
      }

      if (currentTask.status !== TaskStatus.PENDING) {
        const error = new EngineError(
          EngineErrorCode.INTERNAL_ERROR,
          `Cannot execute task in status ${currentTask.status}`
        );
        this.logger.error('Task execution failed', { taskId: task.id, error: error.message });
        throw error;
      }

      // Check concurrency limit based on active executors
      // (tasks in running queue are also tracked in activeExecutors)
      const activeCount = this.activeExecutors.size;
      if (activeCount >= this.config.maxConcurrentTasks) {
        const error = new EngineError(
          EngineErrorCode.INTERNAL_ERROR,
          `Concurrency limit reached (max: ${this.config.maxConcurrentTasks})`
        );
        this.logger.error('Task execution failed', { taskId: task.id, error: error.message });
        throw error;
      }

      dequeuedTask = this.taskQueue.dequeue() as Task<T, R> | undefined;
      if (!dequeuedTask || dequeuedTask.id !== task.id) {
        const error = new EngineError(
          EngineErrorCode.TASK_NOT_FOUND,
          `Task ${task.id} not at front of queue`
        );
        this.logger.error('Task execution failed', { taskId: task.id, error: error.message });
        throw error;
      }

      startedTask = startTask(dequeuedTask);
      this.taskQueue.updateTask(startedTask);
      this.logger.debug('Task started', { taskId: startedTask.id });
      this.eventEmitter.emit('task:started', { task: startedTask });
    } finally {
      release();
    }

    // Execute without holding the mutex to allow concurrency
    const executorPromise = executor(startedTask.payload);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeoutMs)
    );

    // Track the executor until it settles to prevent concurrency limit bypass
    this.activeExecutors.set(startedTask.id, executorPromise);

    try {
      const result = await Promise.race([executorPromise, timeoutPromise]);
      const completedTask = completeTask(startedTask, result);

      // Re-acquire mutex to move to completed
      const release2 = await this.executionMutex.acquire();
      try {
        this.taskQueue.moveToCompleted(completedTask);
        this.activeExecutors.delete(startedTask.id);
      } finally {
        release2();
      }

      this.logger.debug('Task completed', { taskId: completedTask.id });
      this.eventEmitter.emit('task:completed', { task: completedTask });
      return completedTask;
    } catch (error) {
      const engineError = isEngineError(error)
        ? error
        : new EngineError(
            EngineErrorCode.INTERNAL_ERROR,
            `Task execution failed: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error instanceof Error ? error : undefined,
              context: undefined,
            } as EngineErrorOptions
          );
      const failedTask = failTask(startedTask, engineError);

      // Re-acquire mutex to update task as failed (but keep in running until executor settles)
      const release2 = await this.executionMutex.acquire();
      try {
        // On timeout/error, we keep the task in RUNNING state in the queue
        // until the executor actually settles, to maintain accurate concurrency accounting
        // The task is already marked FAILED for the caller, but stays in running map
        this.taskQueue.updateTask(failedTask);
      } finally {
        release2();
      }

      const isTimeout = engineError.message.includes('Task timeout');
      if (isTimeout) {
        this.eventEmitter.emit('task:timeout', { task: failedTask });
      }
      this.logger.error('Task failed', { taskId: failedTask.id, error: engineError.message });
      this.eventEmitter.emit('task:failed', { task: failedTask, error: engineError });

      // Wait for executor to actually settle before releasing the concurrency slot
      void executorPromise
        .finally(() => {
          void this.executionMutex.acquire().then(release3 => {
            try {
              this.taskQueue.moveToCompleted(failedTask);
              this.activeExecutors.delete(startedTask.id);
            } finally {
              release3();
            }
          });
        })
        .catch(() => {
          // Ignore errors from the executor itself
        });

      throw engineError;
    }
  }

  cancelTask(taskId: TaskId): boolean {
    const task = this.taskQueue.getTask(taskId);
    if (!task) {
      return false;
    }
    if (isTaskTerminal(task)) {
      return false;
    }

    // If task is running, we need to wait for its executor to settle
    // to maintain accurate concurrency accounting
    if (task.status === TaskStatus.RUNNING) {
      const executorPromise = this.activeExecutors.get(taskId);
      if (executorPromise) {
        // Mark as cancelled but keep in running until executor settles
        const cancelledTask = cancelTask(task);
        this.taskQueue.updateTask(cancelledTask);
        this.logger.debug('Task cancelled (running)', { taskId });
        this.eventEmitter.emit('task:cancelled', { task: cancelledTask });

        // Wait for executor to settle, then move to completed
        void executorPromise
          .finally(() => {
            void this.executionMutex.acquire().then(release => {
              try {
                this.taskQueue.moveToCompleted(cancelledTask);
                this.activeExecutors.delete(taskId);
              } finally {
                release();
              }
            });
          })
          .catch(() => {
            // Ignore errors
          });
        return true;
      }
    }

    const cancelledTask = cancelTask(task);
    this.taskQueue.updateTask(cancelledTask);
    this.logger.debug('Task cancelled', { taskId });
    this.eventEmitter.emit('task:cancelled', { task: cancelledTask });
    return true;
  }

  getTaskQueueStats() {
    return this.taskQueue.size();
  }

  on<T extends EventName>(
    eventName: T,
    listener: (payload: EngineEvents[T]) => void | Promise<void>
  ) {
    return this.eventEmitter.on(eventName, listener);
  }

  off<T extends EventName>(
    eventName: T,
    listener: (payload: EngineEvents[T]) => void | Promise<void>
  ) {
    return this.eventEmitter.off(eventName, listener);
  }

  private sanitizeConfig(config: EngineConfig): Record<string, unknown> {
    return sanitize(config) as Record<string, unknown>;
  }
}

export function createEngine(options?: EngineOptions): Engine {
  return new Engine(options);
}
