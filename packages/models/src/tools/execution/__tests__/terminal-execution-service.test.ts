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
  type TerminalAuthorizationCapability,
  type TerminalAuthorizationBinding,
  type TrustedAuthorizationVerifier,
} from '../contracts.js';
import { DefaultExecutableResolver, DefaultExecutablePolicy } from '../executable-policy.js';
import { resolveExecutable } from '../executable-resolution.js';
import { createApprovalBinding, computeContentHash } from '../approval-binding.js';

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

// --- Trusted authorization verifier test double (models the Stage E boundary) ---
//
// Capabilities are created exclusively through createCapability, mirroring how
// TrustedApprovalService.createAuthorizationToApply() is the sole producer. The
// verifier rejects anything not produced there: plain objects, forged ids,
// mismatched bindings, expired capabilities, and consumed single-use
// capabilities. This tests the real trust-boundary seam, not just object fields.

interface AuthorizationFixture {
  verifier: TrustedAuthorizationVerifier;
  createCapability: (
    binding: TerminalAuthorizationBinding,
    opts?: { expiresAt?: number; singleUse?: boolean; capabilityId?: string }
  ) => TerminalAuthorizationCapability;
  verifyCalls: Array<{
    capability: TerminalAuthorizationCapability | undefined;
    binding: TerminalAuthorizationBinding;
  }>;
}

function makeAuthorizationFixture(now: () => number = Date.now): AuthorizationFixture {
  const store = new Map<
    string,
    { binding: TerminalAuthorizationBinding; singleUse: boolean; used: boolean }
  >();
  const verifyCalls: Array<{
    capability: TerminalAuthorizationCapability | undefined;
    binding: TerminalAuthorizationBinding;
  }> = [];

  const verifier: TrustedAuthorizationVerifier = {
    async verify(capability, binding) {
      verifyCalls.push({ capability, binding });
      if (!capability || capability.kind !== 'terminal-authorization-capability') {
        return false; // plain object or missing: not a boundary-created capability
      }
      const record = store.get(capability.capabilityId);
      if (!record) {
        return false; // forged / unknown capability id
      }
      if (capability.boundContentHash !== binding.contentHash) {
        return false; // bound to a different execution
      }
      if (capability.expiresAt !== undefined && now() > capability.expiresAt) {
        return false; // expired
      }
      if (record.singleUse && record.used) {
        return false; // single-use already consumed
      }
      if (record.singleUse) {
        record.used = true;
      }
      return true;
    },
  };

  function createCapability(
    binding: TerminalAuthorizationBinding,
    opts: { expiresAt?: number; singleUse?: boolean; capabilityId?: string } = {}
  ): TerminalAuthorizationCapability {
    const capability: TerminalAuthorizationCapability = {
      kind: 'terminal-authorization-capability',
      capabilityId: opts.capabilityId ?? `cap-${store.size + 1}`,
      boundContentHash: binding.contentHash,
      expiresAt: opts.expiresAt ?? undefined,
    };
    store.set(capability.capabilityId, { binding, singleUse: opts.singleUse ?? true, used: false });
    return capability;
  }

  return { verifier, createCapability, verifyCalls };
}

// Shared default fixture used by makeOptions/makeRequest defaults. Tests that
// require isolated authorization state (expiry, reuse, mismatch) build their
// own fixture and pass it explicitly.

function authorizationBindingFromCommand(command: TerminalCommand): TerminalAuthorizationBinding {
  return {
    executable: command.executable,
    arguments: command.arguments,
    workingDirectory: command.workingDirectory,
    workspaceId: command.workspaceId,
    environmentConfigId: command.environmentConfig?.id,
    contentHash: computeContentHash({
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: command.workingDirectory,
      workspaceId: command.workspaceId,
      environmentConfigId: command.environmentConfig?.id,
    }),
  };
}

// Fresh authorization fixture reset before every test so single-use
// capabilities and verification-call history do not leak between tests.
let defaultAuthorizationFixture = makeAuthorizationFixture();
beforeEach(() => {
  defaultAuthorizationFixture = makeAuthorizationFixture();
});

function makeOptions(
  overrides: Partial<TerminalExecutionServiceOptions> = {}
): TerminalExecutionServiceOptions {
  const options: TerminalExecutionServiceOptions = {
    executableResolver: makeMockResolver(),
    executablePolicy: makeMockPolicy(),
    ...overrides,
  };
  if (options.trustedAuthorizationVerifier === undefined) {
    options.trustedAuthorizationVerifier = defaultAuthorizationFixture.verifier;
  }
  return options;
}

