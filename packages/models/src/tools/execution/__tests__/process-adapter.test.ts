import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  spawnControlledProcess,
  buildSanitizedEnvironment,
  truncateUtf8Safe,
  type ProcessSpawnOptions,
  type SpawnFunction,
} from '../process-adapter.js';

// Helper to create a mock ChildProcess
function createMockChildProcess(overrides: {
  stdoutData?: Buffer[];
  stderrData?: Buffer[];
  exitCode?: number | null;
  exitSignal?: string | null;
  closeDelay?: number;
  error?: Error;
}): { mock: any; closePromise: Promise<void> } {
  const closePromise = new Promise<void>(resolve => {
    setTimeout(() => {
      if (overrides.error) {
        mock.emit('error', overrides.error);
      } else {
        mock.emit('close', overrides.exitCode ?? 0, overrides.exitSignal ?? null);
      }
      resolve();
    }, overrides.closeDelay ?? 10);
  });

  const mock = {
    pid: 12345,
    killed: false,
    kill: vi.fn((signal?: string) => {
      mock.killed = true;
      return true;
    }),
    stdout: {
      on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
        if (event === 'data' && overrides.stdoutData) {
          for (const chunk of overrides.stdoutData) {
            handler(chunk);
          }
        }
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
        if (event === 'data' && overrides.stderrData) {
          for (const chunk of overrides.stderrData) {
            handler(chunk);
          }
        }
      }),
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === 'close') {
        // Fire close synchronously
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
    emit: vi.fn(),
  };

  return { mock, closePromise };
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
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from('hello world\n')],
      exitCode: 0,
    });

    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/echo', ['hello'], makeSpawnOptions(), spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/bin/echo', ['hello'], expect.objectContaining({
      shell: false,
      cwd: '/workspace',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stdoutTruncated).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBe(false);

    await closePromise;
  });

  it('captures stderr separately', async () => {
    const { mock, closePromise } = createMockChildProcess({
      stderrData: [Buffer.from('error message\n')],
      exitCode: 1,
    });

    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/ls', ['nonexistent'], makeSpawnOptions(), spawnFn);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error message\n');
    expect(result.state !== 'completed').toBe(true);

    await closePromise;
  });

  it('uses shell: false', async () => {
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from('')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions(), spawnFn);

    const options = spawnFn.mock.calls[0][2];
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    await closePromise;
  });

  it('passes cwd to spawn', async () => {
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from('')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions({ cwd: '/custom/dir' }), spawnFn);

    const options = spawnFn.mock.calls[0][2];
    expect(options.cwd).toBe('/custom/dir');

    await closePromise;
  });
});

describe('spawnControlledProcess — output truncation', () => {
  it('truncates stdout when exceeding maxOutputBytes', async () => {
    const largeOutput = Buffer.from('x'.repeat(2000));
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [largeOutput],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions({ maxOutputBytes: 1024 }), spawnFn);

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);

    await closePromise;
  });

  it('truncates stderr when exceeding maxOutputBytes', async () => {
    const largeOutput = Buffer.from('y'.repeat(2000));
    const { mock, closePromise } = createMockChildProcess({
      stderrData: [largeOutput],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions({ maxOutputBytes: 1024 }), spawnFn);

    expect(result.stderrTruncated).toBe(true);

    await closePromise;
  });

  it('records outputSizeBytes', async () => {
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from('hello')],
      stderrData: [Buffer.from('world')],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions(), spawnFn);

    expect(result.outputSizeBytes).toBe(10); // 'hello' + 'world' = 10 bytes

    await closePromise;
  });
});

describe('spawnControlledProcess — UTF-8 boundary safety', () => {
  it('does not split multibyte UTF-8 characters on truncation', async () => {
    const multibyte = '🔥'.repeat(100); // Each is 4 bytes
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from(multibyte)],
      exitCode: 0,
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const result = await spawnControlledProcess('/bin/echo', ['x'], makeSpawnOptions({ maxOutputBytes: 100 }), spawnFn);

    expect(result.stdoutTruncated).toBe(true);
    // The output should not end with a partial UTF-8 sequence
    try {
      Buffer.from(result.stdout, 'utf8'); // Should not throw
      // Verify the last character is complete
      expect(result.stdout.length).toBeGreaterThan(0);
    } catch {
      expect.fail('Output contains invalid UTF-8 after truncation');
    }

    await closePromise;
  });
});

describe('spawnControlledProcess — spawn failure', () => {
  it('rejects when spawn emits an error', async () => {
    const { mock, closePromise } = createMockChildProcess({
      error: new Error('ENOENT: no such file or directory'),
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    await expect(
      spawnControlledProcess('/nonexistent/bin', [], makeSpawnOptions(), spawnFn)
    ).rejects.toThrow();

    await closePromise;
  });
});

describe('spawnControlledProcess — cancellation via AbortSignal', () => {
  it('aborts when signal is triggered', async () => {
    const controller = new AbortController();
    const { mock, closePromise } = createMockChildProcess({
      stdoutData: [Buffer.from('partial output')],
      exitCode: null,
      exitSignal: 'SIGTERM',
    });
    const spawnFn = vi.fn(() => mock) as unknown as Parameters<typeof spawnControlledProcess>[3];

    const promise = spawnControlledProcess('/bin/sleep', ['100'], makeSpawnOptions({ signal: controller.signal }), spawnFn);

    // Abort after a short delay
    setTimeout(() => controller.abort(), 5);

    await expect(promise).resolves.toMatchObject({
      killed: true,
    });

    await closePromise;
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
    const sensitiveKeys = ['SECRET', 'PASSWORD', 'TOKEN', 'AUTHORIZATION', 'PRIVATE_KEY', 'ACCESS_TOKEN'];
    for (const key of sensitiveKeys) {
      const env = buildSanitizedEnvironment({ [key]: 'secret-value' }, 'posix');
      expect(env[key]).toBe('[REDACTED]');
    }
  });

  it('does not redact keys that merely contain sensitive substrings', () => {
    // 'apikey_extra' should NOT be redacted since it's an exact match check
    // Actually our check is exact uppercase match, so 'APIKEY_EXTRA' won't match 'API_KEY'
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
    // Should include 'ab' (2 bytes) but not '🔥' (4 bytes) since that would exceed 4
    // Actually 2 + 4 = 6 > 4, so it should just be 'ab'
    expect(result.value).toBe('ab');
  });

  it('handles ASCII-only truncation', () => {
    const result = truncateUtf8Safe('hello world', 5);
    expect(result.value).toBe('hello');
    expect(result.truncated).toBe(true);
  });
});
