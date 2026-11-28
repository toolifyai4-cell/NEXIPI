/**
 * Phase 11 Stage B — Terminal execution domain contracts.
 *
 * Pure, platform-independent type definitions for terminal command execution.
 * No VS Code imports, no child_process imports, no filesystem access, no I/O.
 *
 * Three concepts are deliberately distinct and must never be treated as
 * interchangeable:
 *   1. TerminalCommand — the command the model proposes to run.
 *   2. ApprovalBinding — immutable binding of an approval to an exact request.
 *   3. TerminalExecutionResult — the observed outcome of execution.
 *
 * Environment secrets are never stored in these contracts. Environment
 * configuration is referenced by identity only; secret values are resolved
 * by the execution adapter at a later stage.
 */

export type TerminalId = string;

export function createTerminalId(id: string): TerminalId {
  return id;
}

export type EnvironmentConfigId = string;

export function createEnvironmentConfigId(id: string): EnvironmentConfigId {
  return id;
}

export type EnvironmentVariableName = string;

export function createEnvironmentVariableName(name: string): EnvironmentVariableName {
  return name;
}

/**
 * Lifecycle states for a terminal command execution.
 *
 * Active (non-terminal) states: proposed, validating, awaiting-approval,
 * approved, running.
 * Terminal states: completed, failed, rejected, cancelled, timed-out, disposed.
 *
 * `disposed` is a terminal cleanup state reachable from any active state
 * during extension shutdown; it overrides in-flight execution.
 */
export type TerminalLifecycleState =
  | 'proposed'
  | 'validating'
  | 'awaiting-approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'timed-out'
  | 'disposed';

export const ACTIVE_TERMINAL_STATES: readonly TerminalLifecycleState[] = [
  'proposed',
  'validating',
  'awaiting-approval',
  'approved',
  'running',
];

export const TERMINAL_STATES: readonly TerminalLifecycleState[] = [
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'timed-out',
  'disposed',
];