function makeRequest(
  overrides: Partial<TerminalExecutionRequest> & { fixture?: AuthorizationFixture } = {}
): TerminalExecutionRequest {
  const { fixture = defaultAuthorizationFixture, ...rest } = overrides;
  const command: TerminalCommand = rest.command ?? makeCommand();
  const resolvedApprovalBinding =
    'approvalBinding' in rest
      ? rest.approvalBinding
      : createApprovalBinding({
          bindingId: 'bind-1',
          executable: command.executable,
          arguments: command.arguments,
          workingDirectory: command.workingDirectory,
          workspaceId: command.workspaceId,
          environmentConfigId: command.environmentConfig?.id,
          createdAt: 1700000000000,
        });
  const resolvedTrustedAuthorization =
    'trustedAuthorization' in rest
      ? rest.trustedAuthorization
      : fixture.createCapability(authorizationBindingFromCommand(command));

  return {
    kind: 'terminal-execution-request',
    requestId: rest.requestId ?? 'req-1',
    command,
    approvalBinding: resolvedApprovalBinding,
    trustedAuthorization: resolvedTrustedAuthorization,
  };
}

// Fresh authorization fixture before every test so single-use capabilities and
// verification-call history do not leak between tests.
beforeEach(() => {
  defaultAuthorizationFixture = makeAuthorizationFixture();
});

function makeMockResolver(platform: 'posix' | 'win32' = 'posix') {
  return {
    resolve: vi.fn((executable: string, cwd: string) => ({
      kind: 'resolved' as const,
      executable: {
        resolvedPath:
          executable.startsWith('/') || executable.includes('\\') || executable.startsWith('C:')
            ? executable
            : `/workspace/${executable}`,
        displayName: executable,
        platform,
      },
    })),
  };
}

// Helper to create a mock ChildProcess (synchronous close for test reliability)
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
    on(event: string, handler: any): void {
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
    },
    emit() {},
  };

  return { mock };
}

function makeMockPolicy(permitted: boolean = true) {
  return {
    name: 'mock-policy',
    platform: 'posix' as const,
    isExecutablePermitted: vi.fn(() => permitted),
    listPermittedExecutables: vi.fn(() => []),
  };
}

function makeMockSpawnFn(resultOverrides: any = {}): any {
  return vi.fn((_executable: string, _args: readonly string[], _options: any) => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('output\n')],
      ...resultOverrides,
    });
    return mock;
  });
}

// Creates a spawn function that returns a ChildProcess mock whose 'close'
// event is delayed until release() is called. This simulates a long-running
// process for cancellation/timeout tests.
function makeBlockingSpawnFn(resultOverrides: any = {}): { fn: any; release: () => void } {
  let releaseSpawn: (() => void) | null = null;
  const fn = (_executable: string, _args: readonly string[], _options: any) => {
    const { mock } = createMockChildProcess({
      stdoutData: [Buffer.from('output\n')],
      ...resultOverrides,
    });
    // Override the close handler to wait for release
    const originalOn = mock.on;
    mock.on = (event: string, handler: any) => {
      if (event === 'close') {
        releaseSpawn = () => handler(0, null);
      } else {
        originalOn(event, handler);
      }
    };
    return mock;
  };
  const release = () => {
    if (releaseSpawn) {
      releaseSpawn();
      releaseSpawn = null;
    }
  };
  return { fn, release };
}

describe('TerminalExecutionService — submission', () => {
  it('submits and executes a valid command', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));

    const submission = service.submit(makeRequest());
    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe('string');

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
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: makeMockSpawnFn(),
        limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxConcurrentExecutions: 1 },
      })
    );

    // Start first execution
    const sub1 = service.submit(makeRequest({ requestId: 'req-1' }));
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second execution
    const sub2 = service.submit(
      makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) })
    );
    await new Promise(resolve => setTimeout(resolve, 10));

    // Both should complete
    const result1 = await sub1.promise;
    expect(result1.state).toBe('completed');

    const result2 = await sub2.promise;
    expect(result2.state).toBe('completed');

    service.dispose();
  });

  it('rejects when queue is full', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: fn,
        limits: {
          ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
          maxConcurrentExecutions: 1,
          maxQueuedExecutions: 1,
        },
      })
    );

    // Fill the concurrent slot
    service.submit(makeRequest({ requestId: 'req-1' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    // Fill the queue
    service.submit(
      makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) })
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    // Third should fail
    await expect(
      service.submit(
        makeRequest({ requestId: 'req-3', command: makeCommand({ commandId: 'cmd-3' }) })
      ).promise
    ).rejects.toThrow();

    release();
    await service.dispose();
  });
});

