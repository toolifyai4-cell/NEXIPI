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
import { applyTransition, isActiveState, isTerminalState } from './lifecycle.js';
import { TerminalErrorCode, createTerminalError, isTerminalError } from './errors.js';
import type {
  TerminalExecutionLimits,
  TerminalExecutionRequest,
  TerminalExecutionResult,
  TerminalId,
  TerminalLifecycleState,
  TerminalAuthorizationBinding,
  TrustedAuthorizationVerifier,
} from './contracts.js';
import { createTerminalId, DEFAULT_TERMINAL_EXECUTION_LIMITS } from './contracts.js';
import { validateTerminalCommandSecurity } from './command-validation.js';
import type { WorkspaceBoundaryValidator } from './command-validation.js';
import {
  checkExecutablePermission,
  type ExecutablePolicy,
  type ExecutableResolver,
} from './executable-policy.js';
import { computeContentHash } from './approval-binding.js';
import {
  spawnControlledProcess,
  buildSanitizedEnvironment,
  terminateProcessTree,
  defaultKillProcessTree,
  type ProcessHandle,
  type KillProcessTreeFunction,
  type SpawnFunction,
} from './process-adapter.js';
import { assertApprovalBindingMatchesCommand } from './approval-binding.js';

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
  /**
   * Records why this execution was cancelled, if it was cancelled.
   * Used to distinguish user cancellation, timeout, and disposal in the
   * final result, since the abort signal alone cannot carry that reason.
   */
  cancelReason: 'user' | 'shutdown' | 'timeout' | undefined;
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
  /**
   * Trusted authorization verifier. Required for any execution to proceed.
   * Stage E implements this using TrustedApprovalService. When omitted, all
   * submissions fail closed.
   */
  readonly trustedAuthorizationVerifier?: TrustedAuthorizationVerifier;
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
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
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
  private readonly trustedAuthorizationVerifier: TrustedAuthorizationVerifier | undefined;

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
    this.spawnFn = options.spawnFn ?? (spawnControlledProcess as unknown as SpawnFunction);
    this.killProcessTreeFn = options.killProcessTreeFn ?? defaultKillProcessTree;
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.trustedAuthorizationVerifier = options.trustedAuthorizationVerifier;
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
        'Terminal execution service is disposed'
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
      cancelReason: undefined,
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
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
          'Service disposed'
        );
        return;
      }

      try {
        // --- Validate the command structurally ---
        const validated = await validateTerminalCommandSecurity(
          request.command,
          this.limits,
          this.workspaceBoundaryValidator
        );

        // --- Require approval binding ---
        // An ApprovalBinding is mandatory for every execution. Stage E owns
        // trusted user approval UI and persistence; Stage D enforces that
        // no command reaches spawn without a verified binding.
        if (request.approvalBinding === undefined) {
          this.failEntry(
            entry,
            TerminalErrorCode.TERMINAL_INVALID_REQUEST,
            'Execution requires an approval binding'
          );
          return;
        }

        // --- Verify approval binding ---
        try {
          assertApprovalBindingMatchesCommand(request.approvalBinding, {
            executable: validated.command.executable,
            arguments: validated.command.arguments,
            workingDirectory: validated.command.workingDirectory,
            workspaceId: validated.command.workspaceId,
            environmentConfigId: validated.command.environmentConfig?.id,
          });
        } catch (error) {
          if (isTerminalError(error)) {
            this.failEntry(entry, error.code, error.message);
            return;
          }
          this.failEntry(
            entry,
            TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH,
            'Approval binding does not match the requested command'
          );
          return;
        }

        // --- Require trusted authorization ---
        // An ApprovalBinding only proves parameter matching; it does NOT
        // prove trusted user approval. Stage D never trusts a caller-supplied
        // object. Authorization must be verified through the injected
        // TrustedAuthorizationVerifier, which Stage E implements using
        // TrustedApprovalService. Fail closed when the verifier is absent
        // or when verification fails.
        if (!this.trustedAuthorizationVerifier) {
          this.failEntry(
            entry,
            TerminalErrorCode.TERMINAL_INVALID_REQUEST,
            'Terminal execution requires a trusted authorization verifier',
          );
          return;
        }

        const binding: TerminalAuthorizationBinding = {
          executable: validated.command.executable,
          arguments: validated.command.arguments,
          workingDirectory: validated.command.workingDirectory,
          workspaceId: validated.command.workspaceId,
          environmentConfigId: validated.command.environmentConfig?.id ?? undefined,
          contentHash: computeContentHash({
            executable: validated.command.executable,
            arguments: validated.command.arguments,
            workingDirectory: validated.command.workingDirectory,
            workspaceId: validated.command.workspaceId,
            environmentConfigId: validated.command.environmentConfig?.id,
          }),
        };

        const authorized = await this.trustedAuthorizationVerifier.verify(
          request.trustedAuthorization,
          binding,
        );
        if (!authorized) {
          this.failEntry(
            entry,
            TerminalErrorCode.TERMINAL_INVALID_REQUEST,
            'Execution is not authorized by a trusted user decision',
          );
          return;
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
            this.failEntry(
              entry,
              TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
              'Execution queue is full'
            );
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
            `Command validation failed: ${error instanceof Error ? error.message : String(error)}`
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

    // Signal abort so the spawn adapter kills the child process. This is
    // required even when the process handle is not yet stored (e.g. cancel
    // racing with spawn startup).
    try {
      if (!entry.abortController.signal.aborted) {
        entry.abortController.abort();
      }
    } catch {
      // AbortController may already be aborted; safe to ignore.
    }

    // Record the cancellation reason so the final result can distinguish
    // user cancellation, timeout, and disposal.
    entry.cancelReason = reason;

    // Kill the process tree if a handle is available.
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
    try {
      entry.state = applyTransition(entry.state, 'cancelled');
    } catch {
      try {
        entry.state = applyTransition(entry.state, 'disposed');
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
      trustedAuthorization: entry.request.trustedAuthorization,
    };
    entry.result = cancelledResult;
    if (entry.reject) {
      entry.reject(
        createTerminalError(
          TerminalErrorCode.TERMINAL_CANCELLED,
          `Execution cancelled: ${reason}`,
          { terminalId }
        )
      );
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
        this.failEntry(
          entry,
          TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
          'Service disposed'
        );
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
    const resolution = this.executableResolver.resolve(
      command.executable,
      command.workingDirectory
    );
    Promise.resolve(resolution)
      .then(async result => {
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

        void (async (): Promise<void> => {
          try {
            const { handle, result } = await spawnControlledProcess(
              resolvedExecutable.resolvedPath,
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

            // Store the real process handle so cancellation can terminate it.
            entry.processHandle = handle;

            const processResult = result;
            entry.processHandle = null;

            // Determine final state and timedOut. If the execution was
            // cancelled (user, timeout, or disposal), the cancel reason
            // takes precedence over the process adapter's timedOut flag,
            // because the abort signal fires for both cancellation and
            // timeout and the adapter cannot distinguish them.
            let state: TerminalLifecycleState;
            let timedOut: boolean;
            if (entry.cancelReason === 'timeout') {
              state = 'timed-out';
              timedOut = true;
            } else if (entry.cancelReason !== undefined) {
              state = 'cancelled';
              timedOut = false;
            } else {
              timedOut = processResult.timedOut;
              state =
                processResult.exitCode === 0 && !processResult.killed && !timedOut
                  ? 'completed'
                  : timedOut
                    ? 'timed-out'
                    : processResult.killed
                      ? 'cancelled'
                      : 'failed';
            }

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
              cancelled: state === 'cancelled' || state === 'timed-out',
              timedOut,
              error:
                processResult.exitCode !== 0 && !processResult.killed && !timedOut
                  ? {
                      code: TerminalErrorCode.TERMINAL_INVALID_RESULT,
                      message: `Process exited with code ${processResult.exitCode}`,
                    }
                  : null,
              trustedAuthorization: request.trustedAuthorization,
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
      })
      .catch(error => {
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
    let transitioned = false;
    try {
      entry.state = applyTransition(entry.state, result.state as TerminalLifecycleState);
      transitioned = true;
    } catch {
      // If already terminal (e.g. disposed during cancellation), keep current
      // state and result — late events must not overwrite a settled outcome.
    }
    if (transitioned) {
      entry.result = result;
      if (entry.resolve) {
        entry.resolve(result);
        entry.resolve = null;
      }
    }
  }

  private failEntry(entry: TerminalExecutionEntry, code: TerminalErrorCode, message: string): void {
    const state: TerminalLifecycleState = 'failed';
    let transitioned = false;
    try {
      entry.state = applyTransition(entry.state, state);
      transitioned = true;
    } catch {
      // If already terminal, keep current state and result.
    }
    if (transitioned) {
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
        trustedAuthorization: entry.request.trustedAuthorization,
      };
    }
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
