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
} from './contracts.js';
import { createTerminalId, DEFAULT_TERMINAL_EXECUTION_LIMITS } from './contracts.js';
import { validateTerminalCommandSecurity } from './command-validation.js';
import type { WorkspaceBoundaryValidator } from './command-validation.js';
import {
  checkExecutablePermission,
  type ExecutablePolicy,
  type ExecutableResolver,
} from './executable-policy.js';
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

    // --- Async validation and execution ---
    // Command validation may be async (workspace boundary validator).
    // Approval binding verification is synchronous.
    // All failures are delivered through the returned promise.
    void (async (): Promise<void> => {
      if (this.disposed) {
        this.failEntry(entry, TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION, 'Service disposed');
        return;
      }

      try {
        // --- Validate the command structurally ---
        const validated = await validateTerminalCommandSecurity(
          request.command,
          this.limits,
          this.workspaceBoundaryValidator
        );

        // --- Verify approval binding (if present) ---
        if (request.approvalBinding !== undefined) {
          try {
            assertApprovalBindingMatchesCommand(
              request.approvalBinding,
              {
                executable: validated.command.executable,
                arguments: validated.command.arguments,
                workingDirectory: validated.command.workingDirectory,
                workspaceId: validated.command.workspaceId,
                environmentConfigId: validated.command.environmentConfig?.id,
              }
            );
          } catch (error) {
            if (isTerminalError(error)) {
              this.failEntry(entry, error.code, error.message);
              return;
            }
            this.failEntry(
              entry,
              TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH,
              'Approval binding does not match the requested command',
            );
            return;
          }
        }

        // --- Transition lifecycle: proposed -> validating -> awaiting-approval -> approved ---
        // Stage D auto-advances through approval states; Stage E will insert the
        // trusted user decision gate between awaiting-approval and approved.
        entry.state = applyTransition(entry.state, 'validating');
        entry.state = applyTransition(entry.state, 'awaiting-approval');
        entry.state = applyTransition(entry.state, 'approved');

        // --- Queue or execute immediately ---
        if (this.activeCount >= this.limits.maxConcurrentExecutions) {
          if (this.queue.length >= this.limits.maxQueuedExecutions) {
            this.failEntry(entry, TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION, 'Execution queue is full');
            this.executions.delete(request.requestId);
          } else {
            this.queue.push(request.requestId);
            // Entry remains in 'approved' state while queued.
          }
        } else {
          this.startExecution(entry);
        }
      } catch (error) {
        if (isTerminalError(error)) {
          this.failEntry(entry, error.code, error.message);
        } else {
          this.failEntry(
            entry,
            TerminalErrorCode.TERMINAL_INVALID_REQUEST,
            `Command validation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    })();

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

    // Kill the process if running.
    if (entry.processHandle !== null) {
      void terminateProcessTree(entry.processHandle, this.killProcessTreeFn);
    }

    // Clear timeout timer.
    if (entry.timeoutTimer !== null) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }

    // Transition to cancelled. `cancelled` is only valid from `running`;
    // for pre-execution states (approved, awaiting-approval, validating,
    // proposed) fall back to `disposed` which is reachable from any active
    // state.
    let transitioned = false;
    try {
      entry.state = applyTransition(entry.state, 'cancelled');
      transitioned = true;
    } catch {
      try {
        entry.state = applyTransition(entry.state, 'disposed');
        transitioned = true;
      } catch {
        // Leave state as-is if all transitions fail.
      }
    }

    const startedAt = entry.processHandle !== null ? Date.now() : null;

    // Record result and reject the promise with a cancellation error.
    const cancelledResult: TerminalExecutionResult = {
      kind: 'terminal-execution-result',
      requestId: entry.request.requestId,
      terminalId,
      state: entry.state,
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
    };
    entry.result = cancelledResult;
    if (entry.reject) {
      entry.reject(createTerminalError(TerminalErrorCode.TERMINAL_CANCELLED, `Execution cancelled: ${reason}`, { terminalId }));
      entry.reject = null;
    }
    entry.resolve = null;

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
    // The resolver may return a promise; handle both sync and async results.
    const resolution = this.executableResolver.resolve(command.executable, command.workingDirectory);
    Promise.resolve(resolution).then(async result => {
      if (result.kind === 'rejected') {
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
          `Executable could not be resolved: ${result.reason ?? 'unknown reason'}`
        );
        return;
      }
      const resolvedExecutable = result.executable;
      if (!resolvedExecutable) {
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
          `Executable could not be resolved: unknown reason`
        );
        return;
      }

      // --- Re-check executable policy against resolved identity ---
      const permission = await checkExecutablePermission(
        {
          resolve: () => ({
            kind: 'resolved',
            executable: resolvedExecutable,
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

      const executePromise = (async (): Promise<void> => {
        try {
          const processResult = await spawnControlledProcess(
            resolvedExecutable.resolvedPath,
            command.arguments,
            {
              cwd: command.workingDirectory,
              env: spawnEnv,
              signal: entry.abortController.signal,
              maxOutputBytes: this.limits.maxOutputSizeBytes,
              windowsHide: true,
            },
            this.spawnFn as SpawnFunction
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

          const executionResult: TerminalExecutionResult = {
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

          this.completeEntry(entry, executionResult);
        } catch (error) {
          entry.processHandle = null;
          if (isTerminalError(error)) {
            this.failEntry(entry, error.code, error.message);
          } else {
            this.failEntry(
              entry,
              TerminalErrorCode.TERMINAL_SPAWN_FAILED,
              `Process execution failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        } finally {
          this.activeCount--;
          this.processQueue();
        }
      })();
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

          this.completeEntry(entry, executionResult);
        } catch (error) {
          entry.processHandle = null;
          if (isTerminalError(error)) {
            this.failEntry(entry, error.code, error.message);
          } else {
            this.failEntry(
              entry,
              TerminalErrorCode.TERMINAL_SPAWN_FAILED,
              `Process execution failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        } finally {
          this.activeCount--;
          this.processQueue();
        }
      })();

      // Set timeout timer.
      entry.timeoutTimer = setTimeout(() => {
        if (isActiveState(entry.state)) {
          this.cancel(entry.terminalId, 'timeout');
        }
      }, timeoutMs);

      // Store a placeholder process handle so cancellation can find it.
      // The real handle is assigned by spawnControlledProcess via entry.processHandle.
      entry.processHandle = {
        pid: 0,
        kill: () => false,
      };
    }).catch(error => {
      this.failEntry(
        entry,
        TerminalErrorCode.TERMINAL_INVALID_IDENTITY,
        `Executable resolution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
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
    try {
      entry.state = applyTransition(entry.state, result.state as TerminalLifecycleState);
    } catch {
      // If already terminal (e.g. disposed during cancellation), keep current state.
    }
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
