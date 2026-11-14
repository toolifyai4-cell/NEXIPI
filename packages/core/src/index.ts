export { version } from './version.js';

export interface AgentConfig {
  readonly name: string;
  readonly version: string;
}

export const defaultConfig: AgentConfig = {
  name: 'nexipi',
  version: '0.0.1',
};

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
  EngineErrorOptions,
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
  sanitize,
  SENSITIVE_KEYS,
  type SensitiveKey,
  sanitizeErrorContext,
  createSanitizedContext,
} from './sanitize.js';

export {
  EngineStatus,
  Engine,
  createEngine,
  type EngineOptions,
  type EngineEvents,
} from './engine.js';

export {
  type StreamEventType,
  type StreamEventMap,
  type StreamEvent,
  type StreamStartEvent,
  type StreamDeltaEvent,
  type StreamCompleteEvent,
  type StreamErrorEvent,
  type StreamCancelEvent,
  StreamEventSchema,
  StreamStartEventSchema,
  StreamDeltaEventSchema,
  StreamCompleteEventSchema,
  StreamErrorEventSchema,
  StreamCancelEventSchema,
  type StreamEventInput,
  type StreamEventOutput,
  createStreamStartEvent,
  createStreamDeltaEvent,
  createStreamCompleteEvent,
  createStreamErrorEvent,
  createStreamCancelEvent,
  validateStreamEvent,
  safeValidateStreamEvent,
  type StreamingProvider,
  type NonStreamingProvider,
  type ProviderExecutor,
  isStreamingProvider,
  isNonStreamingProvider,
} from '@nexipi/shared';
