import { describe, it, expect } from 'vitest';
import {
  createApprovalBinding,
  computeContentHash,
  approvalBindingMatchesCommand,
  assertApprovalBindingMatchesCommand,
  defaultContentHash,
  type ContentHashFunction,
  type ApprovalBindingFields,
} from '../approval-binding.js';
import { TerminalError, TerminalErrorCode } from '../errors.js';

const BASE_FIELDS: ApprovalBindingFields = {
  executable: 'node',
  arguments: ['--version'],
  workingDirectory: 'file:///workspace',
  workspaceId: 'ws_1',
  environmentConfigId: undefined,
};

const DIFFERENT_EXECUTABLE: ApprovalBindingFields = {
  ...BASE_FIELDS,
  executable: 'npm',
};

const DIFFERENT_ARGS: ApprovalBindingFields = {
  ...BASE_FIELDS,
  arguments: ['--help'],
};

const REORDERED_ARGS: ApprovalBindingFields = {
  ...BASE_FIELDS,
  arguments: ['--version', '--verbose'],
};

const DIFFERENT_CWD: ApprovalBindingFields = {
  ...BASE_FIELDS,
  workingDirectory: 'file:///other',
};

const DIFFERENT_WORKSPACE: ApprovalBindingFields = {
  ...BASE_FIELDS,
  workspaceId: 'ws_2',
};

const WITH_ENV_CONFIG: ApprovalBindingFields = {
  ...BASE_FIELDS,
  environmentConfigId: 'env-1',
};

function throwIfNotTerminalError(error: unknown): asserts error is TerminalError {
  expect(error).toBeInstanceOf(TerminalError);
}

function baseFieldsCommand(): ApprovalBindingFields {
  return {
    executable: 'node',
    arguments: ['--version'],
    workingDirectory: 'file:///workspace',
    workspaceId: 'ws_1',
    environmentConfigId: undefined,
  };
}

describe('defaultContentHash', () => {
  it('produces a lowercase hex SHA-256 string (64 chars)', () => {
    const hash = defaultContentHash(BASE_FIELDS);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
  });

  it('is deterministic for identical fields', () => {
    expect(defaultContentHash(BASE_FIELDS)).toBe(defaultContentHash(BASE_FIELDS));
  });

  it('differs when the executable changes', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(DIFFERENT_EXECUTABLE));
  });

  it('differs when arguments change', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(DIFFERENT_ARGS));
  });

  it('differs when argument order changes', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(REORDERED_ARGS));
  });

  it('differs when the working directory changes', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(DIFFERENT_CWD));
  });

  it('differs when the workspace changes', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(DIFFERENT_WORKSPACE));
  });

  it('differs when the environment config identity changes', () => {
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(WITH_ENV_CONFIG));
  });

  it('treats undefined and a configured env config as different', () => {
    const withEnv = { ...BASE_FIELDS, environmentConfigId: 'env-1' };
    expect(defaultContentHash(BASE_FIELDS)).not.toBe(defaultContentHash(withEnv));
  });
});

describe('computeContentHash', () => {
  it('delegates to the default hash function', () => {
    expect(computeContentHash(BASE_FIELDS)).toBe(defaultContentHash(BASE_FIELDS));
  });
});

describe('createApprovalBinding', () => {
  it('creates an immutable binding with a content hash', () => {
    const binding = createApprovalBinding({
      bindingId: 'bind-1',
      ...BASE_FIELDS,
      createdAt: 1700000000000,
    });

    expect(binding.kind).toBe('terminal-approval-binding');
    expect(binding.bindingId).toBe('bind-1');
    expect(binding.executable).toBe('node');
    expect(binding.arguments).toEqual(['--version']);
    expect(binding.workingDirectory).toBe('file:///workspace');
    expect(binding.workspaceId).toBe('ws_1');
    expect(binding.environmentConfigId).toBeUndefined();
    expect(binding.createdAt).toBe(1700000000000);
    expect(/^[a-f0-9]{64}$/.test(binding.contentHash)).toBe(true);
    expect(binding.contentHash).toBe(defaultContentHash(BASE_FIELDS));
  });

  it('does not mutate the input fields', () => {
    const args = ['--version'];
    const input = { bindingId: 'bind-1', ...BASE_FIELDS, arguments: args };
    createApprovalBinding(input);
    expect(input.arguments).toBe(args);
    expect(input.executable).toBe('node');
  });

  it('copies the arguments array so the binding is independent', () => {
    const binding = createApprovalBinding({ bindingId: 'bind-1', ...BASE_FIELDS });
    expect(binding.arguments).not.toBe(BASE_FIELDS.arguments);
    expect(binding.arguments).toEqual(BASE_FIELDS.arguments);
  });

  it('binds to an environment config identity without storing secret values', () => {
    const binding = createApprovalBinding({
      bindingId: 'bind-1',
      ...WITH_ENV_CONFIG,
      createdAt: 1700000000000,
    });
    expect(binding.environmentConfigId).toBe('env-1');
    const secretKeys = Object.keys(binding).filter(
      key => key.includes('secret') || key.includes('password') || key.includes('token')
    );
    expect(secretKeys).toEqual([]);
  });

  it('uses Date.now when createdAt is omitted', () => {
    const before = Date.now();
    const binding = createApprovalBinding({ bindingId: 'bind-1', ...BASE_FIELDS });
    const after = Date.now();
    expect(binding.createdAt).toBeGreaterThanOrEqual(before);
    expect(binding.createdAt).toBeLessThanOrEqual(after);
  });

  it('allows a custom content hash function for testing', () => {
    const custom: ContentHashFunction = () => 'custom-hash';
    const binding = createApprovalBinding({
      bindingId: 'bind-1',
      ...BASE_FIELDS,
      contentHashFunction: custom,
    });
    expect(binding.contentHash).toBe('custom-hash');
  });
});

