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
}

/**
 * Immutable binding of an approval to an exact terminal execution request.
 *
 * Changing any execution-relevant field (executable, arguments, working
 * directory, workspace, environment config identity) invalidates the
 * content hash and therefore the approval binding.
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
  readonly error: { readonly code: string; readonly message: string } | null;
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
