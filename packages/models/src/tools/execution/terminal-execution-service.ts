/**
 * Phase 11 Stage D — Terminal execution service.
 *
 * Manages the lifecycle of controlled terminal process executions:
 *   - Command validation (Stage C)
 *   - Approval binding verification (Stage B, enforced before execution)
 *   - Executable resolution and policy re-check (Stage D)
 *   - Workspace boundary validation (Stage D)
 *   - Process spawning through the controlled adapter (Stage D)
 *   - Per-execution timeout and AbortSignal cancellation
 *   - Concurrent execution and queue limits
 *   - Service disposal and shutdown
 *
 * This service does NOT implement trusted approval UI or persistence
 * (Stage E). It does NOT integrate ChatService or the extension UI
 * (Stage F). It is the execution boundary that Stage E will guard.
 */

import { createNoopLogger, type Logger } from '@nexipi/core';
import {
  applyTransition,
  isActiveState,
  isTerminalState,
  type TerminalLifecycleState,
} from './lifecycle.js';
import {
  TerminalError,
  TerminalErrorCode,
  createTerminalError,
  isTerminalError,
} from './errors.js';
import type {
  ApprovalBinding,
  TerminalCommand,
  TerminalExecutionLimits,
  TerminalExecutionRequest,
  TerminalExecutionResult,
  TerminalId,
  DEFAULT_TERMINAL_EXECUTION_LIMITS,
} from './contracts.js';
import { createTerminalId } from './contracts.js';
import { validateTerminalCommandSecurity } from './command-validation.js';
import type { WorkspaceBoundaryValidator } from './command-validation.js';
import {
  checkExecutablePermission,
  type ExecutablePolicy,
  type ExecutableResolver,
} from './executable-policy.js';
import { resolveExecutable, type ExecutableResolutionOptions } from './executable-resolution.js';
import {
  spawnControlledProcess,
  buildSanitizedEnvironment,
  terminateProcessTree,
  type ProcessExecutionResult,
  type ProcessHandle,
  type KillProcessTreeFunction,
  type SpawnFunction,
} from './process-adapter.js';
import { assertApprovalBindingMatchesCommand } from './approval-binding.js';

/**
 * Default kill-process-tree function.
 *
 * POSIX: Sends the signal to the process group (negative PID) so that
 * child processes in the same group are also terminated.
 *
 * Windows: Spawns `taskkill /T /F /PID <pid>` to terminate the process
 * and its descendants.
 */
