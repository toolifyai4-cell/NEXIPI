/**
 * Phase 11 Stage E — Terminal approval and execution orchestrator.
 *
 * Orchestrates the security-controlled path from a proposed terminal command
 * to user approval, authorization verification, execution, and final result
 * delivery. It integrates the Phase 10 trusted approval architecture
 * (TrustedApprovalService, TrustedDecisionProvider) with the Phase 11 Stage D
 * TerminalExecutionService.
 *
 * Responsibilities:
 *   1. Receive a terminal execution proposal from the authorized caller.
 *   2. Validate the request structurally (Stage C validation).
 *   3. Resolve and validate the executable and execution context (Stage D).
 *   4. Compute the exact approval binding (content hash over executable,
 *      ordered arguments, working directory, workspace identity, environment
 *      config identity).
 *   5. Present the complete command details to the user through the trusted
 *      decision provider.
 *   6. Process approve, reject, cancel, and expiration outcomes.
 *   7. On genuine approval, obtain the authorization capability through the
 *      Phase 10 trusted approval boundary
 *      (TrustedApprovalService.createAuthorizationToApply).
 *   8. Pass the capability to TerminalExecutionService.submit().
 *   9. Allow the injected TrustedAuthorizationVerifier to independently
 *      verify the capability before process creation.
 *  10. Return the execution result or structured failure to the caller.
 *
 * Security:
 *   - Only a genuine trusted user decision produces an authorization
 *     capability. The capability is created exclusively by
 *     TrustedApprovalService (which requires the injected provider).
 *   - Caller-created approval objects and model-supplied provenance never
 *     authorize execution.
 *   - The exact approval binding is preserved end-to-end: any change to
 *     executable, arguments, cwd, workspace, or environment config
 *     invalidates the authorization.
 *   - Rejected, cancelled, expired, missing, invalid, or reused
 *     authorization fails closed.
 *   - No public execution path bypasses this orchestrator.
 */

import type {
  TerminalAuthorizationBinding,
  TerminalAuthorizationCapability,
  TerminalCommand,
  TerminalExecutionRequest,
  TerminalExecutionResult,
  TerminalExecutionService,
  TrustedAuthorizationVerifier,
  ValidatedTerminalCommand,
  WorkspaceBoundaryValidator,
  ExecutableResolver,
  TerminalExecutionServiceLimits,
} from '@nexipi/models/tools';
import type {
  ApprovalRepositoryPort,
  CreateApprovalView,
  TrustedApprovalService,
  TrustedDecisionProvider,
  TrustedUserDecision,
  TrustedUserDecisionRequest,
} from '@nexipi/workspace';
import type { Logger } from '@nexipi/core';
import { createNoopLogger } from '@nexipi/core';
import {
  computeContentHash,
  createApprovalBinding,
  defaultNow,
  validateTerminalCommandSecurity,
} from '@nexipi/models/tools';

/**
 * Options for {@link TerminalApprovalOrchestrator}.
 */
export interface TerminalApprovalOrchestratorOptions {
  trustedApprovalService: TrustedApprovalService;
  trustedDecisionProvider: TrustedDecisionProvider;
  approvals: ApprovalRepositoryPort;
  terminalExecutionService: TerminalExecutionService;
  executableResolver: ExecutableResolver;
  limits: TerminalExecutionServiceLimits;
  workspaceBoundaryValidator?: WorkspaceBoundaryValidator;
  now?: () => number;
  createApprovalId?: () => string;
  logger?: Logger;
}

/**
 * Outcome of the approval presentation step.
 */
type ApprovalOutcome =
  | { kind: 'approved'; capability: TerminalAuthorizationCapability }
  | { kind: 'rejected' }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  | { kind: 'failed'; error: Error };

/**
 * Terminal approval and execution orchestrator.
 */
export class TerminalApprovalOrchestrator {
  private readonly service: TrustedApprovalService;
  private readonly provider: TrustedDecisionProvider;
  private readonly approvals: ApprovalRepositoryPort;
  private readonly executionService: TerminalExecutionService;
  private readonly executableResolver: ExecutableResolver;
  private readonly executablePolicy: ExecutablePolicy;
  private readonly limits: TerminalExecutionServiceLimits;
  private readonly workspaceBoundaryValidator: WorkspaceBoundaryValidator | undefined;
  private readonly now: () => number;
  private readonly createApprovalId: () => string;
  private readonly logger: Logger;

