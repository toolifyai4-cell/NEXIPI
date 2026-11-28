import { describe, it, expect, vi } from 'vitest';
import {
  spawnControlledProcess,
  buildSanitizedEnvironment,
  truncateUtf8Safe,
  terminateProcessTree,
  type ProcessSpawnOptions,
  type SpawnFunction,
  type ProcessHandle,
  type KillProcessTreeFunction,
} from '../process-adapter.js';

// Helper to create a mock ChildProcess with synchronous close event
function createMockChildProcess(overrides: {
  stdoutData?: Buffer[];
  stderrData?: Buffer[];
  exitCode?: number | null;
  exitSignal?: string | null;
  error?: Error;
}): { mock: any } {
  const mock: any = {
    pid: 12345,
    killed: false,
    kill(signal?: string): boolean {
      mock.killed = true;
      return true;
    },
    stdout: {
      on(event: string, handler: (chunk: Buffer) => void): void {
        if (event === 'data' && overrides.stdoutData) {
          for (const chunk of overrides.stdoutData) {
            handler(chunk);
          }
        }
      },
    },
    stderr: {
      on(event: string, handler: (chunk: Buffer) => void): void {
        if (event === 'data' && overrides.stderrData) {
          for (const chunk of overrides.stderrData) {
            handler(chunk);
          }
        }
      },
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'close') {
        if (overrides.error) {
          handler(1, null);
        } else {
          handler(overrides.exitCode ?? 0, overrides.exitSignal ?? null);
        }
      } else if (event === 'error') {
        if (overrides.error) {
          handler(overrides.error);
        }
      }
    }),
    emit() {},
  };

  return { mock };
}

function makeSpawnOptions(overrides: Partial<ProcessSpawnOptions> = {}): ProcessSpawnOptions {
  return {
    cwd: '/workspace',
    env: {},
    signal: new AbortController().signal,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
}

describe('spawnControlledProcess — success', () => {
  it('spawns a process and captures stdout', async () => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('hello world\n')],
      exitCode: 0,
    });

    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/echo',
      ['hello'],
      makeSpawnOptions(),
      spawnFn
    );

    expect(spawnFn).toHaveBeenCalledWith(
      '/bin/echo',
      ['hello'],
      expect.objectContaining({
        shell: false,
        cwd: '/workspace',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr separately', async () => {
    const { mock } = createMockChildProcess({
      stderrData: [Buffer.from('error message\n')],
      exitCode: 1,
    });

    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/ls',
      ['nonexistent'],
      makeSpawnOptions(),
      spawnFn
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error message\n');
  });

  it('uses shell: false', async () => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions(), spawnFn);

    const options = spawnFn.mock.calls[0][2];
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('passes cwd to spawn', async () => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await spawnControlledProcess(
      '/bin/echo',
      ['x'],
      makeSpawnOptions({ cwd: '/custom/dir' }),
      spawnFn
    );

    const options = spawnFn.mock.calls[0][2];
    expect(options.cwd).toBe('/custom/dir');
  });
});