export function isTerminalLifecycleState(state: TerminalLifecycleState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActiveTerminalLifecycleState(state: TerminalLifecycleState): boolean {
  return ACTIVE_TERMINAL_STATES.includes(state);
}

/**
 * A reference to an environment configuration, not the values themselves.
 *
 * Secret values are never stored here. The identity is resolved to actual
 * environment variables by the execution adapter at execution time (Stage C).
 */
export interface EnvironmentConfigReference {
  readonly kind: 'environment-config-reference';
  readonly id: EnvironmentConfigId;
  readonly name?: string | undefined;
}

/**
 * The cancellation of an in-flight terminal execution.
 */
export interface CancellationRequest {
  readonly kind: 'cancellation-request';
  readonly requestId: string;
  readonly reason: 'user' | 'shutdown' | 'timeout';
  readonly requestedAt: number;
}

/**
 * Timeout bounds for a terminal execution.
 */
export interface TimeoutInfo {
  readonly kind: 'timeout-info';
  readonly maxExecutionMs: number;
  readonly deadlineAt: number;
  readonly expired: boolean;
}

/**
 * A terminal command proposed by the model.
 *
 * The executable and arguments are validated as data only. No shell
 * interpretation is implied by this contract.
 */
export interface TerminalCommand {
  readonly kind: 'terminal-command';
  readonly commandId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceId: string;
  readonly environmentConfig?: EnvironmentConfigReference | undefined;
  readonly proposedAt: number;
}

/**
 * An execution request derived from a validated terminal command.
 */
export interface TerminalExecutionRequest {
  readonly kind: 'terminal-execution-request';
  readonly requestId: string;
  readonly command: TerminalCommand;
  readonly approvalBinding?: ApprovalBinding | undefined;
  /**
   * Trusted authorization capability from Stage E's trusted approval
   * boundary. Must be present and verified through the injected
   * TrustedAuthorizationVerifier before execution may proceed. A plain
   * object with `decision: 'approved'` is never sufficient proof of
   * trusted user approval; only an opaque capability created exclusively
   * by the trusted boundary can authorize execution.
   */
  readonly trustedAuthorization?: TerminalAuthorizationCapability | undefined;
}

/**
 * Immutable binding of an approval to an exact terminal execution request.
 *
 * Changing any execution-relevant field (executable, arguments, working
 * directory, workspace, environment config identity) invalidates the
 * content hash and therefore the approval binding.
 *
 * NOTE: An ApprovalBinding only proves that execution parameters match a
 * particular binding. It does NOT prove that the user approved those
 * parameters. Trusted user authorization is represented separately by
 * `TrustedApprovalDecision`, which Stage E produces via
 * `TrustedApprovalService`.
 */
export interface ApprovalBinding {
  readonly kind: 'terminal-approval-binding';
  readonly bindingId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceId: string;
  readonly environmentConfigId?: EnvironmentConfigId | undefined;
  readonly contentHash: string;
  readonly createdAt: number;
}

/**
 * An opaque authorization capability produced exclusively by the trusted
 * approval boundary (Stage E via TrustedApprovalService).
 *
 * This is NOT a plain decision object. A caller cannot forge a valid
 * capability by constructing `{ decision: 'approved' }`. The capability
 * carries an unforgeable identifier and is bound to the exact execution
 * parameters via its content hash. Only the injected
 * TrustedAuthorizationVerifier can validate it.
 *
 * Stage D defines this contract and the verifier seam; Stage E implements
 * the verifier using TrustedApprovalService.createAuthorizationToApply().
 */
export interface TerminalAuthorizationCapability {
  readonly kind: 'terminal-authorization-capability';
  readonly capabilityId: string;
  readonly boundContentHash: string;
  readonly expiresAt?: number | undefined;
}

/**
 * The execution binding that an authorization capability must match.
 *
 * The verifier checks that the capability's boundContentHash equals the
 * SHA-256 of this exact binding, and that the capability is not expired.
 */
export interface TerminalAuthorizationBinding {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceId: string;
  readonly environmentConfigId: string | undefined;
  readonly contentHash: string;
}

/**
 * Trusted authorization verifier seam.
 *
 * Stage D defines this interface; Stage E implements it using the existing
 * TrustedApprovalService from Phase 10. The verifier is the sole authority
 * on whether a capability was created through the trusted boundary. Stage D
 * never creates capabilities and never trusts a caller-supplied object.
 */
export interface TrustedAuthorizationVerifier {
  /**
   * Verifies that an authorization capability is valid for the given
   * execution binding.
   *
   * @returns true only when the capability was created exclusively by the
   *          trusted approval boundary, is not expired, revoked, or
   *          mismatched, and binds to the exact execution parameters.
   * @throws when the verifier itself is unavailable or misconfigured.
   */
  verify(
    capability: TerminalAuthorizationCapability | undefined,
    binding: TerminalAuthorizationBinding
  ): Promise<boolean>;
}

/**
 * Stage E integration contract for trusted terminal authorization.
 *
 * Stage D defines the `TerminalAuthorizationCapability` contract and the
 * `TrustedAuthorizationVerifier` seam above; Stage E implements the verifier
 * using the existing Phase 10 `TrustedApprovalService`. Stage D never
 * creates capabilities and never trusts a caller-supplied object.
 *
 * Stage E flow:
 *   1. Present the command to the user.
 *      Stage E renders the exact terminal command (executable, ordered
 *      arguments, working directory, workspace identity, and environment
 *      configuration identity) for the user to review. Nothing is executed
 *      yet.
 *   2. Obtain the trusted decision through the existing approval service.
 *      Stage E asks the host-controlled trusted decision provider (the
 *      Phase 10 `TrustedDecisionProvider`, wired to a real confirmation UI
 *      in Stage F) to establish a genuine user decision. The provider's
 *      confirmed decision, boundary, and timestamps come from the provider,
   *      never from the model or caller, so a caller cannot forge a user
 *      decision. A cancelled, timed-out, or unavailable provider yields no
 *      decision and Stage E fails closed (no capability is created).
 *   3. Produce or retrieve the verified authorization capability.
 *      Only when the user decision is `approve` does Stage E call
 *      `TrustedApprovalService.createAuthorizationToApply(approvalId)`,
 *      which returns an `AuthorizationToApply` only when the approval is
 *      currently valid (approved state, trusted provenance, content hash
 *      match, not expired). Stage E converts that into a
 *      `TerminalAuthorizationCapability` (`kind`, `capabilityId`,
 *      `boundContentHash` = SHA-256 of the exact execution binding,
 *      `expiresAt`) and returns `null` when the decision was not `approve`
 *      or the approval cannot authorize. A rejected decision yields no
 *      capability at all.
 *   4. Pass it to the terminal execution service.
 *      Stage E builds a `TerminalExecutionRequest` whose `command` matches
 *      the capability's bound content hash exactly and whose
 *      `trustedAuthorization` is the capability from step 3, then calls
 *      `TerminalExecutionService.submit(request)`. Stage D verifies the
 *      capability through the injected `TrustedAuthorizationVerifier`
 *      before any process is created; a plain `{ decision: 'approved' }`
 *      object, a model-supplied object, or a missing capability fails
 *      closed.
 *   5. Ensure it cannot be reused for another command or modified request.
 *      The capability's `boundContentHash` is the SHA-256 of the exact
 *      execution binding (executable, ordered arguments, working directory,
 *      workspaceId, environmentConfigId). Stage D recomputes that hash from
 *      the submitted request and the verifier compares it to the
 *      capability's `boundContentHash`; any change to executable,
 *      arguments, working directory, workspace, or environment configuration
 *      produces a different hash and fails verification. Expiry is enforced
 *      via `expiresAt`. Single-use rejection (when the approval contract is
 *      single-use) is enforced by the verifier, which rejects a capability
 *      whose `capabilityId` has already been consumed. Stage E must not
 *      hand the same capability to two different submissions or two
 *      different commands.
 *
 * Security properties preserved from Phase 10:
 *   - Trusted provenance only: `model-tool-input`, `proposal-creation`, and
 *     `untrusted` provenance never authorize.
 *   - Retrieval alone never grants permission; only a verified, non-expired,
 *     non-revoked authorization bound to the exact execution parameters
 *     authorizes.
 *   - Fail closed: missing, expired, revoked, mismatched, or untrusted
 *     authorization rejects execution.
 */

/**
 * The observed outcome of a terminal command execution.
 *
 * Serialization-safe: secrets are never included. Output is captured and
 * bounded; truncation is explicitly flagged rather than silently dropped.
 */
export interface TerminalExecutionResult {
  readonly kind: 'terminal-execution-result';
  readonly requestId: string;
  readonly terminalId: TerminalId;
  readonly state: TerminalLifecycleState;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly outputSizeBytes: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly executionMs: number | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  /**
   * Termination status of the observed process exit.
   *
   * - 'confirmed': process exit was actually observed (via the child's
   *   'close' event or a resolved waitForExit promise).
   * - 'unconfirmed': termination was requested (cancel/timeout/dispose)
   *   but process exit was not confirmed — for example when waitForExit is
   *   unavailable or did not resolve within the bounded grace period.
   *   Sending SIGTERM/SIGKILL/taskkill is NOT treated as confirmation.
   * - 'not-applicable': no process was started (validation or authorization
   *   failure, disposed before start, queued disposal).
   */
  readonly terminationStatus: 'confirmed' | 'unconfirmed' | 'not-applicable';
  readonly error: { readonly code: string; readonly message: string } | null;
  /**
   * Trusted authorization capability that authorized this execution, if any.
   * Absent when execution was not approved or was cancelled before approval.
   */
  readonly trustedAuthorization?: TerminalAuthorizationCapability | undefined;
}

/**
 * Default execution limits for terminal commands.
 *
 * These are conservative defaults carried forward from Stage A. Final values
 * are subject to Stage C review and must be validated as positive integers.
 */
export interface TerminalExecutionLimits {
  readonly maxExecutableLength: number;
  readonly maxArgumentLength: number;
  readonly maxArgumentsCount: number;
  readonly maxWorkingDirectoryLength: number;
  readonly maxCommandLineLength: number;
  readonly maxOutputSizeBytes: number;
  readonly maxExecutionMs: number;
}

export const DEFAULT_TERMINAL_EXECUTION_LIMITS: TerminalExecutionLimits = {
  maxExecutableLength: 256,
  maxArgumentLength: 4096,
  maxArgumentsCount: 128,
  maxWorkingDirectoryLength: 4096,
  maxCommandLineLength: 8192,
  maxOutputSizeBytes: 1024 * 1024, // 1 MiB
  maxExecutionMs: 30_000,
};

export function isTerminalCommand(value: unknown): value is TerminalCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TerminalCommand).kind === 'terminal-command'
  );
}

export function isTerminalExecutionRequest(value: unknown): value is TerminalExecutionRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TerminalExecutionRequest).kind === 'terminal-execution-request'
  );
}

export function isTerminalExecutionResult(value: unknown): value is TerminalExecutionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TerminalExecutionResult).kind === 'terminal-execution-result'
  );
}

export function isApprovalBinding(value: unknown): value is ApprovalBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ApprovalBinding).kind === 'terminal-approval-binding'
  );
}