  private _isDisposed = false;
  private readonly pendingApprovals = new Map<string, { abortController: AbortController }>();
  private activeExecutionCount = 0;

  constructor(options: TerminalApprovalOrchestratorOptions) {
    this.service = options.trustedApprovalService;
    this.provider = options.trustedDecisionProvider;
    this.approvals = options.approvals;
    this.executionService = options.terminalExecutionService;
    this.executableResolver = options.executableResolver;
    this.limits = options.limits;
    this.workspaceBoundaryValidator = options.workspaceBoundaryValidator;
    this.now = options.now ?? defaultNow;
    this.createApprovalId = options.createApprovalId ?? (() => crypto.randomUUID());
    this.logger = options.logger ?? createNoopLogger();
  }

  /**
   * Returns whether the orchestrator is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Executes the full terminal approval and execution lifecycle for a
   * proposed terminal command.
   *
   * @param command - The terminal command proposed by the caller.
   * @param options - Optional expiry and abort signal.
   * @returns A TerminalExecutionResult reflecting the observed outcome.
   */
  async executeTerminalCommand(
    command: TerminalCommand,
    options: { expiresAt?: number; abortSignal?: AbortSignal } = {}
  ): Promise<TerminalExecutionResult> {
    if (this._isDisposed) {
      return this.createTerminalResult({
        command,
        state: 'rejected',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: {
          code: 'TERMINAL_UNSUPPORTED_CONFIGURATION',
          message: 'Terminal approval orchestrator is disposed',
        },
      });
    }

    // Handle external cancellation.
    if (options.abortSignal?.aborted) {
      return this.createTerminalResult({
        command,
        state: 'cancelled',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: true,
        timedOut: false,
        error: null,
      });
    }

    // --- Step 1 & 2: Validate the request structurally ---
    let validated: ValidatedTerminalCommand;
    try {
      validated = await validateTerminalCommandSecurity(
        command,
        this.limits,
        this.workspaceBoundaryValidator
      );
    } catch (error) {
      this.logger.warn('Terminal command validation failed', {
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: this.toTerminalError(error),
      });
    }

    const cmd = validated.command;

    // --- Step 3: Resolve and validate the executable ---
    let resolution: { kind: 'resolved' | 'rejected'; executable?: { resolvedPath: string; displayName: string; platform: string }; reason?: string };
    try {
      resolution = await this.executableResolver.resolve(cmd.executable, cmd.workingDirectory);
    } catch (error) {
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: {
          code: 'TERMINAL_INVALID_IDENTITY',
          message: `Executable resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
    if (resolution.kind === 'rejected' || !resolution.executable) {
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: {
          code: 'TERMINAL_INVALID_IDENTITY',
          message: `Executable could not be resolved: ${resolution.reason ?? 'unknown reason'}`,
        },
      });
    }

    // --- Step 4: Compute the exact approval binding ---
    const bindingId = this.createApprovalId();
    const binding = createApprovalBinding({
      bindingId,
      executable: cmd.executable,
      arguments: cmd.arguments,
      workingDirectory: cmd.workingDirectory,
      workspaceId: cmd.workspaceId,
      environmentConfigId: cmd.environmentConfig?.id,
    });

    // --- Step 5: Present the command to the user through the trusted provider ---
    let outcome: ApprovalOutcome;
    try {
      outcome = await this.presentForApproval(cmd, binding, options.expiresAt, options.abortSignal);
    } catch (error) {
      this.logger.error('Approval presentation failed', {
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: this.toTerminalError(error),
      });
    }

    // --- Step 6: Process the approval outcome ---
    if (outcome.kind === 'cancelled') {
      return this.createTerminalResult({
        command,
        state: 'cancelled',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: true,
        timedOut: false,
        error: null,
      });
    }
    if (outcome.kind === 'rejected') {
      return this.createTerminalResult({
        command,
        state: 'rejected',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: null,
      });
    }
    if (outcome.kind === 'expired') {
      return this.createTerminalResult({
        command,
        state: 'rejected',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: {
          code: 'TERMINAL_INVALID_REQUEST',
          message: 'Approval expired before execution could proceed',
        },
      });
    }
    if (outcome.kind === 'failed') {
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: {
          code: 'TERMINAL_INVALID_REQUEST',
          message: outcome.error.message,
        },
      });
    }

    // --- Steps 7-9: Approved. The capability was produced by the trusted ---
    // boundary and will be independently verified by the injected verifier ---
    // inside TerminalExecutionService.submit() before any process is created.
    const request: TerminalExecutionRequest = {
      kind: 'terminal-execution-request',
      requestId: this.createApprovalId(),
      command: cmd,
      approvalBinding: binding,
      trustedAuthorization: outcome.capability,
    };

    this.activeExecutionCount++;
    try {
      const submission = this.executionService.submit(request);
      const result = await submission.promise;
      return result;
    } catch (error) {
      this.logger.error('Terminal execution submission failed', {
        commandId: command.commandId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createTerminalResult({
        command,
        state: 'failed',
        terminationStatus: 'not-applicable',
        exitCode: null,
        exitSignal: null,
        cancelled: false,
        timedOut: false,
        error: this.toTerminalError(error),
      });
    } finally {
      this.activeExecutionCount--;
    }
  }

  /**
   * Cancels a pending approval by binding ID. Used during disposal.
   */
  cancelPendingApproval(bindingId: string): boolean {
    const pending = this.pendingApprovals.get(bindingId);
    if (!pending) {
      return false;
    }
    pending.abortController.abort();
    this.pendingApprovals.delete(bindingId);
    return true;
  }

  /**
   * Disposes the orchestrator, cancelling pending approvals and awaiting
   * active execution disposal through the terminal execution service.
   */
  async dispose(): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;

    // Cancel all pending approvals so no trusted decision can be established
    // after disposal.
    for (const [bindingId, pending] of this.pendingApprovals.entries()) {
      pending.abortController.abort();
    }
    this.pendingApprovals.clear();

    // Dispose the terminal execution service, which cancels active and
    // queued executions and awaits bounded termination.
    await this.executionService.dispose();

    this.logger.info('Terminal approval orchestrator disposed');
  }

  // ========================================================================
  // Private methods
  // ========================================================================

  /**
   * Presents the terminal command to the user through the trusted decision
   * provider and processes the outcome.
   */
  private async presentForApproval(
    command: TerminalCommand,
    binding: { readonly contentHash: string; readonly bindingId: string },
    expiresAt: number | undefined,
    abortSignal?: AbortSignal
  ): Promise<ApprovalOutcome> {
    const now = this.now();

    // Expiry gate before presenting: if the request has already expired,
    // fail closed without showing the dialog.
    if (expiresAt !== null && expiresAt !== undefined && now > expiresAt) {
      return { kind: 'expired' };
    }

    const decisionRequest: TrustedUserDecisionRequest = {
      proposalId: command.commandId,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: command.workspaceId,
      fileUri: `terminal://command/${command.commandId}`,
      expiresAt: expiresAt ?? null,
      terminalCommand: {
        executable: command.executable,
        arguments: command.arguments,
        workingDirectory: command.workingDirectory,
        environmentConfigId: command.environmentConfig?.id,
      },
    };

    // Track the pending approval so it can be cancelled on disposal.
    const abortController = new AbortController();
    this.pendingApprovals.set(binding.bindingId, { abortController });

    // Combine external abort signal with our internal one.
    const combinedSignal = this.combineSignals(abortSignal, abortController.signal);

    try {
      const confirmed: TrustedUserDecision | null = await this.provider.establishUserDecision(decisionRequest);

      if (confirmed === null) {
        // User cancelled, dismissed, or provider unavailable -> fail closed.
        return { kind: 'cancelled' };
      }

      if (confirmed.decision === 'reject') {
        return { kind: 'rejected' };
      }

      // Expiry gate after the dialog resolves: the request may have expired
      // while the user was considering the dialog.
      const decidedNow = this.now();
      if (decisionRequest.expiresAt !== null && decidedNow > decisionRequest.expiresAt) {
        return { kind: 'expired' };
      }

      // --- Step 7: Obtain the authorization capability through the Phase 10 ---
      // trusted approval boundary. Create an approval record (trusted-boundary
      // provenance from the provider's confirmed decision), then derive the
      // authorization capability via createAuthorizationToApply.
      const approvalId = this.createApprovalId();
      const approval: CreateApprovalView = {
        id: approvalId,
        proposalId: command.commandId,
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: binding.contentHash,
        decidedAt: confirmed.decidedAt ?? now,
        provenance: { kind: 'trusted-boundary', boundary: confirmed.boundary },
        lifecycleState: 'approved',
        expiresAt: confirmed.expiresAt ?? null,
        workspaceId: command.workspaceId,
        fileUri: `terminal://command/${command.commandId}`,
        createdAt: now,
      };

      const createResult = await this.approvals.createApproval(approval);
      if (createResult.error !== null || createResult.approval === null) {
        this.logger.error('Failed to persist approval decision', {
          approvalId,
          error: createResult.error?.message ?? 'unknown error',
        });
        return { kind: 'failed', error: createResult.error ?? new Error('Failed to persist approval decision') };
      }

      // Obtain the authorization capability from the trusted boundary. This
      // returns non-null only when the approval is currently valid (approved
      // state, trusted provenance, content hash match, not expired).
      const authorization = await this.service.createAuthorizationToApply(approvalId, now);
      if (authorization === null) {
        this.logger.warn('Trusted boundary could not derive authorization', {
          approvalId,
        });
        return { kind: 'expired' };
      }

      const capability: TerminalAuthorizationCapability = {
        kind: 'terminal-authorization-capability',
        capabilityId: authorization.approvalId,
        boundContentHash: authorization.contentHash,
        expiresAt: approval.expiresAt,
      };

      return { kind: 'approved', capability };
    } catch (error) {
      if (combinedSignal?.aborted) {
        return { kind: 'cancelled' };
      }
      throw error;
    } finally {
      this.pendingApprovals.delete(binding.bindingId);
    }
  }

  /**
   * Combines an external AbortSignal with an internal one. Returns a signal
   * that is aborted when either is aborted.
   */
  private combineSignals(
    external: AbortSignal | undefined,
    internal: AbortSignal
  ): AbortSignal | undefined {
    if (!external) {
      return internal;
    }
    if (external.aborted || internal.aborted) {
      return external;
    }
    // Use a new AbortController that mirrors both signals.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    external.addEventListener('abort', abort, { once: true });
    internal.addEventListener('abort', abort, { once: true });
    return controller.signal;
  }

  /**
   * Builds a TerminalExecutionResult for non-execution outcomes (validation
   * failure, rejection, cancellation, disposal).
   */
  private createTerminalResult(params: {
    command: TerminalCommand;
    state: TerminalExecutionResult['state'];
    terminationStatus: TerminalExecutionResult['terminationStatus'];
    exitCode: number | null;
    exitSignal: string | null;
    cancelled: boolean;
    timedOut: boolean;
    error: { code: string; message: string } | null;
  }): TerminalExecutionResult {
    const now = Date.now();
    return {
      kind: 'terminal-execution-result',
      requestId: this.createApprovalId(),
      terminalId: this.createApprovalId(),
      state: params.state,
      exitCode: params.exitCode,
      exitSignal: params.exitSignal,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      outputSizeBytes: 0,
      startedAt: null,
      completedAt: now,
      executionMs: null,
      cancelled: params.cancelled,
      timedOut: params.timedOut,
      terminationStatus: params.terminationStatus,
      error: params.error,
    };
  }

  /**
   * Converts an unknown error to a terminal error descriptor.
   */
  private toTerminalError(error: unknown): { code: string; message: string } {
    if (error instanceof Error) {
      return { code: 'TERMINAL_INVALID_REQUEST', message: error.message };
    }
    return { code: 'TERMINAL_INVALID_REQUEST', message: String(error) };
  }
}
