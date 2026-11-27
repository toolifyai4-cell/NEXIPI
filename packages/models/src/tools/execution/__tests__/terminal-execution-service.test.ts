import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TerminalExecutionService,
  createTerminalExecutionServiceLimits,
  DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
  type TerminalExecutionServiceOptions,
  type TerminalExecutionServiceLimits,
  type TerminalExecutionSubmission,
} from '../terminal-execution-service.js';
import {
  createTerminalId,
  type TerminalCommand,
  type TerminalExecutionRequest,
} from '../contracts.js';
import { DefaultExecutableResolver, DefaultExecutablePolicy } from '../executable-policy.js';
import { resolveExecutable } from '../executable-resolution.js';

// --- Test doubles ---

function makeCommand(overrides: Partial<TerminalCommand> = {}): TerminalCommand {
  return {
    kind: 'terminal-command',
    commandId: 'cmd-1',
    executable: '/usr/bin/ls',
    arguments: ['-la'],
    workingDirectory: '/workspace',
    workspaceId: 'ws_1',
    proposedAt: 1700000000000,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<TerminalExecutionRequest> = {}): TerminalExecutionRequest {
  return {
    kind: 'terminal-execution-request',
    requestId: 'req-1',
    command: makeCommand(),
    ...overrides,
  };
}

function makeMockResolver(platform: 'posix' | 'win32' = 'posix') {
  return {
    resolve: vi.fn((executable: string, cwd: string) => ({
      kind: 'resolved' as const,
      executable: {
        resolvedPath: executable.startsWith('/') || executable.includes('\\') || executable.startsWith('C:')
          ? executable
          : `/workspace/${executable}`,
        displayName: executable,
        platform,
      },
    })),
  };
}

function makeMockPolicy(permitted: boolean = true) {
  return {
    name: 'mock-policy',
    platform: 'posix' as const,
    isExecutablePermitted: vi.fn(() => permitted),
    listPermittedExecutables: vi.fn(() => []),
  };
}

function makeMockSpawnFn(resultOverrides: any = {}) {
  return vi.fn(async () => ({
    exitCode: 0,
    exitSignal: null,
    stdout: 'output\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    outputSizeBytes: 8,
    startedAt: Date.now(),
    completedAt: Date.now() + 100,
    executionMs: 100,
    killed: false,
    timedOut: false,
    ...resultOverrides,
  }));
}

function makeOptions(overrides: Partial<TerminalExecutionServiceOptions> = {}): TerminalExecutionServiceOptions {
  return {
    executableResolver: makeMockResolver(),
    executablePolicy: makeMockPolicy(),
    ...overrides,
  };
}

describe('TerminalExecutionService — submission', () => {
  it('submits and executes a valid command', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));

    const submission = service.submit(makeRequest());
    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('output\n');
    expect(spawnFn).toHaveBeenCalled();

    service.dispose();
  });

  it('rejects when service is disposed', async () => {
    const service = new TerminalExecutionService(makeOptions());
    service.dispose();

    expect(() => service.submit(makeRequest())).toThrow();
  });

  it('assigns a terminal ID matching the request ID', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));

    const submission = service.submit(makeRequest({ requestId: 'custom-req-id' }));
    expect(submission.terminalId).toBe('custom-req-id');

    await submission.promise;
    service.dispose();
  });
});

describe('TerminalExecutionService — concurrency limits', () => {
  it('limits concurrent executions', async () => {
    // Create a spawn fn that holds the process open
    let releaseSpawn: (() => void) | null = null;
    const spawnFn = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      return {
        exitCode: 0,
        exitSignal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        outputSizeBytes: 0,
        startedAt: Date.now(),
        completedAt: Date.now(),
        executionMs: 0,
        killed: false,
        timedOut: false,
      };
    });

    const service = new TerminalExecutionService(makeOptions({
      spawnFn,
      limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxConcurrentExecutions: 1 },
    }));

    // Start first execution (will block)
    const sub1 = service.submit(makeRequest({ requestId: 'req-1' }));
    expect(service.activeExecutions).toBe(1);

    // Second execution should be queued
    const sub2 = service.submit(makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) }));
    expect(service.queuedExecutions).toBe(1);
    expect(service.activeExecutions).toBe(1);

    // Release the first
    releaseSpawn!();
    await sub1;

    // Second should now run
    const result2 = await sub2;
    expect(result2.state).toBe('completed');

    service.dispose();
  });

  it('rejects when queue is full', async () => {
    let releaseSpawn: (() => void) | null = null;
    const spawnFn = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      return {
        exitCode: 0, exitSignal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, outputSizeBytes: 0,
        startedAt: Date.now(), completedAt: Date.now(), executionMs: 0,
        killed: false, timedOut: false,
      };
    });

    const service = new TerminalExecutionService(makeOptions({
      spawnFn,
      limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxConcurrentExecutions: 1, maxQueuedExecutions: 1 },
    }));

    // Fill the concurrent slot
    service.submit(makeRequest({ requestId: 'req-1' }));
    // Fill the queue
    service.submit(makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) }));
    // Third should fail
    expect(() => service.submit(makeRequest({ requestId: 'req-3', command: makeCommand({ commandId: 'cmd-3' }) }))).toThrow();

    releaseSpawn!();
    await service.dispose();
  });
});

