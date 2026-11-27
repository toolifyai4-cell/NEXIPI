import { describe, it, expect } from 'vitest';
import {
  validateTerminalCommandSecurity,
  isValidatedTerminalCommand,
  type ValidatedTerminalCommand,
} from '../command-validation.js';
import {
  DEFAULT_TERMINAL_EXECUTION_LIMITS,
  type TerminalCommand,
  type TerminalExecutionLimits,
} from '../contracts.js';

function makeCommand(overrides: Partial<TerminalCommand> = {}): TerminalCommand {
  return {
    kind: 'terminal-command',
    commandId: 'cmd-1',
    executable: 'ls',
    arguments: ['-la'],
    workingDirectory: '/workspace',
    workspaceId: 'ws_1',
    proposedAt: 1700000000000,
    ...overrides,
  };
}

describe('validateTerminalCommandSecurity — valid command', () => {
  it('accepts a well-formed command', async () => {
    const result = await validateTerminalCommandSecurity(makeCommand());
    expect(result.kind).toBe('validated-terminal-command');
    expect(result.command.executable).toBe('ls');
  });

  it('accepts a command with no arguments', async () => {
    const result = await validateTerminalCommandSecurity(
      makeCommand({ arguments: [] })
    );
    expect(result.kind).toBe('validated-terminal-command');
  });

  it('accepts a command with an environment config reference', async () => {
    const result = await validateTerminalCommandSecurity(
      makeCommand({
        environmentConfig: { kind: 'environment-config-reference', id: 'env-1', name: 'prod' },
      })
    );
    expect(result.kind).toBe('validated-terminal-command');
  });

  it('does not mutate the input command', async () => {
    const command = makeCommand();
    const original = { ...command, arguments: [...command.arguments] };
    await validateTerminalCommandSecurity(command);
    expect(command).toEqual(original);
  });
});

describe('validateTerminalCommandSecurity — executable validation', () => {
  it('rejects an empty executable', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ executable: '' }))
    ).rejects.toThrow();
  });

  it('rejects an executable over the length limit', async () => {
    const over = 'x'.repeat(257);
    await expect(
      validateTerminalCommandSecurity(makeCommand({ executable: over }))
    ).rejects.toThrow();
  });

  it('rejects an executable with a null byte', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ executable: 'ls\0' }))
    ).rejects.toThrow();
  });

  it('rejects an executable with shell metacharacters', async () => {
    for (const exec of ['ls;rm', 'ls&rm', 'ls|rm', 'ls`id`', 'ls$(id)', 'ls<file', 'ls>file']) {
      await expect(
        validateTerminalCommandSecurity(makeCommand({ executable: exec }))
      ).rejects.toThrow();
    }
  });

  it('rejects an executable with path traversal', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ executable: '../bin/ls' }))
    ).rejects.toThrow();
  });

  it('rejects a whitespace-only executable', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ executable: '   ' }))
    ).rejects.toThrow();
  });
});

describe('validateTerminalCommandSecurity — argument validation', () => {
  it('rejects too many arguments', async () => {
    const tooMany = makeCommand({ arguments: Array(129).fill('arg') });
    await expect(validateTerminalCommandSecurity(tooMany)).rejects.toThrow();
  });

  it('rejects an argument over the length limit', async () => {
    const longArg = makeCommand({ arguments: ['x'.repeat(4097)] });
    await expect(validateTerminalCommandSecurity(longArg)).rejects.toThrow();
  });

  it('rejects an argument with a null byte', async () => {
    const nullArg = makeCommand({ arguments: ['arg\0'] });
    await expect(validateTerminalCommandSecurity(nullArg)).rejects.toThrow();
  });

  it('rejects an argument with shell metacharacters', async () => {
    for (const arg of ['arg;rm', 'arg&rm', 'arg|rm', 'arg`id`', 'arg$(id)', 'arg<file', 'arg>file']) {
      await expect(
        validateTerminalCommandSecurity(makeCommand({ arguments: [arg] }))
      ).rejects.toThrow();
    }
  });

  it('rejects non-string arguments', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ arguments: [42 as unknown as string] }))
    ).rejects.toThrow();
  });
});

