export { version } from './version.js';

export {
  EngineConfigSchema,
  type EngineConfig,
  defaultEngineConfig,
  validateEngineConfig,
  safeValidateEngineConfig,
  mergeEngineConfig,
  type LogLevel,
} from './config.js';

export {
  EngineErrorCode,
  EngineError,
  createEngineError,
  isEngineError,
  assertEngineError,
} from './errors.js';

export {
  EventEmitter,
  createEventEmitter,
  type EventMap,
  type EventName,
  type EventListener,
  type EventSubscription,
  type EventEmitterOptions,
} from './events.js';

export {
  TaskStatus,
  type TaskId,
  type TaskPayload,
  type TaskResult,
  type TaskMetadata,
  type Task,
  type TaskOptions,
  createTask,
  startTask,
  completeTask,
  failTask,
  cancelTask,
  isTaskTerminal,
  isTaskActive,
  TaskQueue,
  createTaskQueue,
  type TaskQueueOptions,
} from './tasks.js';

export {
  createLogger,
  createNoopLogger,
  LOG_LEVELS,
  type LogLevel as LoggerLogLevel,
  type Logger,
} from './logger.js';

export {
  EngineStatus,
  Engine,
  createEngine,
  type EngineOptions,
  type EngineEvents,
} from './engine.js';