export function defaultKillProcessTree(pid: number, signal?: string): boolean {
  const termSignal = signal ?? 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      require('node:child_process').execSync(
        `taskkill /T /F /PID ${pid}`,
        { stdio: 'ignore', windowsHide: true }
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, termSignal as NodeJS.Signals);
    return true;
  } catch {
    try {
      process.kill(pid, termSignal as NodeJS.Signals);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Internal entry for tracking an in-flight or queued execution.
 */
interface TerminalExecutionEntry {
  readonly terminalId: TerminalId;
  readonly request: TerminalExecutionRequest;
  state: TerminalLifecycleState;
  result: TerminalExecutionResult | null;
  abortController: AbortController;
  processHandle: ProcessHandle | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  resolve: ((value: TerminalExecutionResult) => void) | null;
  reject: ((reason: unknown) => void) | null;
}

/**
 * Options for TerminalExecutionService construction.
 */
export interface TerminalExecutionServiceOptions {
  readonly executableResolver: ExecutableResolver;
  readonly executablePolicy: ExecutablePolicy;
  readonly limits?: Partial<TerminalExecutionServiceLimits>;
  readonly logger?: Logger;
  readonly workspaceBoundaryValidator?: WorkspaceBoundaryValidator;
  readonly spawnFn?: SpawnFunction;
  readonly killProcessTreeFn?: KillProcessTreeFunction;
  readonly platform?: 'win32' | 'posix';
}

/**
 * Result of submitting an execution to the service.
 */
export interface TerminalExecutionSubmission {
  readonly terminalId: TerminalId;
  readonly promise: Promise<TerminalExecutionResult>;
}

/**
 * Extended limits that include concurrency and queue controls.
 */
export interface TerminalExecutionServiceLimits extends TerminalExecutionLimits {
  readonly maxConcurrentExecutions: number;
  readonly maxQueuedExecutions: number;
}

export const DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS: Required<TerminalExecutionServiceLimits> = {
  ...DEFAULT_TERMINAL_EXECUTION_LIMITS,
  maxConcurrentExecutions: 5,
  maxQueuedExecutions: 100,
};

/**
 * Creates a validated service limits object from partial input.
 */
export function createTerminalExecutionServiceLimits(
  input: Partial<TerminalExecutionServiceLimits> = {}
): TerminalExecutionServiceLimits {
  const merged: Record<string, unknown> = {
    ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
    ...input,
  };

  const fields: Array<keyof TerminalExecutionServiceLimits> = [
    'maxExecutableLength',
    'maxArgumentLength',
    'maxArgumentsCount',
    'maxWorkingDirectoryLength',
    'maxCommandLineLength',
    'maxOutputSizeBytes',
    'maxExecutionMs',
    'maxConcurrentExecutions',
    'maxQueuedExecutions',
  ];

  for (const field of fields) {
    const value = merged[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
        `Terminal execution service config '${field}' must be a positive integer`
      );
    }
  }

  return merged as unknown as TerminalExecutionServiceLimits;
}

/**
 * Terminal execution service. Manages process execution with lifecycle,
 * limits, cancellation, and disposal.
 */
export class TerminalExecutionService {
  private readonly executableResolver: ExecutableResolver;
  private readonly executablePolicy: ExecutablePolicy;
  private readonly limits: TerminalExecutionServiceLimits;
  private readonly logger: Logger;
  private readonly workspaceBoundaryValidator: WorkspaceBoundaryValidator | undefined;
  private readonly spawnFn: SpawnFunction;
  private readonly killProcessTreeFn: KillProcessTreeFunction;
  private readonly platform: 'win32' | 'posix';

  private readonly executions: Map<string, TerminalExecutionEntry> = new Map();
  private readonly queue: string[] = [];
  private activeCount = 0;
  private disposed = false;

  constructor(options: TerminalExecutionServiceOptions) {
    this.executableResolver = options.executableResolver;
    this.executablePolicy = options.executablePolicy;
    this.limits = createTerminalExecutionServiceLimits(options.limits);
    this.logger = options.logger ?? createNoopLogger();
    this.workspaceBoundaryValidator = options.workspaceBoundaryValidator;
    this.spawnFn = options.spawnFn ?? spawnControlledProcess;
    this.killProcessTreeFn = options.killProcessTreeFn ?? defaultKillProcessTree;
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  }

  /**
   * Submits a terminal execution request for processing.
   *
   * The request undergoes validation, approval binding verification,
   * executable resolution and policy re-check, workspace boundary
   * validation, and then process creation. If concurrency limits are
   * reached, the request is queued.
   *
   * @throws TerminalError if the request is invalid, the approval binding
   *         does not match, or the service is disposed.
   */
  submit(request: TerminalExecutionRequest): TerminalExecutionSubmission {
    if (this.disposed) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
        'Terminal execution service is disposed',
      );
    }

    // --- Validate the command structurally ---
    let validatedCommand: TerminalCommand;
    try {
      const validated = validateTerminalCommandSecurity(
        request.command,
        this.limits,
        this.workspaceBoundaryValidator
      );
      validatedCommand = validated.command;
    } catch (error) {
      if (isTerminalError(error)) {
        throw error;
      }
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        `Command validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // --- Verify approval binding (if present) ---
    if (request.approvalBinding !== undefined) {
      try {
        assertApprovalBindingMatchesCommand(
          request.approvalBinding,
          {
            executable: validatedCommand.executable,
            arguments: validatedCommand.arguments,
            workingDirectory: validatedCommand.workingDirectory,
            workspaceId: validatedCommand.workspaceId,
            environmentConfigId: validatedCommand.environmentConfig?.id,
          }
        );
      } catch (error) {
        if (isTerminalError(error)) {
          throw error;
        }
        throw createTerminalError(
          TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH,
          'Approval binding does not match the requested command',
          { terminalId: request.requestId }
        );
      }
    }

    // --- Create terminal ID and entry ---
    const terminalId = createTerminalId(request.requestId);
    const abortController = new AbortController();

    const entry: TerminalExecutionEntry = {
      terminalId,
      request,
      state: 'proposed',
      result: null,
      abortController,
      processHandle: null,
      timeoutTimer: null,
      resolve: null,
      reject: null,
    };

    const promise = new Promise<TerminalExecutionResult>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    this.executions.set(request.requestId, entry);

    // --- Transition lifecycle: proposed -> validating ---
    try {
      entry.state = applyTransition(entry.state, 'validating');
    } catch (error) {
      this.executions.delete(request.requestId);
      if (isTerminalError(error)) {
        throw error;
      }
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_TRANSITION,
        `Lifecycle transition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // --- Queue or execute immediately ---
    if (this.activeCount >= this.limits.maxConcurrentExecutions) {
      if (this.queue.length >= this.limits.maxQueuedExecutions) {
        this.failEntry(entry, TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION, 'Execution queue is full');
        this.executions.delete(request.requestId);
      } else {
        this.queue.push(request.requestId);
        entry.state = applyTransition(entry.state, 'awaiting-approval');
      }
    } else {
      this.startExecution(entry);
    }

    return { terminalId, promise };
  }

  /**
   * Cancels an in-flight or queued execution by terminal ID.
   *
   * @param terminalId - The terminal ID of the execution to cancel.
   * @param reason - The cancellation reason ('user', 'shutdown', or 'timeout').
   * @returns true if the cancellation was initiated, false if the terminal
   *         ID was not found or already terminal.
   */
  cancel(terminalId: TerminalId, reason: 'user' | 'shutdown' | 'timeout' = 'user'): boolean {
    const entry = this.findEntryByTerminalId(terminalId);
    if (!entry) {
      return false;
    }

    if (isTerminalState(entry.state)) {
      return false;
    }

    // Signal abort.
    entry.abortController.abort();

    // Kill the process if running.
    if (entry.processHandle !== null) {
      void terminateProcessTree(entry.processHandle, this.killProcessTreeFn);
    }

    // Clear timeout timer.
    if (entry.timeoutTimer !== null) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }

    // Transition to cancelled.
    try {
      entry.state = applyTransition(entry.state, 'cancelled');
    } catch {
      // If transition fails (e.g. already terminal), leave state as-is.
    }

    const startedAt = entry.processHandle !== null ? Date.now() : null;

    this.completeEntry(
      entry,
      {
        kind: 'terminal-execution-result',
        requestId: entry.request.requestId,
        terminalId,
        state: 'cancelled',
        exitCode: null,
        exitSignal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        outputSizeBytes: 0,
        startedAt,
        completedAt: Date.now(),
        executionMs: startedAt !== null ? Date.now() - startedAt : null,
        cancelled: true,
        timedOut: reason === 'timeout',
        error: {
          code: TerminalErrorCode.TERMINAL_CANCELLED,
          message: `Execution cancelled: ${reason}`,
        },
      }
    );

    return true;
  }

  /**
   * Returns the execution entry for a terminal ID, if it exists.
   */
  getExecution(terminalId: TerminalId): TerminalExecutionEntry | undefined {
    for (const entry of this.executions.values()) {
      if (entry.terminalId === terminalId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Returns the execution entry by request ID (internal key).
   */
  getEntryByRequestId(requestId: string): TerminalExecutionEntry | undefined {
    return this.executions.get(requestId);
  }

  /**
   * Disposes the service, cancelling all active and queued executions.
   *
   * After disposal, no new submissions are accepted. Active executions are
   * cancelled with reason 'shutdown'. The queue is cleared with all queued
   * executions rejected.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Cancel all active executions.
    for (const entry of this.executions.values()) {
      if (isActiveState(entry.state)) {
        this.cancel(entry.terminalId, 'shutdown');
      }
    }

    // Reject all queued executions.
    while (this.queue.length > 0) {
      const requestId = this.queue.shift()!;
      const entry = this.executions.get(requestId);
      if (entry) {
        this.failEntry(entry, TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION, 'Service disposed');
      }
    }

    this.executions.clear();
    this.activeCount = 0;
    this.queue.length = 0;
  }

  // ========================================================================
  // Private methods
  // ========================================================================

  private findEntryByTerminalId(terminalId: TerminalId): TerminalExecutionEntry | undefined {
    for (const entry of this.executions.values()) {
      if (entry.terminalId === terminalId) {
        return entry;
      }
    }
    return undefined;
  }

  private startExecution(entry: TerminalExecutionEntry): void {
    this.activeCount++;
    entry.state = applyTransition(entry.state, 'running');

    const request = entry.request;
    const command = entry.request.command;

    // --- Re-resolve executable immediately before spawn ---
    const resolutionOptions: ExecutableResolutionOptions = {
      platform: this.platform,
      cwd: command.workingDirectory,
    };

    let resolvedResolvedPath: string;
    let resolvedDisplayName: string;
    let resolvedPlatform: 'win32' | 'posix';

    try {
      const result = resolveExecutable(command.executable, resolutionOptions);
      if (result.kind === 'rejected' || !result.executable) {
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
          `Executable could not be resolved: ${result.reason ?? 'unknown reason'}`
        );
        return;
      }
      resolvedResolvedPath = result.executable.resolvedPath;
      resolvedDisplayName = result.executable.displayName;
      resolvedPlatform = result.executable.platform;
    } catch (error) {
      this.failEntry(
        entry,
        TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
        `Executable resolution failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // --- Re-check executable policy against resolved identity ---
    const permission = checkExecutablePermission(
      {
        resolve: () => ({
          kind: 'resolved',
          executable: {
            resolvedPath: resolvedResolvedPath,
            displayName: resolvedDisplayName,
            platform: resolvedPlatform,
          },
        }),
      },
      this.executablePolicy,
      command.executable,
      command.workingDirectory
    );

    if (!permission.permitted) {
      this.failEntry(
        entry,
        TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
        `Executable not permitted: ${permission.reason ?? 'policy denied'}`
      );
      return;
    }

    // --- Build sanitized environment ---
    const spawnEnv = buildSanitizedEnvironment({}, this.platform);

    // --- Set up timeout ---
    const timeoutMs = this.limits.maxExecutionMs;

    const executePromise = (async (): Promise<TerminalExecutionResult> => {
      try {
        const processResult = await spawnControlledProcess(
          resolvedResolvedPath,
          command.arguments,
          {
            cwd: command.workingDirectory,
            env: spawnEnv,
            signal: entry.abortController.signal,
            maxOutputBytes: this.limits.maxOutputSizeBytes,
            windowsHide: true,
          },
          this.spawnFn
        );

        entry.processHandle = null;

        // Map process result to terminal execution result.
        const state: TerminalLifecycleState =
          processResult.exitCode === 0 && !processResult.killed && !processResult.timedOut
            ? 'completed'
            : processResult.timedOut
              ? 'timed-out'
              : processResult.killed
                ? 'cancelled'
                : 'failed';

        const result: TerminalExecutionResult = {
          kind: 'terminal-execution-result',
          requestId: request.requestId,
          terminalId: entry.terminalId,
          state,
          exitCode: processResult.exitCode,
          exitSignal: processResult.exitSignal,
          stdout: processResult.stdout,
          stderr: processResult.stderr,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
          outputSizeBytes: processResult.outputSizeBytes,
          startedAt: processResult.startedAt,
          completedAt: processResult.completedAt,
          executionMs: processResult.executionMs,
          cancelled: processResult.killed,
          timedOut: processResult.timedOut,
          error: processResult.exitCode !== 0 && !processResult.killed && !processResult.timedOut
            ? {
                code: TerminalErrorCode.TERMINAL_INVALID_RESULT,
                message: `Process exited with code ${processResult.exitCode}`,
              }
            : null,
        };

        this.completeEntry(entry, result);
        return result;
      } catch (error) {
        entry.processHandle = null;
        if (isTerminalError(error)) {
          this.failEntry(entry, error.code, error.message);
          throw error;
        }
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_SPAWN_FAILED,
          `Process execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      } finally {
        this.activeCount--;
        this.processQueue();
      }
    })();

    // Set timeout timer.
    entry.timeoutTimer = setTimeout(() => {
      if (isActiveState(entry.state)) {
        entry.abortController.abort();
        this.cancel(entry.terminalId, 'timeout');
      }
    }, timeoutMs);

    // Fire and forget the execution promise; the result is delivered via
    // the submission promise returned from submit().
    void executePromise;
  }

  private processQueue(): void {
    while (this.activeCount < this.limits.maxConcurrentExecutions && this.queue.length > 0) {
      const requestId = this.queue.shift()!;
      const entry = this.executions.get(requestId);
      if (entry && isActiveState(entry.state)) {
        this.startExecution(entry);
      }
    }
  }

  private completeEntry(entry: TerminalExecutionEntry, result: TerminalExecutionResult): void {
    entry.state = applyTransition(entry.state, result.state as TerminalLifecycleState);
    entry.result = result;
    if (entry.resolve) {
      entry.resolve(result);
      entry.resolve = null;
    }
  }

  private failEntry(
    entry: TerminalExecutionEntry,
    code: TerminalErrorCode,
    message: string
  ): void {
    const state: TerminalLifecycleState = 'failed';
    try {
      entry.state = applyTransition(entry.state, state);
    } catch {
      // If already terminal, leave as-is.
    }
    entry.result = {
      kind: 'terminal-execution-result',
      requestId: entry.request.requestId,
      terminalId: entry.terminalId,
      state,
      exitCode: null,
      exitSignal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      outputSizeBytes: 0,
      startedAt: null,
      completedAt: Date.now(),
      executionMs: null,
      cancelled: false,
      timedOut: false,
      error: { code, message },
    };
    if (entry.reject) {
      entry.reject(createTerminalError(code, message, { terminalId: entry.terminalId }));
      entry.reject = null;
    }
  }

  /**
   * Returns the number of currently active executions.
   */
  get activeExecutions(): number {
    return this.activeCount;
  }

  /**
   * Returns the number of queued executions.
   */
  get queuedExecutions(): number {
    return this.queue.length;
  }

  /**
   * Returns whether the service is disposed.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }
}
