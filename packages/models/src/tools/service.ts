import { createNoopLogger, type Logger } from '@nexipi/core';
import {
  ToolErrorCode,
  createToolError,
  isToolError,
} from './errors.js';
import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from './types.js';
import type { ToolExecutor } from './executor.js';

/**
 * Execution limits for ToolExecutionService.
 *
 * Centralized in one typed, validated object so numeric limits are not
 * scattered across the implementation. All limits are positive integers.
 * The batch limit must not exceed the turn limit.
 */
export interface ToolExecutionServiceConfig {
  readonly maxIterationsPerTurn: number;
  readonly maxCallsPerBatch: number;
  readonly maxCallsPerTurn: number;
  readonly maxConcurrentExecutions: number;
  readonly maxExecutionTimePerToolMs: number;
  readonly maxTotalExecutionTimePerTurnMs: number;
  readonly maxQueuedCalls: number;
}

/**
 * Approved defaults for Phase 09 Substage 3.
 */
export const DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG: ToolExecutionServiceConfig = {
  maxIterationsPerTurn: 10,
  maxCallsPerBatch: 5,
  maxCallsPerTurn: 25,
  maxConcurrentExecutions: 5,
  maxExecutionTimePerToolMs: 30_000,
  maxTotalExecutionTimePerTurnMs: 120_000,
  maxQueuedCalls: 100,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function validateToolExecutionServiceConfig(input: unknown): ToolExecutionServiceConfig {
  const raw = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, ...raw };

  const fields: Array<keyof ToolExecutionServiceConfig> = [
    'maxIterationsPerTurn',
    'maxCallsPerBatch',
    'maxCallsPerTurn',
    'maxConcurrentExecutions',
    'maxExecutionTimePerToolMs',
    'maxTotalExecutionTimePerTurnMs',
    'maxQueuedCalls',
  ];

  for (const field of fields) {
    if (!isPositiveInteger(merged[field])) {
      throw new Error(`ToolExecutionService config '${field}' must be a positive integer`);
    }
  }

  const maxCallsPerBatch = merged['maxCallsPerBatch'] as number;
  const maxCallsPerTurn = merged['maxCallsPerTurn'] as number;
  if (maxCallsPerBatch > maxCallsPerTurn) {
    throw new Error("ToolExecutionService config 'maxCallsPerBatch' must not exceed 'maxCallsPerTurn'");
  }

  return merged as unknown as ToolExecutionServiceConfig;
}

function cancelledResult(toolName: string): ToolExecutionResult {
  return {
    kind: 'failure',
    error: createToolError(ToolErrorCode.TOOL_CANCELLED, `Tool '${toolName}' was cancelled`, { toolName }),
    truncated: false,
    executionMs: 0,
  };
}

function timeoutResult(toolName: string): ToolExecutionResult {
  return {
    kind: 'failure',
    error: createToolError(ToolErrorCode.TOOL_TIMEOUT, `Tool '${toolName}' exceeded its per-execution time limit`, { toolName }),
    truncated: false,
    executionMs: 0,
  };
}

function resourceLimitResult(toolName: string, message: string): ToolExecutionResult {
  return {
    kind: 'failure',
    error: createToolError(ToolErrorCode.TOOL_RESOURCE_LIMIT, message, { toolName }),
    truncated: false,
    executionMs: 0,
  };
}

function errorToResult(error: unknown, toolName: string): ToolExecutionResult {
  if (isToolError(error)) {
    return {
      kind: 'failure',
      error: createToolError(error.code, error.message, {
        toolName,
        cause: error.cause,
        context: error.context,
        retryable: error.retryable,
      }),
      truncated: false,
      executionMs: 0,
    };
  }
  return {
    kind: 'failure',
    error: createToolError(
      ToolErrorCode.TOOL_EXECUTION_FAILED,
      `Tool '${toolName}' execution failed`,
      { toolName, cause: error instanceof Error ? error : undefined }
    ),
    truncated: false,
    executionMs: 0,
  };
}

export type TurnStatus = 'active' | 'completed' | 'cancelled' | 'disposed';