describe('TerminalExecutionService — cancellation', () => {
  it('cancels an in-flight execution', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    // Wait for execution to start
    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = service.cancel(submission.terminalId, 'user');
    expect(cancelled).toBe(true);

    release();

    await expect(submission.promise).rejects.toThrow();

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
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.dispose();
    release();

    // The submission should be cancelled (rejected)
    await expect(submission.promise).rejects.toThrow();
  });

  it('rejects queued executions on dispose', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: fn,
        limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxConcurrentExecutions: 1 },
      })
    );

    // Fill concurrent slot
    service.submit(makeRequest({ requestId: 'req-1' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    // Queue second
    const sub2 = service.submit(
      makeRequest({ requestId: 'req-2', command: makeCommand({ commandId: 'cmd-2' }) })
    );
    await new Promise(resolve => setTimeout(resolve, 10));

    service.dispose();
    release();

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

    await expect(
      service.submit(
        makeRequest({
          command: makeCommand({ executable: '' }),
        })
      ).promise
    ).rejects.toThrow();

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
    await expect(
      service.submit(
        makeRequest({
          command: makeCommand({ executable: '/usr/bin/ls' }),
          approvalBinding: binding,
        })
      ).promise
    ).rejects.toThrow();

    service.dispose();
  });
});

describe('TerminalExecutionService — executable policy', () => {
  it('denies executables not permitted by policy', async () => {
    const policy = makeMockPolicy(false);
    const service = new TerminalExecutionService(makeOptions({ executablePolicy: policy }));

    await expect(service.submit(makeRequest()).promise).rejects.toThrow();

    service.dispose();
  });

  it('resolves executable before spawn', async () => {
    const resolver = makeMockResolver();
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({ executableResolver: resolver, spawnFn })
    );

    await service.submit(makeRequest({ command: makeCommand({ executable: '/usr/bin/ls' }) }))
      .promise;

    expect(resolver.resolve).toHaveBeenCalled();

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

describe('TerminalExecutionService — execution authorization boundary', () => {
  it('rejects submission without an approval binding', async () => {
    const service = new TerminalExecutionService(makeOptions());

    await expect(
      service.submit({
        kind: 'terminal-execution-request',
        requestId: 'req-no-binding',
        command: makeCommand(),
      } as TerminalExecutionRequest).promise
    ).rejects.toThrow();

    service.dispose();
  });

  it('rejects submission with explicit undefined approval binding', async () => {
    const service = new TerminalExecutionService(makeOptions());

    await expect(
      service.submit(makeRequest({ approvalBinding: undefined })).promise
    ).rejects.toThrow();

    service.dispose();
  });

  it('accepts submission with a valid approval binding and a boundary-verified capability', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));

    const submission = service.submit(makeRequest());
    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(spawnFn).toHaveBeenCalledTimes(1);

    service.dispose();
  });
});

describe('TerminalExecutionService — cancellation/timeout accuracy', () => {
  it('rejects with cancellation error when cancelled during execution', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = service.cancel(submission.terminalId, 'user');
    expect(cancelled).toBe(true);

    release();

    await expect(submission.promise).rejects.toThrow();

    service.dispose();
  });

  it('rejects with cancellation error when cancelled during timeout', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: fn,
        limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxExecutionMs: 50 },
      })
    );
    const submission = service.submit(makeRequest({ requestId: 'req-timeout' }));

    await new Promise(resolve => setTimeout(resolve, 100));

    await expect(submission.promise).rejects.toThrow();

    release();
    service.dispose();
  });
});