describe('approvalBindingMatchesCommand', () => {
  const binding = createApprovalBinding({ bindingId: 'bind-1', ...BASE_FIELDS, createdAt: 1700000000000 });

  it('returns true for a matching command', () => {
    const command = baseFieldsCommand();
    expect(approvalBindingMatchesCommand(binding, command)).toBe(true);
  });

  it('returns false when the executable differs', () => {
    const command = { ...baseFieldsCommand(), executable: 'npm' };
    expect(approvalBindingMatchesCommand(binding, command)).toBe(false);
  });

  it('returns false when arguments differ', () => {
    const command = { ...baseFieldsCommand(), arguments: ['--help'] };
    expect(approvalBindingMatchesCommand(binding, command)).toBe(false);
  });

  it('returns false when argument order differs', () => {
    const command = { ...baseFieldsCommand(), arguments: ['--version', '--verbose'] };
    expect(approvalBindingMatchesCommand(binding, command)).toBe(false);
  });

  it('returns false when the working directory differs', () => {
    const command = { ...baseFieldsCommand(), workingDirectory: 'file:///other' };
    expect(approvalBindingMatchesCommand(binding, command)).toBe(false);
  });

  it('returns false when the workspace differs', () => {
    const command = { ...baseFieldsCommand(), workspaceId: 'ws_2' };
    expect(approvalBindingMatchesCommand(binding, command)).toBe(false);
  });

  it('returns false when the environment config identity differs', () => {
    const envBinding = createApprovalBinding({
      bindingId: 'bind-2',
      ...WITH_ENV_CONFIG,
      createdAt: 1700000000000,
    });
    const command = {
      executable: 'node',
      arguments: [],
      workingDirectory: 'file:///workspace',
      workspaceId: 'ws_1',
      environmentConfigId: 'env-2',
    };
    expect(approvalBindingMatchesCommand(envBinding, command)).toBe(false);
  });

  it('uses an injected hash function when provided', () => {
    const custom: ContentHashFunction = () => 'fixed';
    const binding2 = createApprovalBinding({
      bindingId: 'bind-3',
      ...BASE_FIELDS,
      contentHashFunction: custom,
    });
    const command = { executable: 'anything', arguments: [], workingDirectory: 'x', workspaceId: 'y' };
    expect(approvalBindingMatchesCommand(binding2, command, custom)).toBe(true);
  });
});

describe('assertApprovalBindingMatchesCommand', () => {
  const binding = createApprovalBinding({ bindingId: 'bind-1', ...BASE_FIELDS, createdAt: 1700000000000 });

  it('does not throw for a matching command', () => {
    const command = baseFieldsCommand();
    expect(() => assertApprovalBindingMatchesCommand(binding, command)).not.toThrow();
  });

  it('throws TerminalError on mismatch', () => {
    const command = { ...baseFieldsCommand(), executable: 'npm' };
    expect(() => assertApprovalBindingMatchesCommand(binding, command)).toThrow(TerminalError);
    try {
      assertApprovalBindingMatchesCommand(binding, command);
    } catch (error) {
      throwIfNotTerminalError(error);
      expect((error as TerminalError).code).toBe(TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH);
      expect((error as TerminalError).message).toContain('bind-1');
      expect((error as TerminalError).message).toContain('node');
    }
  });

  it('includes the terminal id in error options', () => {
    const command = { ...baseFieldsCommand(), executable: 'npm' };
    try {
      assertApprovalBindingMatchesCommand(binding, command);
    } catch (error) {
      throwIfNotTerminalError(error);
      expect((error as TerminalError).terminalId).toBe('bind-1');
    }
  });
});

describe('binding invalidation on any execution-relevant field change', () => {
  const baseHash = defaultContentHash(BASE_FIELDS);

  const cases: Array<[string, ApprovalBindingFields]> = [
    ['executable', DIFFERENT_EXECUTABLE],
    ['arguments', DIFFERENT_ARGS],
    ['reordered arguments', REORDERED_ARGS],
    ['working directory', DIFFERENT_CWD],
    ['workspace', DIFFERENT_WORKSPACE],
    ['environment config identity', WITH_ENV_CONFIG],
  ];

  for (const [field, changed] of cases) {
    it(`invalidates the binding when ${field} changes`, () => {
      expect(defaultContentHash(changed)).not.toBe(baseHash);
      const binding = createApprovalBinding({ bindingId: 'bind-1', ...BASE_FIELDS, createdAt: 1 });
      const changedBinding = createApprovalBinding({ bindingId: 'bind-2', ...changed, createdAt: 1 });
      expect(binding.contentHash).not.toBe(changedBinding.contentHash);
    });
  }
});