export interface ToolExecutionServiceOptions {
  readonly config?: Partial<ToolExecutionServiceConfig>;
  readonly logger?: Logger;
}

export interface CreateTurnOptions {
  readonly id?: string;
}

export interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

/**
 * Represents a per-turn tool execution session with isolated accounting,
 * cancellation, and deadline tracking.
 */
export class ToolExecutionTurn {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly service: ToolExecutionService;
  private readonly executor: ToolExecutor;
  private readonly config: ToolExecutionServiceConfig;
  private readonly logger: Logger;
  private statusValue: TurnStatus = 'active';
  private iterationCountValue = 0;
  private callsSubmittedValue = 0;
  private callsCompletedValue = 0;
  private activeExecutionsValue = 0;
  private queuedCallsValue = 0;
  private readonly cancellationController = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private terminated = false;
  private submissionLock = Promise.resolve();
  private disposedValue = false;

  constructor(service: ToolExecutionService, id: string) {
    this.service = service;
    this.executor = service.executor;
    this.config = service.config;
    this.logger = service.logger;
    this.id = id;
    this.signal = this.cancellationController.signal;
    this.deadlineTimer = setTimeout(() => this.handleDeadlineExpiry(), this.config.maxTotalExecutionTimePerTurnMs);
  }

  get status(): TurnStatus {
    return this.statusValue;
  }

  get iterationCount(): number {
    return this.iterationCountValue;
  }

  get callsSubmitted(): number {
    return this.callsSubmittedValue;
  }

  get callsCompleted(): number {
    return this.callsCompletedValue;
  }

  get activeExecutions(): number {
    return this.activeExecutionsValue;
  }

  get queuedCalls(): number {
    return this.queuedCallsValue;
  }

  get expiresAt(): number {
    return Date.now() + this.config.maxTotalExecutionTimePerTurnMs;
  }

