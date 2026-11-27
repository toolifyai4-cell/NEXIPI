import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  TerminalCommandSchema,
  TerminalExecutionRequestSchema,
  TerminalExecutionResultSchema,
  ApprovalBindingSchema,
  CancellationRequestSchema,
  TerminalExecutionLimitsSchema,
  validateTerminalCommand,
  safeValidateTerminalCommand,
  validateTerminalExecutionRequest,
  safeValidateTerminalExecutionRequest,
  validateTerminalExecutionResult,
  safeValidateTerminalExecutionResult,
  validateApprovalBinding,
  safeValidateApprovalBinding,
  validateTerminalExecutionLimits,
  EnvironmentVariableNameSchema,
  EnvironmentConfigReferenceSchema,
  TerminalLifecycleStateSchema,
  isTerminalStateSchema,
  isActiveStateSchema,
  DEFAULT_TERMINAL_EXECUTION_LIMITS_VALIDATED,
} from '../schemas.js';

const BASE_COMMAND = {
  kind: 'terminal-command',
  commandId: 'cmd-1',
  executable: 'node',
  arguments: ['--version'],
  workingDirectory: 'file:///workspace',
  workspaceId: 'ws_1',
  proposedAt: 1700000000000,
};

describe('TerminalCommandSchema', () => {
  it('accepts a valid command', () => {
    expect(TerminalCommandSchema.safeParse(BASE_COMMAND).success).toBe(true);
  });

  it('requires executable', () => {
    expect(
      TerminalCommandSchema.safeParse({ ...BASE_COMMAND, executable: '' }).success
    ).toBe(false);
  });

  it('rejects executable over the length limit', () => {
    const over = 'x'.repeat(257);
    expect(TerminalCommandSchema.safeParse({ ...BASE_COMMAND, executable: over }).success).toBe(false);
  });

  it('accepts arguments within bounds', () => {
    const valid = { ...BASE_COMMAND, arguments: ['--version', '--quiet'] };
    expect(TerminalCommandSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects too many arguments', () => {
    const tooMany = { ...BASE_COMMAND, arguments: Array(129).fill('arg') };
    expect(TerminalCommandSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects an argument over the length limit', () => {
    const longArg = { ...BASE_COMMAND, arguments: ['x'.repeat(4097)] };
    expect(TerminalCommandSchema.safeParse(longArg).success).toBe(false);
  });

  it('requires workingDirectory', () => {
    expect(TerminalCommandSchema.safeParse({ ...BASE_COMMAND, workingDirectory: '' }).success).toBe(false);
  });

  it('requires workspaceId', () => {
    expect(TerminalCommandSchema.safeParse({ ...BASE_COMMAND, workspaceId: '' }).success).toBe(false);
  });

  it('rejects an over-long command line', () => {
    const longCommand = {
      ...BASE_COMMAND,
      executable: 'x'.repeat(200),
      arguments: Array(50).fill('y'.repeat(200)),
    };
    expect(TerminalCommandSchema.safeParse(longCommand).success).toBe(false);
  });

  it('accepts an optional environment config reference', () => {
    const withEnv = {
      ...BASE_COMMAND,
      environmentConfig: { kind: 'environment-config-reference', id: 'env-1', name: 'prod' },
    };
    expect(TerminalCommandSchema.safeParse(withEnv).success).toBe(true);
  });
});

describe('validateTerminalCommand / safeValidateTerminalCommand', () => {
  it('validateTerminalCommand returns the parsed command', () => {
    const result = validateTerminalCommand(BASE_COMMAND);
    expect(result.executable).toBe('node');
    expect(result.arguments).toEqual(['--version']);
  });

  it('validateTerminalCommand throws on invalid input', () => {
    expect(() => validateTerminalCommand({ ...BASE_COMMAND, executable: '' })).toThrow(z.ZodError);
  });

  it('safeValidateTerminalCommand returns success shape', () => {
    const result = safeValidateTerminalCommand(BASE_COMMAND);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.executable).toBe('node');
  });

  it('safeValidateTerminalCommand returns failure shape', () => {
    const result = safeValidateTerminalCommand({ ...BASE_COMMAND, executable: '' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
  });
});

describe('TerminalExecutionRequestSchema', () => {
  const BASE_REQUEST = {
    kind: 'terminal-execution-request',
    requestId: 'req-1',
    command: BASE_COMMAND,
  };

  it('accepts a valid request', () => {
    expect(TerminalExecutionRequestSchema.safeParse(BASE_REQUEST).success).toBe(true);
  });

  it('accepts a request with an approval binding', () => {
    const withBinding = {
      ...BASE_REQUEST,
      approvalBinding: {
        kind: 'terminal-approval-binding',
        bindingId: 'bind-1',
        executable: 'node',
        arguments: ['--version'],
        workingDirectory: 'file:///workspace',
        workspaceId: 'ws_1',
        environmentConfigId: undefined,
        contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        createdAt: 1700000000000,
      },
    };
    expect(TerminalExecutionRequestSchema.safeParse(withBinding).success).toBe(true);
  });

  it('requires requestId', () => {
    expect(TerminalExecutionRequestSchema.safeParse({ ...BASE_REQUEST, requestId: '' }).success).toBe(false);
  });
});

describe('validateTerminalExecutionRequest / safeValidateTerminalExecutionRequest', () => {
  it('validateTerminalExecutionRequest returns the parsed request', () => {
    const result = validateTerminalExecutionRequest({
      kind: 'terminal-execution-request',
      requestId: 'req-1',
      command: BASE_COMMAND,
    });
    expect(result.requestId).toBe('req-1');
  });

  it('safeValidateTerminalExecutionRequest returns failure shape on invalid input', () => {
    const result = safeValidateTerminalExecutionRequest({ kind: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('TerminalExecutionResultSchema', () => {
  const BASE_RESULT = {
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

  it('accepts a valid result', () => {
    expect(TerminalExecutionResultSchema.safeParse(BASE_RESULT).success).toBe(true);
  });

  it('rejects stdout over the output size limit', () => {
    const over = { ...BASE_RESULT, stdout: 'x'.repeat(1024 * 1024 + 1) };
    expect(TerminalExecutionResultSchema.safeParse(over).success).toBe(false);
  });

  it('rejects a non-integer exitCode', () => {
    expect(TerminalExecutionResultSchema.safeParse({ ...BASE_RESULT, exitCode: 1.5 }).success).toBe(false);
  });

  it('accepts null exitCode for running state', () => {
    const running = { ...BASE_RESULT, state: 'running', exitCode: null, exitSignal: null };
    expect(TerminalExecutionResultSchema.safeParse(running).success).toBe(true);
  });

  it('accepts an error object on failure', () => {
    const failed = {
      ...BASE_RESULT,
      state: 'failed',
      exitCode: 1,
      error: { code: 'TERMINAL_INVALID_REQUEST', message: 'bad request' },
    };
    expect(TerminalExecutionResultSchema.safeParse(failed).success).toBe(true);
  });
});

describe('ApprovalBindingSchema', () => {
  const BASE_BINDING = {
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

  it('accepts a valid binding', () => {
    expect(ApprovalBindingSchema.safeParse(BASE_BINDING).success).toBe(true);
  });

  it('accepts a binding with an environment config id', () => {
    const withEnv = { ...BASE_BINDING, environmentConfigId: 'env-1' };
    expect(ApprovalBindingSchema.safeParse(withEnv).success).toBe(true);
  });

  it('requires contentHash to be a 64-char lowercase hex string', () => {
    expect(ApprovalBindingSchema.safeParse({ ...BASE_BINDING, contentHash: 'not-a-hash' }).success).toBe(false);
    expect(ApprovalBindingSchema.safeParse({ ...BASE_BINDING, contentHash: 'g'.repeat(64) }).success).toBe(false);
    expect(ApprovalBindingSchema.safeParse({ ...BASE_BINDING, contentHash: 'A'.repeat(64) }).success).toBe(false);
  });

  it('requires createdAt to be positive', () => {
    expect(ApprovalBindingSchema.safeParse({ ...BASE_BINDING, createdAt: 0 }).success).toBe(false);
  });
});

describe('validateApprovalBinding / safeValidateApprovalBinding', () => {
  it('validateApprovalBinding returns the parsed binding', () => {
    const result = validateApprovalBinding({
      kind: 'terminal-approval-binding',
      bindingId: 'bind-1',
      executable: 'node',
      arguments: [],
      workingDirectory: 'file:///workspace',
      workspaceId: 'ws_1',
      environmentConfigId: undefined,
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      createdAt: 1700000000000,
    });
    expect(result.bindingId).toBe('bind-1');
  });

  it('safeValidateApprovalBinding returns failure shape on invalid input', () => {
    const result = safeValidateApprovalBinding({ kind: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('TerminalExecutionLimitsSchema', () => {
  it('accepts valid limits', () => {
    expect(validateTerminalExecutionLimits(DEFAULT_TERMINAL_EXECUTION_LIMITS_VALIDATED)).toBeDefined();
  });

  it('rejects non-positive limits', () => {
    expect(() =>
      validateTerminalExecutionLimits({ ...DEFAULT_TERMINAL_EXECUTION_LIMITS_VALIDATED, maxExecutionMs: 0 })
    ).toThrow();
  });
});

describe('EnvironmentVariableNameSchema', () => {
  it('accepts valid environment variable names', () => {
    for (const name of ['PATH', 'HOME', '_foo', 'FOO_BAR', 'x']) {
      expect(EnvironmentVariableNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects invalid environment variable names', () => {
    for (const name of ['', '123PATH', 'FOO-BAR', 'FOO.BAR', 'FOO BAR', 'PATH=', '$VAR']) {
      expect(EnvironmentVariableNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe('EnvironmentConfigReferenceSchema', () => {
  it('accepts a valid reference', () => {
    expect(
      EnvironmentConfigReferenceSchema.safeParse({
        kind: 'environment-config-reference',
        id: 'env-1',
        name: 'production',
      }).success
    ).toBe(true);
  });

  it('requires kind', () => {
    expect(
      EnvironmentConfigReferenceSchema.safeParse({ kind: 'other', id: 'env-1' }).success
    ).toBe(false);
  });

  it('accepts a reference without a name', () => {
    expect(
      EnvironmentConfigReferenceSchema.safeParse({ kind: 'environment-config-reference', id: 'env-1' }).success
    ).toBe(true);
  });
});

describe('TerminalLifecycleStateSchema', () => {
  it('accepts all lifecycle states', () => {
    for (const state of [
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
    ]) {
      expect(TerminalLifecycleStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects invalid states', () => {
    expect(TerminalLifecycleStateSchema.safeParse('running ').success).toBe(false);
    expect(TerminalLifecycleStateSchema.safeParse('').success).toBe(false);
  });
});

describe('isTerminalStateSchema / isActiveStateSchema', () => {
  it('classifies terminal states', () => {
    expect(isTerminalStateSchema('completed')).toBe(true);
    expect(isTerminalStateSchema('disposed')).toBe(true);
    expect(isTerminalStateSchema('running')).toBe(false);
  });

  it('classifies active states', () => {
    expect(isActiveStateSchema('proposed')).toBe(true);
    expect(isActiveStateSchema('running')).toBe(true);
    expect(isActiveStateSchema('completed')).toBe(false);
  });
});

