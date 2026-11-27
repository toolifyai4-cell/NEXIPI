import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  transitionToDisposed,
  isTerminalState,
  isActiveState,
  isProposableState,
  isRunnableState,
  isOutcomeTerminalState,
  isSettled,
  type TerminalLifecycleState,
} from '../lifecycle.js';
import { TerminalError, TerminalErrorCode } from '../errors.js';

const VALID_STATES: TerminalLifecycleState[] = [
  'proposed',
  'validating',
  'awaiting-approval',
  'approved',
  'running',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'timed-out',
  'disposed',
];

function throwIfNotTerminalError(error: unknown): asserts error is TerminalError {
  expect(error).toBeInstanceOf(TerminalError);
}

describe('Terminal lifecycle state helpers', () => {
  it('classifies active states', () => {
    for (const state of ['proposed', 'validating', 'awaiting-approval', 'approved', 'running']) {
      expect(isActiveState(state)).toBe(true);
      expect(isTerminalState(state)).toBe(false);
    }
  });

  it('classifies terminal states', () => {
    for (const state of ['completed', 'failed', 'rejected', 'cancelled', 'timed-out', 'disposed']) {
      expect(isTerminalState(state)).toBe(true);
      expect(isActiveState(state)).toBe(false);
    }
  });

  it('identifies the proposable state', () => {
    expect(isProposableState('proposed')).toBe(true);
    expect(isProposableState('running')).toBe(false);
  });

  it('identifies the runnable state', () => {
    expect(isRunnableState('approved')).toBe(true);
    expect(isRunnableState('awaiting-approval')).toBe(false);
  });

  it('identifies outcome terminal states', () => {
    expect(isOutcomeTerminalState('completed')).toBe(true);
    expect(isOutcomeTerminalState('failed')).toBe(true);
    expect(isOutcomeTerminalState('cancelled')).toBe(true);
    expect(isOutcomeTerminalState('timed-out')).toBe(true);
    expect(isOutcomeTerminalState('rejected')).toBe(false);
    expect(isOutcomeTerminalState('disposed')).toBe(false);
  });

  it('treats terminal states as settled', () => {
    for (const state of VALID_STATES) {
      expect(isSettled(state)).toBe(isTerminalState(state));
    }
  });
});

describe('applyTransition - valid transitions', () => {
  it('transitions proposed to validating', () => {
    expect(applyTransition('proposed', 'validating')).toBe('validating');
  });

  it('transitions validating to awaiting-approval', () => {
    expect(applyTransition('validating', 'awaiting-approval')).toBe('awaiting-approval');
  });

  it('transitions validating to rejected', () => {
    expect(applyTransition('validating', 'rejected')).toBe('rejected');
  });

  it('transitions awaiting-approval to approved', () => {
    expect(applyTransition('awaiting-approval', 'approved')).toBe('approved');
  });

  it('transitions awaiting-approval to rejected', () => {
    expect(applyTransition('awaiting-approval', 'rejected')).toBe('rejected');
  });

  it('transitions approved to running', () => {
    expect(applyTransition('approved', 'running')).toBe('running');
  });

  it('transitions running to completed', () => {
    expect(applyTransition('running', 'completed')).toBe('completed');
  });

  it('transitions running to failed', () => {
    expect(applyTransition('running', 'failed')).toBe('failed');
  });

  it('transitions running to cancelled', () => {
    expect(applyTransition('running', 'cancelled')).toBe('cancelled');
  });

  it('transitions running to timed-out', () => {
    expect(applyTransition('running', 'timed-out')).toBe('timed-out');
  });
});

describe('applyTransition - disposal from any active state', () => {
  for (const state of ['proposed', 'validating', 'awaiting-approval', 'approved', 'running']) {
    it(`transitions ${state} to disposed`, () => {
      expect(applyTransition(state, 'disposed')).toBe('disposed');
    });
  }
});

describe('applyTransition - duplicate transitions are idempotent', () => {
  for (const state of VALID_STATES) {
    it(`${state} to ${state} is a no-op`, () => {
      expect(applyTransition(state, state)).toBe(state);
    });
  }
});

describe('applyTransition - invalid transitions throw', () => {
  const invalid: Array<[TerminalLifecycleState, TerminalLifecycleState]> = [
    ['rejected', 'approved'],
    ['completed', 'approved'],
    ['failed', 'approved'],
    ['cancelled', 'approved'],
    ['timed-out', 'approved'],
    ['disposed', 'approved'],
    ['rejected', 'running'],
    ['completed', 'running'],
    ['failed', 'running'],
    ['cancelled', 'running'],
    ['timed-out', 'running'],
    ['disposed', 'running'],
    ['completed', 'failed'],
    ['failed', 'completed'],
    ['cancelled', 'completed'],
    ['approved', 'completed'],
    ['proposed', 'running'],
    ['validating', 'running'],
    ['rejected', 'disposed'],
    ['completed', 'disposed'],
    ['failed', 'disposed'],
    ['rejected', 'disposed'],
    ['cancelled', 'disposed'],
    ['timed-out', 'disposed'],
    ['disposed', 'disposed-as-other'],
  ];
  for (const [from, to] of invalid) {
    it(`rejects transition from ${from} to ${to}`, () => {
      expect(() => applyTransition(from, to as TerminalLifecycleState)).toThrow(TerminalError);
      try {
        applyTransition(from, to as TerminalLifecycleState);
      } catch (error) {
        throwIfNotTerminalError(error);
        expect((error as TerminalError).code).toBe(TerminalErrorCode.TERMINAL_INVALID_TRANSITION);
      }
    });
  }
});

describe('transitionToDisposed', () => {
  it('disposes any active state', () => {
    for (const state of ['proposed', 'validating', 'awaiting-approval', 'approved', 'running']) {
      expect(transitionToDisposed(state)).toBe('disposed');
      expect(isTerminalState('disposed')).toBe(true);
    }
  });

  it('refuses to dispose an already-terminal state', () => {
    for (const state of ['completed', 'failed', 'rejected', 'cancelled', 'timed-out', 'disposed']) {
      expect(() => transitionToDisposed(state)).toThrow(TerminalError);
      try {
        transitionToDisposed(state);
      } catch (error) {
        throwIfNotTerminalError(error);
        expect((error as TerminalError).code).toBe(TerminalErrorCode.TERMINAL_INVALID_TRANSITION);
      }
    }
  });
});

describe('terminal-state immutability', () => {
  it('does not allow a completed result to be overwritten by a late failure', () => {
    expect(() => applyTransition('completed', 'failed' as TerminalLifecycleState)).toThrow(
      TerminalError
    );
  });

  it('does not allow a failed result to be overwritten by completion', () => {
    expect(() => applyTransition('failed', 'completed')).toThrow(TerminalError);
  });

  it('does not allow a rejected approval to become approved', () => {
    expect(() => applyTransition('rejected', 'approved')).toThrow(TerminalError);
  });

  it('treats repeated terminal events as deterministic', () => {
    expect(applyTransition('cancelled', 'cancelled')).toBe('cancelled');
    expect(applyTransition('timed-out', 'timed-out')).toBe('timed-out');
    expect(applyTransition('disposed', 'disposed')).toBe('disposed');
  });
});

describe('all states are covered by helpers', () => {
  for (const state of VALID_STATES) {
    it(`state ${state} is classified`, () => {
      expect(typeof isActiveState(state)).toBe('boolean');
      expect(typeof isTerminalState(state)).toBe('boolean');
    });
  }
});