describe('TerminalExecutionService — late event handling', () => {
  it('does not overwrite cancelled state with late completion', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.cancel(submission.terminalId, 'user');

    release();

    await expect(submission.promise).rejects.toThrow();

    // Verify the entry state is still cancelled, not overwritten by late completion
    const entry = service.getExecution(submission.terminalId);
    expect(entry?.state).toBe('cancelled');
    expect(entry?.result?.state).toBe('cancelled');

    service.dispose();
  });

  it('does not overwrite cancelled state with late failure', async () => {
    const { fn, release } = makeBlockingSpawnFn({
      exitCode: 1,
      stderrData: [Buffer.from('error')],
    });
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.cancel(submission.terminalId, 'user');

    release();

    await expect(submission.promise).rejects.toThrow();

    // Verify the entry state is still cancelled, not overwritten by late failure
    const entry = service.getExecution(submission.terminalId);
    expect(entry?.state).toBe('cancelled');
    expect(entry?.result?.state).toBe('cancelled');

    service.dispose();
  });
});

describe('TerminalExecutionService — trusted authorization boundary', () => {
  it('rejects submission when no trusted authorization verifier is configured', async () => {
    const service = new TerminalExecutionService({
      ...makeOptions(),
      trustedAuthorizationVerifier: undefined,
    });

    await expect(service.submit(makeRequest()).promise).rejects.toThrow(
      /trusted authorization verifier/
    );

    service.dispose();
  });

  it('rejects submission without a trusted authorization capability', async () => {
    const service = new TerminalExecutionService(makeOptions());

    await expect(
      service.submit(makeRequest({ trustedAuthorization: undefined })).promise
    ).rejects.toThrow();

    service.dispose();
  });

  it('rejects a plain approved decision object — the boundary is unforgeable', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));

    await expect(
      service.submit(
        makeRequest({
          trustedAuthorization: {
            kind: 'trusted-approval-decision',
            decision: 'approved',
          } as unknown as TerminalAuthorizationCapability,
        })
      ).promise
    ).rejects.toThrow();

    // No process may be created for a forged/plain decision object.
    expect(spawnFn).not.toHaveBeenCalled();

    service.dispose();
  });

  it('rejects a model/caller-created capability not produced by the trusted boundary', async () => {
    const fixture = makeAuthorizationFixture();
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier })
    );
    const spawnFn = makeMockSpawnFn();
    // The service was built without spawnFn; use a fresh service with spawn.
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );

    const capability: TerminalAuthorizationCapability = {
      kind: 'terminal-authorization-capability',
      capabilityId: 'cap-forged-by-caller',
      boundContentHash: computeContentHash({
        executable: '/usr/bin/ls',
        arguments: ['-la'],
        workingDirectory: '/workspace',
        workspaceId: 'ws_1',
        environmentConfigId: undefined,
      }),
      expiresAt: undefined,
    };

    await expect(
      serviceWithSpawn.submit(
        makeRequest({ trustedAuthorization: capability, requestId: 'req-forged' })
      ).promise
    ).rejects.toThrow();

    expect(spawnFn).not.toHaveBeenCalled();
    expect(fixture.verifyCalls.length).toBe(1);
    expect(fixture.verifyCalls[0]!.capability).toBe(capability);

    service.dispose();
    serviceWithSpawn.dispose();
  });

  it('rejects an expired authorization capability', async () => {
    let now = 1700000000000;
    const fixture = makeAuthorizationFixture(() => now);
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier })
    );
    const spawnFn = makeMockSpawnFn();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );

    const capability = fixture.createCapability(
      authorizationBindingFromCommand(makeCommand()),
      { expiresAt: 1700000000000 }
    );
    now = 1700000000001; // move past expiry

    await expect(
      serviceWithSpawn.submit(
        makeRequest({ trustedAuthorization: capability, requestId: 'req-expired' })
      ).promise
    ).rejects.toThrow();

    expect(spawnFn).not.toHaveBeenCalled();
    service.dispose();
    serviceWithSpawn.dispose();
  });

  it('rejects reuse of a single-use authorization capability', async () => {
    const fixture = makeAuthorizationFixture();
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );

    const command = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(command));

    // First submission is authorized and executes.
    const first = service.submit(
      makeRequest({ command, trustedAuthorization: capability, requestId: 'req-reuse-1' })
    );
    expect(await first.promise).toMatchObject({ state: 'completed' });
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Reusing the same capability for a new request must fail closed.
    await expect(
      service.submit(
        makeRequest({ command, trustedAuthorization: capability, requestId: 'req-reuse-2' })
      ).promise
    ).rejects.toThrow();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('invalidates authorization when the executable changes', async () => {
    const fixture = makeAuthorizationFixture();
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier })
    );
    const spawnFn = makeMockSpawnFn();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );

    const baseCommand = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({ executable: '/usr/bin/cat' }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-exe',
        })
      ).promise
    ).rejects.toThrow();

    expect(spawnFn).not.toHaveBeenCalled();
    service.dispose();
    serviceWithSpawn.dispose();
  });

  it('invalidates authorization when the arguments change', async () => {
    const fixture = makeAuthorizationFixture();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn: makeMockSpawnFn() })
    );

    const baseCommand = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({ arguments: ['--help'] }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-args',
        })
      ).promise
    ).rejects.toThrow();

    expect(serviceWithSpawn.activeExecutions).toBe(0);
    serviceWithSpawn.dispose();
  });

  it('invalidates authorization when argument order changes', async () => {
    const fixture = makeAuthorizationFixture();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn: makeMockSpawnFn() })
    );

    const baseCommand = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({ arguments: ['--la', '-l'] }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-order',
        })
      ).promise
    ).rejects.toThrow();

    serviceWithSpawn.dispose();
  });

  it('invalidates authorization when the working directory changes', async () => {
    const fixture = makeAuthorizationFixture();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn: makeMockSpawnFn() })
    );

    const baseCommand = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({ workingDirectory: '/other' }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-cwd',
        })
      ).promise
    ).rejects.toThrow();

    serviceWithSpawn.dispose();
  });

  it('invalidates authorization when the workspace changes', async () => {
    const fixture = makeAuthorizationFixture();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn: makeMockSpawnFn() })
    );

    const baseCommand = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({ workspaceId: 'ws_2' }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-workspace',
        })
      ).promise
    ).rejects.toThrow();

    serviceWithSpawn.dispose();
  });

  it('invalidates authorization when the environment config identity changes', async () => {
    const fixture = makeAuthorizationFixture();
    const serviceWithSpawn = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn: makeMockSpawnFn() })
    );

    const baseCommand = makeCommand({
      environmentConfig: { kind: 'environment-config-reference', id: 'env-1' },
    });
    const capability = fixture.createCapability(authorizationBindingFromCommand(baseCommand));

    await expect(
      serviceWithSpawn.submit(
        makeRequest({
          command: makeCommand({
            environmentConfig: { kind: 'environment-config-reference', id: 'env-2' },
          }),
          trustedAuthorization: capability,
          requestId: 'req-mismatch-env',
        })
      ).promise
    ).rejects.toThrow();

    serviceWithSpawn.dispose();
  });

  it('executes only when authorization is verified through the trusted boundary', async () => {
    const fixture = makeAuthorizationFixture();
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );

    const command = makeCommand();
    const capability = fixture.createCapability(authorizationBindingFromCommand(command));

    const submission = service.submit(
      makeRequest({ command, trustedAuthorization: capability, requestId: 'req-boundary' })
    );
    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(result.trustedAuthorization).toBe(capability);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(fixture.verifyCalls.length).toBe(1);

    service.dispose();
  });

  it('passes the verified authorization capability through to the result', async () => {
    const fixture = makeAuthorizationFixture();
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({ trustedAuthorizationVerifier: fixture.verifier, spawnFn })
    );
    const capability = fixture.createCapability(authorizationBindingFromCommand(makeCommand()));

    const submission = service.submit(
      makeRequest({ trustedAuthorization: capability, requestId: 'req-passthrough' })
    );
    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(result.trustedAuthorization).toBe(capability);

    service.dispose();
  });
});