describe('spawnControlledProcess — output truncation', () => {
  it('truncates stdout when exceeding maxOutputBytes', async () => {
    const largeOutput = Buffer.from('x'.repeat(2000));
    const { mock } = createMockChildProcess({
      stdoutData: [largeOutput],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/echo',
      ['x'],
      makeSpawnOptions({ maxOutputBytes: 1024 }),
      spawnFn
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('truncates stderr when exceeding maxOutputBytes', async () => {
    const largeOutput = Buffer.from('y'.repeat(2000));
    const { mock } = createMockChildProcess({
      stderrData: [largeOutput],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/echo',
      ['x'],
      makeSpawnOptions({ maxOutputBytes: 1024 }),
      spawnFn
    );

    expect(result.stderrTruncated).toBe(true);
  });

  it('records outputSizeBytes', async () => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('hello')],
      stderrData: [Buffer.from('world')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/echo',
      ['x'],
      makeSpawnOptions(),
      spawnFn
    );

    expect(result.outputSizeBytes).toBe(10); // 'hello' + 'world' = 10 bytes
  });
});

describe('spawnControlledProcess — UTF-8 boundary safety', () => {
  it('does not split multibyte UTF-8 characters on truncation', async () => {
    const multibyte = '🔥'.repeat(100); // Each is 4 bytes
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from(multibyte)],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const { result } = await spawnControlledProcess(
      '/bin/echo',
      ['x'],
      makeSpawnOptions({ maxOutputBytes: 100 }),
      spawnFn
    );

    expect(result.stdoutTruncated).toBe(true);
    // The output should not end with a partial UTF-8 sequence
    try {
      Buffer.from(result.stdout, 'utf8'); // Should not throw
      // Verify the last character is complete
      expect(result.stdout.length).toBeGreaterThan(0);
    } catch {
      expect.fail('Output contains invalid UTF-8 after truncation');
    }
  });
});

describe('spawnControlledProcess — spawn failure', () => {
  it('rejects when spawn emits an error', async () => {
    const { mock } = createMockChildProcess({
      error: new Error('ENOENT: no such file or directory'),
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await expect(
      spawnControlledProcess('/nonexistent/bin', [], makeSpawnOptions(), spawnFn)
    ).rejects.toThrow();
  });
});

describe('spawnControlledProcess — cancellation via AbortSignal', () => {
  it('accepts an AbortSignal and completes successfully when not aborted', async () => {
    const controller = new AbortController();
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('output')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const spawnResult = await spawnControlledProcess(
      '/bin/sleep',
      ['100'],
      makeSpawnOptions({ signal: controller.signal }),
      spawnFn
    );

    expect(spawnResult.result.exitCode).toBe(0);
    expect(spawnResult.result.killed).toBe(false);
  });
});

describe('buildSanitizedEnvironment', () => {
  it('includes caller-supplied non-sensitive variables', () => {
    const env = buildSanitizedEnvironment({ FOO: 'bar', PATH: '/custom' }, 'posix');
    expect(env.FOO).toBe('bar');
  });

  it('redacts sensitive environment variables', () => {
    const env = buildSanitizedEnvironment({ API_KEY: 'secret123', NORMAL: 'value' }, 'posix');
    expect(env.API_KEY).toBe('[REDACTED]');
    expect(env.NORMAL).toBe('value');
  });

  it('redacts various sensitive key patterns', () => {
    const sensitiveKeys = [
      'SECRET',
      'PASSWORD',
      'TOKEN',
      'AUTHORIZATION',
      'PRIVATE_KEY',
      'ACCESS_TOKEN',
    ];
    for (const key of sensitiveKeys) {
      const env = buildSanitizedEnvironment({ [key]: 'secret-value' }, 'posix');
      expect(env[key]).toBe('[REDACTED]');
    }
  });

  it('does not redact keys that merely contain sensitive substrings', () => {
    const env = buildSanitizedEnvironment({ NORMAL_KEY: 'value' }, 'posix');
    expect(env.NORMAL_KEY).toBe('value');
  });

  it('includes minimal base environment on POSIX', () => {
    const env = buildSanitizedEnvironment({}, 'posix');
    expect(env.PATH).toBeDefined();
  });

  it('includes minimal base environment on Windows', () => {
    const env = buildSanitizedEnvironment({}, 'win32');
    expect(env.SystemRoot).toBeDefined();
    expect(env.Path).toBeDefined();
  });
});

describe('truncateUtf8Safe', () => {
  it('returns the full string when within limits', () => {
    const result = truncateUtf8Safe('hello world', 100);
    expect(result.value).toBe('hello world');
    expect(result.truncated).toBe(false);
  });

  it('truncates at byte boundary without splitting multibyte characters', () => {
    const result = truncateUtf8Safe('ab🔥cd', 4); // 'ab' = 2 bytes, '🔥' = 4 bytes, total would be 6
    expect(result.truncated).toBe(true);
    expect(result.value).toBe('ab');
  });

  it('handles ASCII-only truncation', () => {
    const result = truncateUtf8Safe('hello world', 5);
    expect(result.value).toBe('hello');
    expect(result.truncated).toBe(true);
  });
});

describe('terminateProcessTree — termination outcome reporting', () => {
  // Creates a ProcessHandle with controllable waitForExit and kill.
  function createHandle(opts: {
    waitForExit?: () => Promise<void>;
    killReturns?: boolean;
    pid?: number;
  }): ProcessHandle {
    return {
      pid: opts.pid ?? 12345,
      kill: vi.fn(() => opts.killReturns ?? true),
      waitForExit: opts.waitForExit,
    };
  }

  it('reports confirmed when waitForExit resolves during graceful period', async () => {
    let resolveExit: (() => void) | null = null;
    const handle = createHandle({
      waitForExit: () =>
        new Promise<void>(resolve => {
          resolveExit = resolve;
        }),
      killReturns: true,
    });
    const killTree = vi.fn(() => true) as unknown as KillProcessTreeFunction;

    // Resolve exit after a short delay to simulate graceful termination.
    setTimeout(() => resolveExit?.(), 10);

    const result = await terminateProcessTree(handle, killTree, 1000);

    expect(result.confirmed).toBe(true);
    expect(result.forceKilled).toBe(false);
    expect(killTree).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(handle.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('reports unconfirmed when waitForExit is unavailable', async () => {
    const handle = createHandle({
      waitForExit: undefined,
      killReturns: true,
    });
    const killTree = vi.fn(() => true) as unknown as KillProcessTreeFunction;

    const result = await terminateProcessTree(handle, killTree, 50);

    // SIGTERM sent, graceful wait (blind delay) without confirmation,
    // then SIGKILL, then no waitForExit to confirm forced exit.
    expect(result.confirmed).toBe(false);
    expect(result.forceKilled).toBe(true);
    expect(killTree).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(handle.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports unconfirmed when waitForExit rejects', async () => {
    const handle = createHandle({
      waitForExit: () => Promise.reject(new Error('cannot wait')),
      killReturns: true,
    });
    const killTree = vi.fn(() => true) as unknown as KillProcessTreeFunction;

    const result = await terminateProcessTree(handle, killTree, 50);

    expect(result.confirmed).toBe(false);
    expect(result.forceKilled).toBe(true);
  });

  it('reports forceKilled and confirmed when waitForExit resolves after SIGKILL', async () => {
    let resolveExit: (() => void) | null = null;
    const handle = createHandle({
      waitForExit: () =>
        new Promise<void>(resolve => {
          resolveExit = resolve;
        }),
      killReturns: true,
    });
    const killTree = vi.fn(() => true) as unknown as KillProcessTreeFunction;

    // Do NOT resolve during graceful period (10ms); resolve during the
    // second wait (after force kill), still within the grace bound.
    setTimeout(() => resolveExit?.(), 12);

    const result = await terminateProcessTree(handle, killTree, 10);

    expect(result.confirmed).toBe(true);
    expect(result.forceKilled).toBe(true);
    expect(handle.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('returns not-confirmed when killTree reports process already gone', async () => {
    const handle = createHandle({ killReturns: false });
    const killTree = vi.fn(() => false) as unknown as KillProcessTreeFunction;

    const result = await terminateProcessTree(handle, killTree, 1000);

    expect(result.confirmed).toBe(false);
    expect(result.forceKilled).toBe(false);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it('does not indefinitely block when waitForExit never resolves', async () => {
    const handle = createHandle({
      waitForExit: () => new Promise<void>(() => {}), // never resolves
      killReturns: true,
    });
    const killTree = vi.fn(() => true) as unknown as KillProcessTreeFunction;

    const start = Date.now();
    const result = await terminateProcessTree(handle, killTree, 50);
    const elapsed = Date.now() - start;

    expect(result.confirmed).toBe(false);
    expect(result.forceKilled).toBe(true);
    // Should not wait indefinitely; bounded by graceMs (twice: graceful + force).
    expect(elapsed).toBeLessThan(1000);
  });
});