describe('TerminalExecutionService — cancellation', () => {
  it('cancels an in-flight execution', async () => {
    let releaseSpawn: (() => void) | null = null;
    const spawnFn = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      return {
        exitCode: 0, exitSignal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, outputSizeBytes: 0,
        startedAt: Date.now(), completedAt: Date.now(), executionMs: 0,
        killed: false, timedOut: false,
      };
    });

    const service = new TerminalExecutionService(makeOptions({ spawnFn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    // Wait for execution to start
    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = service.cancel(submission.terminalId, 'user');
    expect(cancelled).toBe(true);

    releaseSpawn!();

    const result = await submission.promise;
    expect(result.state).toBe('cancelled');
    expect(result.cancelled).toBe(true);

    service.dispose();
  });

  it('returns false for unknown terminal ID', () => {
    const service = new TerminalExecutionService(makeOptions());
    expect(service.cancel('nonexistent-id', 'user')).toBe(false);
    service.dispose();
  });

  it('returns false for already-terminal execution', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));
    const submission = service.submit(makeRequest());
    await submission.promise;

    expect(service.cancel(submission.terminalId, 'user')).toBe(false);
    service.dispose();
  });
});

describe('TerminalExecutionService — disposal', () => {
  it('cancels active executions on dispose', async () => {
    let releaseSpawn: (() => void) | null = null;
    const spawnFn = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      return {
        exitCode: 0, exitSignal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, outputSizeBytes: 0,
        startedAt: Date.now(), completedAt: Date.now(), executionMs: 0,
        killed: false, timedOut: false,
      };
    });

    const service = new TerminalExecutionService(makeOptions({ spawnFn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.dispose();
    releaseSpawn!();

    // The submission should be cancelled (not completed)
    await expect(submission.promise).resolves.toMatchObject({
      state: 'cancelled',
      cancelled: true,
    });
  });

  it('rejects queued executions on dispose', async () => {
    let releaseSpawn: (() => void) | null = null;
    const spawnFn = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseSpawn = resolve;
      });
      return {
        exitCode: 0, exitSignal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, outputSizeBytes: 0,
        startedAt: Date.now(), completedAt: Date.now(), executionMs: 0,
        killed: false, timedOut: false,
      };
    });

    const service = new TerminalExecutionService(makeOptions({
      spawnFn,
      limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxConcurrentExecutions: 1 },
    }));

    // Fill concurrent slot
    service.submit(makeRequest({ requestId: 'req-1' }));
    // Queue second
    const sub2 = service.submit(makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) }));

    service.dispose();
    releaseSpawn!();

    await expect(sub2.promise).rejects.toThrow();
  });

  it('rejects new submissions after dispose', () => {
    const service = new TerminalExecutionService(makeOptions());
    service.dispose();
    expect(() => service.submit(makeRequest())).toThrow();
    expect(service.isDisposed).toBe(true);
  });
});

describe('TerminalExecutionService — validation failures', () => {
  it('rejects invalid commands', async () => {
    const service = new TerminalExecutionService(makeOptions());

    expect(() => service.submit(makeRequest({
      command: makeCommand({ executable: '' }),
    }))).toThrow();

    service.dispose();
  });

  it('rejects approval binding mismatch', async () => {
    const { createApprovalBinding } = await import('../approval-binding.js');
    const service = new TerminalExecutionService(makeOptions());

    // Create a binding for a different command
    const binding = createApprovalBinding({
      bindingId: 'bind-1',
      executable: '/usr/bin/cat',
      arguments: ['-la'],
      workingDirectory: '/workspace',
      workspaceId: 'ws_1',
      createdAt: 1700000000000,
    });

    // Submit a request with a different command (ls vs cat)
    expect(() => service.submit(makeRequest({
      command: makeCommand({ executable: '/usr/bin/ls' }),
      approvalBinding: binding,
    }))).toThrow();

    service.dispose();
  });
});

describe('TerminalExecutionService — executable policy', () => {
  it('denies executables not permitted by policy', async () => {
    const policy = makeMockPolicy(false);
    const service = new TerminalExecutionService(makeOptions({ executablePolicy: policy }));

    expect(() => service.submit(makeRequest())).toThrow();

    service.dispose();
  });

  it('resolves executable before spawn', async () => {
    const resolver = makeMockResolver();
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ executableResolver: resolver, spawnFn }));

    await service.submit(makeRequest({ command: makeCommand({ executable: '/usr/bin/ls' }) })).promise;

    expect(resolver.resolve).toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith('/usr/bin/ls', ['-la'], expect.anything());

    service.dispose();
  });
});

describe('createTerminalExecutionServiceLimits', () => {
  it('creates valid limits from defaults', () => {
    const limits = createTerminalExecutionServiceLimits();
    expect(limits.maxConcurrentExecutions).toBe(5);
    expect(limits.maxQueuedExecutions).toBe(100);
    expect(limits.maxExecutionMs).toBe(30_000);
  });

  it('rejects non-positive limits', () => {
    expect(() => createTerminalExecutionServiceLimits({ maxExecutionMs: 0 })).toThrow();
    expect(() => createTerminalExecutionServiceLimits({ maxConcurrentExecutions: -1 })).toThrow();
  });

  it('merges partial input with defaults', () => {
    const limits = createTerminalExecutionServiceLimits({ maxConcurrentExecutions: 10 });
    expect(limits.maxConcurrentExecutions).toBe(10);
    expect(limits.maxExecutionMs).toBe(30_000); // from default
  });
});

describe('DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS', () => {
  it('has all required fields', () => {
    expect(DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS.maxConcurrentExecutions).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS.maxQueuedExecutions).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS.maxExecutionMs).toBeGreaterThan(0);
    expect(DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS.maxOutputSizeBytes).toBeGreaterThan(0);
  });
});