  async submitBatch(calls: readonly ToolCall[], context: ToolExecutionContext): Promise<readonly ToolExecutionResult[]> {
    await this.acquireSubmissionLock();
    let release: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.submissionLock = lock;
    try {
      this.ensureActive();
      if (this.iterationCountValue >= this.config.maxIterationsPerTurn) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Maximum iterations per turn (${this.config.maxIterationsPerTurn}) exceeded`
        );
      }
      if (calls.length > this.config.maxCallsPerBatch) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Batch size ${calls.length} exceeds maximum calls per batch (${this.config.maxCallsPerBatch})`
        );
      }
      if (this.callsSubmittedValue + calls.length > this.config.maxCallsPerTurn) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Turn call limit ${this.config.maxCallsPerTurn} would be exceeded`
        );
      }

      this.iterationCountValue++;
      this.callsSubmittedValue += calls.length;

      const entries: CallEntry[] = [];
      for (const call of calls) {
        const entry = new CallEntry(this, call.toolName, call.input, context);
        entries.push(entry);
        this.service.admitEntry(entry);
      }

      return Promise.all(entries.map((e) => e.promise));
    } finally {
      release!();
    }
  }

  complete(): void {
    this.terminate('complete');
  }

  cancel(): void {
    this.terminate('cancel');
  }

  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true;
    this.terminate('dispose');
    this.service.turns.delete(this);
  }

  private ensureActive(): void {
    if (this.statusValue !== 'active') {
      throw createToolError(
        ToolErrorCode.TOOL_CANCELLED,
        `Tool execution turn '${this.id}' is ${this.statusValue}`
      );
    }
  }

  private terminate(reason: 'complete' | 'cancel' | 'deadline' | 'dispose'): void {
    if (this.terminated) return;
    this.terminated = true;

    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }

    if (reason === 'complete') {
      this.statusValue = 'completed';
    } else if (reason === 'dispose') {
      this.statusValue = 'disposed';
      this.cancellationController.abort();
    } else {
      this.statusValue = 'cancelled';
      this.cancellationController.abort();
    }

    this.service.cancelQueuedForTurn(this);
  }

  private handleDeadlineExpiry(): void {
    this.terminate('deadline');
  }

  private async acquireSubmissionLock(): Promise<void> {
    await this.submissionLock;
  }

  /** Called by service when an entry starts executing. */
  onEntryStarted(_entry: CallEntry): void {
    this.activeExecutionsValue++;
  }

  /** Called by service when a queued entry is admitted. */
  onEntryQueued(_entry: CallEntry): void {
    this.queuedCallsValue++;
  }

  /** Called by service when an entry completes (after underlying execution settles). */
  onEntryComplete(_entry: CallEntry): void {
    this.activeExecutionsValue--;
    this.callsCompletedValue++;
  }

  /** Called by service to remove a queued entry that was cancelled. */
  onEntryRemovedFromQueue(): void {
    this.queuedCallsValue--;
  }
}

type EntryStatus = 'admitted' | 'queued' | 'active' | 'completed';

class CallEntry {
  readonly turn: ToolExecutionTurn;
  readonly toolName: string;
  readonly input: unknown;
  readonly context: ToolExecutionContext;
  readonly promise: Promise<ToolExecutionResult>;
  status: EntryStatus = 'admitted';
  isCancelled = false;
  underlying: Promise<ToolExecutionResult> | null = null;
  private resolve!: (result: ToolExecutionResult) => void;
  private reject!: (error: Error) => void;

  constructor(turn: ToolExecutionTurn, toolName: string, input: unknown, context: ToolExecutionContext) {
    this.turn = turn;
    this.toolName = toolName;
    this.input = input;
    this.context = context;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  resolveWith(result: ToolExecutionResult): void {
    this.resolve(result);
  }

  rejectWith(error: Error): void {
    this.reject(error);
  }

  startActive(): void {
    this.status = 'active';
    this.turn.onEntryStarted(this);
    void this.turn.service.runEntry(this);
  }

  cancel(): void {
    if (this.status === 'completed') return;
    this.isCancelled = true;
    if (this.status === 'queued') {
      this.status = 'completed';
      this.turn.onEntryRemovedFromQueue();
      this.turn.service.removeQueuedEntry(this);
      this.resolveWith(cancelledResult(this.toolName));
    }
  }
}

export class ToolExecutionService {
  readonly executor: ToolExecutor;
  readonly config: ToolExecutionServiceConfig;
  readonly logger: Logger;
  readonly turns: Set<ToolExecutionTurn> = new Set();
  private readonly globalQueue: CallEntry[] = [];
  private globalActiveCount = 0;
  private globalQueuedCount = 0;
  private disposed = false;
  private turnCounter = 0;

  constructor(executor: ToolExecutor, options: ToolExecutionServiceOptions = {}) {
    this.executor = executor;
    this.config = validateToolExecutionServiceConfig(options.config ?? {});
    this.logger = options.logger ?? createNoopLogger();
  }

  getConfig(): Readonly<ToolExecutionServiceConfig> {
    return this.config;
  }

  createTurn(options: CreateTurnOptions = {}): ToolExecutionTurn {
    if (this.disposed) {
      throw new Error('ToolExecutionService has been disposed');
    }
    const turn = new ToolExecutionTurn(this, options.id ?? `turn_${++this.turnCounter}`);
    this.turns.add(turn);
    return turn;
  }

  getGlobalSnapshot(): { activeTurns: number; activeExecutions: number; queuedCalls: number } {
    return {
      activeTurns: this.turns.size,
      activeExecutions: this.globalActiveCount,
      queuedCalls: this.globalQueuedCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const turn of this.turns) {
      turn.dispose();
    }
    this.turns.clear();
    this.globalQueue.length = 0;
    this.globalQueuedCount = 0;
  }

  admitEntry(entry: CallEntry): void {
    if (this.disposed) {
      entry.resolveWith(cancelledResult(entry.toolName));
      return;
    }
    if (this.globalActiveCount < this.config.maxConcurrentExecutions) {
      this.globalActiveCount++;
      entry.startActive();
    } else {
      // Check global queue capacity before queuing
      if (this.globalQueuedCount >= this.config.maxQueuedCalls) {
        entry.resolveWith(resourceLimitResult(entry.toolName, `Global queued call limit (${this.config.maxQueuedCalls}) exceeded`));
        return;
      }
      entry.status = 'queued';
      entry.turn.onEntryQueued(entry);
      this.globalQueue.push(entry);
      this.globalQueuedCount++;
    }
  }

  onEntryComplete(entry: CallEntry): void {
    this.globalActiveCount--;
    entry.turn.onEntryComplete(entry);
    entry.status = 'completed';
    this.processQueue();
  }

  processQueue(): void {
    while (this.globalActiveCount < this.config.maxConcurrentExecutions && this.globalQueue.length > 0) {
      const entry = this.globalQueue.shift()!;
      if (entry.isCancelled) {
        entry.turn.onEntryRemovedFromQueue();
        this.globalQueuedCount--;
        continue;
      }
      entry.status = 'active';
      entry.turn.onEntryRemovedFromQueue();
      entry.turn.onEntryStarted(entry);
      this.globalQueuedCount--;
      this.globalActiveCount++;
      void this.runEntry(entry);
    }
  }

  cancelQueuedForTurn(turn: ToolExecutionTurn): void {
    const remaining: CallEntry[] = [];
    for (const entry of this.globalQueue) {
      if (entry.turn === turn) {
        entry.status = 'completed';
        entry.isCancelled = true;
        turn.onEntryRemovedFromQueue();
        this.globalQueuedCount--;
        entry.resolveWith(cancelledResult(entry.toolName));
      } else {
        remaining.push(entry);
      }
    }
    this.globalQueue.length = 0;
    this.globalQueue.push(...remaining);
  }

  removeQueuedEntry(entry: CallEntry): void {
    const idx = this.globalQueue.indexOf(entry);
    if (idx !== -1) {
      this.globalQueue.splice(idx, 1);
      this.globalQueuedCount--;
    }
  }

  async runEntry(entry: CallEntry): Promise<void> {
    let result: ToolExecutionResult;
    try {
      try {
        result = await this.runCall(entry);
      } catch (error) {
        result = errorToResult(error, entry.toolName);
      }
      if (!entry.isCancelled) {
        entry.resolveWith(result);
      }
    } catch (error) {
      // Safety net: ensure the entry's promise is always resolved
      if (!entry.isCancelled) {
        entry.resolveWith(errorToResult(error, entry.toolName));
      }
    }
    if (entry.underlying) {
      await entry.underlying.catch(() => undefined);
    }
    this.onEntryComplete(entry);
  }

  async runCall(entry: CallEntry): Promise<ToolExecutionResult> {
    const { toolName, turn, context } = entry;
    const config = this.config;

    const controller = new AbortController();
    const signal = controller.signal;

    // Check if already cancelled before starting
    if (turn.signal.aborted || context.signal.aborted) {
      return cancelledResult(toolName);
    }

    let resolved = false;
    let resolveRace!: (result: ToolExecutionResult) => void;
    const racePromise = new Promise<ToolExecutionResult>((resolve) => {
      resolveRace = resolve;
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      turn.signal.removeEventListener('abort', onExternalAbort);
      context.signal.removeEventListener('abort', onExternalAbort);
    };

    const tryResolve = (_result: ToolExecutionResult): boolean => {
      if (resolved) return false;
      resolved = true;
      cleanup();
      return true;
    };

    const onExternalAbort = (): void => {
      if (tryResolve(cancelledResult(toolName))) {
        controller.abort();
        resolveRace(cancelledResult(toolName));
      }
    };

    turn.signal.addEventListener('abort', onExternalAbort, { once: true });
    context.signal.addEventListener('abort', onExternalAbort, { once: true });

    timeoutId = setTimeout(() => {
      if (tryResolve(timeoutResult(toolName))) {
        controller.abort();
        resolveRace(timeoutResult(toolName));
      }
    }, config.maxExecutionTimePerToolMs);

    const callContext: ToolExecutionContext = { ...context, signal };
    const underlying = this.executor.execute(toolName, entry.input, callContext);
    entry.underlying = underlying;

    try {
      return await Promise.race([underlying, racePromise]);
    } finally {
      cleanup();
      void underlying.catch(() => undefined);
    }
  }
}