describe('validateTerminalCommandSecurity — working directory validation', () => {
  it('rejects an empty working directory', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: '' }))
    ).rejects.toThrow();
  });

  it('rejects a relative working directory', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: 'relative/path' }))
    ).rejects.toThrow();
  });

  it('rejects a working directory over the length limit', async () => {
    const over = '/x'.repeat(3000);
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: over }))
    ).rejects.toThrow();
  });

  it('rejects a working directory with a null byte', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: '/workspace\0' }))
    ).rejects.toThrow();
  });

  it('rejects a working directory with shell metacharacters', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: '/workspace;rm' }))
    ).rejects.toThrow();
  });

  it('rejects a working directory with path traversal', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workingDirectory: '/workspace/../etc' }))
    ).rejects.toThrow();
  });

  it('accepts an absolute Windows path', async () => {
    const result = await validateTerminalCommandSecurity(
      makeCommand({ workingDirectory: 'C:\\workspace' })
    );
    expect(result.kind).toBe('validated-terminal-command');
  });

  it('accepts an absolute UNC path', async () => {
    const result = await validateTerminalCommandSecurity(
      makeCommand({ workingDirectory: '\\\\server\\share' })
    );
    expect(result.kind).toBe('validated-terminal-command');
  });
});

describe('validateTerminalCommandSecurity — workspace identity validation', () => {
  it('rejects a missing workspace id', async () => {
    await expect(
      validateTerminalCommandSecurity(makeCommand({ workspaceId: '' }))
    ).rejects.toThrow();
  });
});

describe('validateTerminalCommandSecurity — environment config validation', () => {
  it('rejects an environment config with an empty id', async () => {
    await expect(
      validateTerminalCommandSecurity(
        makeCommand({ environmentConfig: { kind: 'environment-config-reference', id: '' } })
      )
    ).rejects.toThrow();
  });

  it('rejects an environment config with a non-string name', async () => {
    await expect(
      validateTerminalCommandSecurity(
        makeCommand({
          environmentConfig: {
            kind: 'environment-config-reference',
            id: 'env-1',
            name: 42 as unknown as string,
          },
        })
      )
    ).rejects.toThrow();
  });
});

describe('validateTerminalCommandSecurity — command line length', () => {
  it('rejects an over-long command line', async () => {
    const over = makeCommand({
      executable: 'x'.repeat(200),
      arguments: Array(50).fill('y'.repeat(200)),
    });
    await expect(validateTerminalCommandSecurity(over)).rejects.toThrow();
  });

  it('accepts a command within the command line length limit', async () => {
    const within = makeCommand({
      executable: 'ls',
      arguments: ['-la', '--color=auto'],
    });
    const result = await validateTerminalCommandSecurity(within);
    expect(result.kind).toBe('validated-terminal-command');
  });
});

describe('validateTerminalCommandSecurity — workspace boundary validator', () => {
  it('calls the boundary validator when provided', async () => {
    let validated = false;
    const validator: Parameters<typeof validateTerminalCommandSecurity>[2] = {
      validate: async () => {
        validated = true;
      },
    };
    await validateTerminalCommandSecurity(makeCommand(), DEFAULT_TERMINAL_EXECUTION_LIMITS, validator);
    expect(validated).toBe(true);
  });

  it('rejects when the boundary validator throws', async () => {
    const validator: Parameters<typeof validateTerminalCommandSecurity>[2] = {
      validate: async () => {
        throw new Error('outside workspace');
      },
    };
    await expect(
      validateTerminalCommandSecurity(makeCommand(), DEFAULT_TERMINAL_EXECUTION_LIMITS, validator)
    ).rejects.toThrow();
  });

  it('passes through TerminalError from the boundary validator unchanged', async () => {
    const { TerminalError, TerminalErrorCode } = await import('../errors.js');
    const validator: Parameters<typeof validateTerminalCommandSecurity>[2] = {
      validate: async () => {
        throw new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'boundary denied');
      },
    };
    await expect(
      validateTerminalCommandSecurity(makeCommand(), DEFAULT_TERMINAL_EXECUTION_LIMITS, validator)
    ).rejects.toThrow(/boundary denied/);
  });
});

describe('ValidatedTerminalCommand type guard', () => {
  it('recognizes a valid result', () => {
    const result: ValidatedTerminalCommand = {
      kind: 'validated-terminal-command',
      command: makeCommand(),
    };
    expect(isValidatedTerminalCommand(result)).toBe(true);
  });

  it('rejects non-matching objects', () => {
    expect(isValidatedTerminalCommand({ kind: 'other' })).toBe(false);
    expect(isValidatedTerminalCommand(null)).toBe(false);
    expect(isValidatedTerminalCommand('string')).toBe(false);
  });
});

describe('TerminalExecutionLimits', () => {
  it('default limits are all positive', () => {
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxExecutableLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxArgumentLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxArgumentsCount).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxWorkingDirectoryLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxCommandLineLength).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxOutputSizeBytes).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_LIMITS.maxExecutionMs).toBeGreaterThan(0);
  });
});