describe('TerminalExecutionService — cancel/timeout/disposal distinction', () => {
  it('manual cancellation has timedOut: false', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-cancel' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = service.cancel(submission.terminalId, 'user');
    expect(cancelled).toBe(true);

    release();

    await expect(submission.promise).rejects.toThrow();

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.result?.cancelled).toBe(true);
    expect(entry?.result?.timedOut).toBe(false);

    service.dispose();
  });

  it('timeout has timedOut: true', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: fn,
        limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxExecutionMs: 30 },
      })
    );
    const submission = service.submit(makeRequest({ requestId: 'req-timeout' }));

    await new Promise(resolve => setTimeout(resolve, 100));

    await expect(submission.promise).rejects.toThrow();

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.result?.cancelled).toBe(true);
    expect(entry?.result?.timedOut).toBe(true);

    release();
    service.dispose();
  });

  it('disposal has timedOut: false', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-dispose' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const entry = service.getExecution(submission.terminalId);

    service.dispose();
    release();

    await expect(submission.promise).rejects.toThrow();

    expect(entry?.result?.cancelled).toBe(true);
    expect(entry?.result?.timedOut).toBe(false);

    service.dispose();
  });

  it('late completion does not overwrite cancelled state', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-late-complete' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.cancel(submission.terminalId, 'user');

    release();

    await expect(submission.promise).rejects.toThrow();

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.state).toBe('cancelled');
    expect(entry?.result?.state).toBe('cancelled');
    expect(entry?.result?.cancelled).toBe(true);
    expect(entry?.result?.timedOut).toBe(false);

    service.dispose();
  });

  it('late timeout event does not overwrite previously settled cancellation', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-race' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    // User cancels first
    service.cancel(submission.terminalId, 'user');

    // Then release - process completes but state should remain cancelled
    release();

    await expect(submission.promise).rejects.toThrow();

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.state).toBe('cancelled');
    expect(entry?.result?.timedOut).toBe(false);

    service.dispose();
  });
});

