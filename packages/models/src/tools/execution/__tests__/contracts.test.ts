import { describe, it, expect } from 'vitest';
import {
  createTerminalId,
  createEnvironmentConfigId,
  createEnvironmentVariableName,
  type TerminalLifecycleState,
  isTerminalLifecycleState,
  isActiveTerminalLifecycleState,
  isTerminalCommand,
  isTerminalExecutionRequest,
  isTerminalExecutionResult,
  isApprovalBinding,
  type TerminalCommand,
  type TerminalExecutionRequest,
  type TerminalExecutionResult,
  type ApprovalBinding,
  DEFAULT_TERMINAL_EXECUTION_LIMITS,
} from '../contracts.js';

const VALID_STATE: TerminalLifecycleState = 'running';

describe('Terminal identifier factories', () => {
  it('createTerminalId produces a branded string', () => {
    const id = createTerminalId('term-123');
    expect(id).toBe('term-123');
    expect(typeof id).toBe('string');
  });

  it('createEnvironmentConfigId produces a branded string', () => {
    const id = createEnvironmentConfigId('env-1');
    expect(id).toBe('env-1');
  });

  it('createEnvironmentVariableName produces a branded string', () => {
    const name = createEnvironmentVariableName('PATH');
    expect(name).toBe('PATH');
  });
});

describe('Terminal lifecycle state helpers', () => {
  it('classifies active states', () => {
    for (const state of ['proposed', 'validating', 'awaiting-approval', 'approved', 'running'] as const) {
      expect(isActiveTerminalLifecycleState(state)).toBe(true);
      expect(isTerminalLifecycleState(state)).toBe(false);
    }
  });

  it('classifies terminal states', () => {
    for (const state of ['completed', 'failed', 'rejected', 'cancelled', 'timed-out', 'disposed'] as const) {
      expect(isTerminalLifecycleState(state)).toBe(true);
      expect(isActiveTerminalLifecycleState(state)).toBe(false);
    }
  });

  it('accepts a valid state constant', () => {
    expect(VALID_STATE).toBe('running');
  });
});

describe('Terminal command type guards', () => {
  const baseCommand: TerminalCommand = {
    kind: 'terminal-command',
    commandId: 'cmd-1',
    executable: 'node',
    arguments: ['--version'],
    workingDirectory: 'file:///workspace',
    workspaceId: 'ws_1',
    proposedAt: 1700000000000,
  };

  it('isTerminalCommand recognizes a valid command', () => {
    expect(isTerminalCommand(baseCommand)).toBe(true);
  });

  it('isTerminalCommand rejects non-objects', () => {
    expect(isTerminalCommand(null)).toBe(false);
    expect(isTerminalCommand('string')).toBe(false);
    expect(isTerminalCommand(undefined)).toBe(false);
    expect(isTerminalCommand({})).toBe(false);
  });

  it('isTerminalCommand rejects wrong kind', () => {
    expect(isTerminalCommand({ kind: 'not-a-command' })).toBe(false);
  });
});

describe('Terminal execution request type guards', () => {
  const baseRequest: TerminalExecutionRequest = {
    kind: 'terminal-execution-request',
    requestId: 'req-1',
    command: {
      kind: 'terminal-command',
      commandId: 'cmd-1',
      executable: 'node',
      arguments: [],
      workingDirectory: 'file:///workspace',
      workspaceId: 'ws_1',
      proposedAt: 1700000000000,
    },
  };

  it('isTerminalExecutionRequest recognizes a valid request', () => {
    expect(isTerminalExecutionRequest(baseRequest)).toBe(true);
  });

  it('isTerminalExecutionRequest rejects non-objects', () => {
    expect(isTerminalExecutionRequest(null)).toBe(false);
    expect(isTerminalExecutionRequest({})).toBe(false);
  });
});

describe('Terminal execution result type guards', () => {
  const baseResult: TerminalExecutionResult = {
    kind: 'terminal-execution-result',
    requestId: 'req-1',
    terminalId: 'term-1',
    state: 'completed',
    exitCode: 0,
    exitSignal: null,
    stdout: 'v20.0.0\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    outputSizeBytes: 10,
    startedAt: 1700000000000,
    completedAt: 1700000001000,
    executionMs: 1000,
    cancelled: false,
    timedOut: false,
    error: null,
  };

  it('isTerminalExecutionResult recognizes a valid result', () => {
    expect(isTerminalExecutionResult(baseResult)).toBe(true);
  });

  it('isTerminalExecutionResult rejects non-objects', () => {
    expect(isTerminalExecutionResult(null)).toBe(false);
    expect(isTerminalExecutionResult({})).toBe(false);
  });
});

describe('Approval binding type guards', () => {
  const baseBinding: ApprovalBinding = {
    kind: 'terminal-approval-binding',
    bindingId: 'bind-1',
    executable: 'node',
    arguments: ['--version'],
    workingDirectory: 'file:///workspace',
    workspaceId: 'ws_1',
    environmentConfigId: undefined,
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    createdAt: 1700000000000,
  };

  it('isApprovalBinding recognizes a valid binding', () => {
    expect(isApprovalBinding(baseBinding)).toBe(true);
  });

  it('isApprovalBinding rejects non-objects', () => {
    expect(isApprovalBinding(null)).toBe(false);
    expect(isApprovalBinding({})).toBe(false);
  });
});

describe('Default terminal execution limits', () => {
  it('defines positive integer limits', () => {
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxExecutableLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxArgumentLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxArgumentsCount).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxWorkingDirectoryLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxCommandLineLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxOutputSizeBytes).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxExecutionMs).toBeGreaterThan(0);
  });

  it('uses conservative defaults', () => {
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxOutputSizeBytes).toBe(1024 * 1024);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxExecutionMs).toBe(30_000);
  });
});

