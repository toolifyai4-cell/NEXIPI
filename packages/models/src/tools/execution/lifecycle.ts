/**
 * Phase 11 Stage B — Terminal execution lifecycle state machine.
 *
 * Pure, deterministic lifecycle logic for terminal command execution. No
 * filesystem access, no VS Code imports, no child_process imports, no I/O
 * of any kind. Fully testable without actual processes.
 *
 * Lifecycle states:
 *   proposed            - command proposed by the model
 *   validating          - command under domain validation (Stage C)
 *   awaiting-approval   - valid, waiting for trusted user approval (Stage E)
 *   approved            - trusted user approved; bound to exact request
 *   running             - command executing under the adapter
 *   completed           - exited successfully (terminal)
 *   failed              - exited with error (terminal)
 *   rejected            - validation or approval rejected (terminal)
 *   cancelled           - cancelled by user/shutdown/timeout (terminal)
 *   timed-out           - exceeded execution deadline (terminal)
 *   disposed            - extension shutdown cleanup (terminal; overrides any active state)
 *
 * Valid transitions:
 *   proposed -> validating
 *   validating -> awaiting-approval | rejected
 *   awaiting-approval -> approved | rejected
 *   approved -> running
 *   running -> completed | failed | cancelled | timed-out
 *   any active state -> disposed (extension shutdown)
 *   same-state transitions are idempotent (no-op)
 *
 * Every other cross-state transition is forbidden and throws TerminalError,
 * which guarantees rejection/expiration/cancellation can never be reinterpreted
 * as approval or completion.
 */

import type { TerminalLifecycleState } from './contracts.js';
import { TerminalErrorCode, createTerminalError } from './errors.js';

const VALID_TRANSITIONS: Record<TerminalLifecycleState, readonly TerminalLifecycleState[]> = {
  proposed: ['validating', 'disposed'],
  validating: ['awaiting-approval', 'rejected', 'disposed'],
  'awaiting-approval': ['approved', 'rejected', 'disposed'],
  approved: ['running', 'disposed'],
  running: ['completed', 'failed', 'cancelled', 'timed-out', 'disposed'],
  completed: [],
  failed: [],
  rejected: [],
  cancelled: [],
  'timed-out': [],
  disposed: [],
};

const ACTIVE_STATES: ReadonlySet<TerminalLifecycleState> = new Set([
  'proposed',
  'validating',
  'awaiting-approval',
  'approved',
  'running',
]);

const TERMINAL_STATES: ReadonlySet<TerminalLifecycleState> = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'timed-out',
  'disposed',
]);

/**
 * Applies a lifecycle state transition.
 *
 * Same-state (duplicate) transitions are idempotent and return the current
 * state without error. Any other transition not in the valid set is forbidden
 * and throws TerminalError.
 *
 * @throws TerminalError with code TERMINAL_INVALID_TRANSITION for
 *         forbidden or conflicting transitions.
 */
export function applyTransition(
  currentState: TerminalLifecycleState,
  nextState: TerminalLifecycleState
): TerminalLifecycleState {
  if (currentState === nextState) {
    return currentState;
  }
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed || !allowed.includes(nextState)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_TRANSITION,
      `Invalid terminal lifecycle transition from '${currentState}' to '${nextState}'`
    );
  }
  return nextState;
}

/**
 * Transitions any active state to `disposed` during extension shutdown.
 *
 * `disposed` is terminal and overrides in-flight execution. Transitioning
 * from an already-terminal state to `disposed` is forbidden (throws), which
 * prevents late asynchronous events from overwriting a settled result.
 *
 * @throws TerminalError when the current state is already terminal.
 */
export function transitionToDisposed(currentState: TerminalLifecycleState): TerminalLifecycleState {
  if (!ACTIVE_STATES.has(currentState)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_TRANSITION,
      `Cannot dispose terminal state '${currentState}'`
    );
  }
  return applyTransition(currentState, 'disposed');
}

/**
 * Returns true when the state is terminal. Terminal states accept no further
 * transitions except an idempotent self-transition.
 */
export function isTerminalState(state: TerminalLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Returns true when the state is active (non-terminal).
 */
export function isActiveState(state: TerminalLifecycleState): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * Returns true when the state permits a new execution to begin (only
 * `proposed`). Every other state rejects new work.
 */
export function isProposableState(state: TerminalLifecycleState): boolean {
  return state === 'proposed';
}

/**
 * Returns true when the state permits transitioning to `running` (only
 * `approved`).
 */
export function isRunnableState(state: TerminalLifecycleState): boolean {
  return state === 'approved';
}

/**
 * Returns true when the state is a completion-like terminal state
 * (completed, failed, cancelled, timed-out) but not disposed/rejected.
 */
export function isOutcomeTerminalState(state: TerminalLifecycleState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed-out'
  );
}

/**
 * Determines whether a late event for an already-settled execution should be
 * ignored. Terminal outcomes are deterministic: once completed/failed/
 * cancelled/timed-out/disposed, subsequent events for the same execution do
 * not alter the state.
 */
export function isSettled(state: TerminalLifecycleState): boolean {
  return isTerminalState(state);
}