describe('TerminalExecutionService — termination lifecycle', () => {
  it('cancellation reports terminationStatus unconfirmed (exit not yet observed)', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-term-1' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const cancelled = service.cancel(submission.terminalId, 'user');
    expect(cancelled).toBe(true);

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.result?.terminationStatus).toBe('unconfirmed');
    expect(entry?.result?.cancelled).toBe(true);

    release();
    await expect(submission.promise).rejects.toThrow();

    service.dispose();
  });

  it('timeout reports terminationStatus unconfirmed (exit not yet observed)', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(
      makeOptions({
        spawnFn: fn,
        limits: { ...DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS, maxExecutionMs: 30 },
      })
    );
    const submission = service.submit(makeRequest({ requestId: 'req-term-2' }));

    await new Promise(resolve => setTimeout(resolve, 100));

    const entry = service.getExecution(submission.terminalId);
    expect(entry?.result?.terminationStatus).toBe('unconfirmed');
    expect(entry?.result?.timedOut).toBe(true);
    expect(entry?.result?.cancelled).toBe(true);

    release();
    await expect(submission.promise).rejects.toThrow();

    service.dispose();
  });

  it('natural completion reports terminationStatus confirmed', async () => {
    const spawnFn = makeMockSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn }));
    const submission = service.submit(makeRequest({ requestId: 'req-term-3' }));

    const result = await submission.promise;

    expect(result.state).toBe('completed');
    expect(result.terminationStatus).toBe('confirmed');

    service.dispose();
  });

  it('disposal reports terminationStatus unconfirmed for active execution', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-term-4' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const entry = service.getExecution(submission.terminalId);

    await service.dispose();
    release();

    await expect(submission.promise).rejects.toThrow();

    expect(entry?.result?.terminationStatus).toBe('unconfirmed');
    expect(entry?.result?.cancelled).toBe(true);
    expect(entry?.result?.timedOut).toBe(false);
  });

  it('dispose returns a promise that resolves after bounded termination wait', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    service.submit(makeRequest({ requestId: 'req-term-5' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    const disposePromise = service.dispose();
    expect(disposePromise).toBeInstanceOf(Promise);

    release();
    await disposePromise;

    expect(service.isDisposed).toBe(true);
  });

  it('late exit event does not change terminationStatus after cancellation', async () => {
    const { fn, release } = makeBlockingSpawnFn();
    const service = new TerminalExecutionService(makeOptions({ spawnFn: fn }));
    const submission = service.submit(makeRequest({ requestId: 'req-term-6' }));

    await new Promise(resolve => setTimeout(resolve, 10));

    service.cancel(submission.terminalId, 'user');

    const entryBefore = service.getExecution(submission.terminalId);
    expect(entryBefore?.result?.terminationStatus).toBe('unconfirmed');

    release();
    await expect(submission.promise).rejects.toThrow();

    const entryAfter = service.getExecution(submission.terminalId);
    expect(entryAfter?.result?.terminationStatus).toBe('unconfirmed');
    expect(entryAfter?.result?.state).toBe('cancelled');

    service.dispose();
  });
});
