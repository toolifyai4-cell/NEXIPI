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
} from './tasks.js';

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

export class Engine {
  private status: EngineStatus = EngineStatus.UNINITIALIZED;
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly eventEmitter: EventEmitter<EngineEvents>;
  private readonly taskQueue: TaskQueue;
  private initError?: EngineError;

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

      this.status = EngineStatus.STARTING;
      this.logger.info('Engine starting');

      await this.performStart();
      this.status = EngineStatus.RUNNING;
      this.logger.info('Engine started');
      this.eventEmitter.emit('engine:started', { timestamp: Date.now() });
    } catch (error) {
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
    }
  }

  private async performStart(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  async stop(reason?: string): Promise<void> {
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
    }
  }

  private async performStop(_reason?: string): Promise<void> {
    const cancelledTasks = this.taskQueue.cancelAll();
    for (const task of cancelledTasks) {
      this.eventEmitter.emit('task:cancelled', { task });
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
    const startedTask = startTask(task);
    this.taskQueue.updateTask(startedTask);
    this.logger.debug('Task started', { taskId: startedTask.id });
    this.eventEmitter.emit('task:started', { task: startedTask });

    try {
      const result = await Promise.race([
        executor(startedTask.payload),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeoutMs)
        ),
      ]);
      const completedTask = completeTask(startedTask, result);
      this.taskQueue.moveToCompleted(completedTask);
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
      this.taskQueue.moveToCompleted(failedTask);
      this.logger.error('Task failed', { taskId: failedTask.id, error: engineError.message });
      this.eventEmitter.emit('task:failed', { task: failedTask, error: engineError });
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
    return { ...config };
  }
}

export function createEngine(options?: EngineOptions): Engine {
  return new Engine(options);
}
