import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PersistenceFoundation,
  SqlJsProposalRepository,
  SqlJsApprovalRepository,
  type SQLDatabase,
} from '@nexipi/persistence';
import {
  createTrustedApprovalService,
  defaultNow,
  TrustedDecisionProvider,
  type TrustedUserDecision,
  type TrustedUserDecisionRequest,
  type ProposalRepositoryPort,
  type ApprovalRepositoryPort,
} from '@nexipi/workspace';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from '../../editing/persistence-repository-adapters.js';
import {
  TerminalApprovalOrchestrator,
  type TerminalApprovalOrchestratorOptions,
} from '../terminal-approval-orchestrator.js';
import type {
  TerminalCommand,
  TerminalExecutionRequest,
  TerminalExecutionResult,
  TerminalLifecycleState,
  TerminalAuthorizationCapability,
  TerminalAuthorizationBinding,
} from '@nexipi/models/tools';
import type { Logger } from '@nexipi/core';
import { DefaultExecutableResolver, DefaultExecutablePolicy } from '@nexipi/models/tools';
import { DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS } from '@nexipi/models/tools';
import { TerminalExecutionService } from '@nexipi/models/tools';

const WORKSPACE_ID = 'ws_a';
const COMMAND_ID = 'cmd_test_1';
const EXECUTABLE = '/usr/bin/ls';
const ARGUMENTS = ['-la'];
const WORKING_DIRECTORY = '/workspace';

const NOW = 1_700_000_000_000;

interface OrchestratorHarness {
  db: SQLDatabase;
  proposalRepo: SqlJsProposalRepository;
  approvalRepo: SqlJsApprovalRepository;
  service: ReturnType<typeof createTrustedApprovalService>;
  orchestrator: TerminalApprovalOrchestrator;
  gate: {
    provider: TrustedDecisionProvider;
    calls: TrustedUserDecisionRequest[];
    settle: (value: TrustedUserDecision | null) => void;
  };
  dispose: () => Promise<void>;
}

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeGate(): {
  provider: TrustedDecisionProvider;
  calls: TrustedUserDecisionRequest[];
  settle: (value: TrustedUserDecision | null) => void;
} {
  const calls: TrustedUserDecisionRequest[] = [];
  let resolveFn: ((value: TrustedUserDecision | null) => void) | undefined;
  let queued: TrustedUserDecision | null | undefined;
  const provider: TrustedDecisionProvider = {
    establishUserDecision: async request => {
      calls.push(request);
      return new Promise<TrustedUserDecision | null>(resolve => {
        resolveFn = resolve;
        if (queued !== undefined) {
          const value = queued;
          queued = undefined;
          resolve(value);
        }
      });
    },
  };
  return {
    provider,
    calls,
    settle: (value: TrustedUserDecision | null) => {
      if (resolveFn) {
        resolveFn(value);
      } else {
        queued = value;
      }
    },
  };
}

async function createOrchestratorHarness(
  overrides: Partial<TerminalApprovalOrchestratorOptions> = {}
): Promise<OrchestratorHarness> {
  const foundation = new PersistenceFoundation();
  await foundation.init();
  const db = foundation.getRawDatabase() as SQLDatabase;
  const proposalRepo = new SqlJsProposalRepository(db);
  const approvalRepo = new SqlJsApprovalRepository(db);
  const proposalPort = new ProposalRepositoryAdapter(proposalRepo);
  const approvalPort = new ApprovalRepositoryAdapter(approvalRepo);
  const gate = makeGate();
  const provider = overrides.provider ?? gate.provider;
  const now = overrides.now ?? defaultNow;
  const service = createTrustedApprovalService({
    proposals: proposalPort,
    approvals: approvalPort,
    trustedDecisionProvider: provider,
    now,
    createApprovalId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });

  const orchestrator = new TerminalApprovalOrchestrator({
    trustedApprovalService: service,
    trustedDecisionProvider: provider,
    approvals: approvalPort,
    terminalExecutionService: new TerminalExecutionService({
      executableResolver: new DefaultExecutableResolver('posix'),
      executablePolicy: new DefaultExecutablePolicy('posix'),
      limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
      logger: makeLogger(),
      trustedAuthorizationVerifier: {
        async verify(_capability: TerminalAuthorizationCapability | undefined, _binding: TerminalAuthorizationBinding): Promise<boolean> {
          return true;
        },
      },
    }),
    executableResolver: new DefaultExecutableResolver('posix'),
    limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
    workspaceBoundaryValidator: undefined,
    now,
    createApprovalId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    logger: makeLogger(),
    ...overrides,
  });

  return {
    db,
    proposalRepo,
    approvalRepo,
    service,
    orchestrator,
    gate,
    dispose: async () => {
      await orchestrator.dispose();
      foundation.close();
    },
  };
}

function makeCommand(overrides: Partial<TerminalCommand> = {}): TerminalCommand {
  return {
    kind: 'terminal-command',
    commandId: COMMAND_ID,
    executable: overrides.executable ?? EXECUTABLE,
    arguments: overrides.arguments ?? ARGUMENTS,
    workingDirectory: overrides.workingDirectory ?? WORKING_DIRECTORY,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    environmentConfig: overrides.environmentConfig
      ? { kind: 'environment-config-reference', id: overrides.environmentConfig.id ?? 'env_1' }
      : { kind: 'environment-config-reference', id: 'env_1' },
    proposedAt: overrides.proposedAt ?? NOW,
  };
}

describe('TerminalApprovalOrchestrator — execution lifecycle', () => {
  let h: OrchestratorHarness;

  beforeEach(async () => {
    h = await createOrchestratorHarness();
  });

  afterEach(async () => {
    await h.dispose();
    vi.restoreAllMocks();
  });

  it('validates command and presents for approval with approved outcome', async () => {
    vi.spyOn(h.orchestrator['provider'], 'establishUserDecision').mockResolvedValue({
      decision: 'approve' as const,
      boundary: 'test-boundary' as const,
      decidedAt: NOW,
      expiresAt: null,
    } as TrustedUserDecision);

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command);

    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('fails when orchestrator is disposed', async () => {
    await h.orchestrator.dispose();

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command);

    expect(result.state).toBe('rejected');
    expect(result.error?.code).toBe('TERMINAL_UNSUPPORTED_CONFIGURATION');
  });

  it('respects external abort signal', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command, { abortSignal: abortController.signal });

    expect(result.state).toBe('cancelled');
  });

  it('rejects invalid executable resolution', async () => {
    const orchestratorWithBadResolver = new TerminalApprovalOrchestrator({
      trustedApprovalService: h.service,
      trustedDecisionProvider: gate.provider,
      approvals: h.approvalRepo,
      terminalExecutionService: new TerminalExecutionService({
        executableResolver: {
          resolve: async (executable: string) => ({
            kind: 'rejected',
            reason: 'executable not found',
          }),
        },
        executablePolicy: new DefaultExecutablePolicy('posix'),
        limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
        logger: makeLogger(),
        trustedAuthorizationVerifier: {
          async verify(_capability: TerminalAuthorizationCapability | undefined, _binding: TerminalAuthorizationBinding): Promise<boolean> {
            return true;
          },
        },
      }),
      executableResolver: {
        resolve: async (executable: string) => ({
          kind: 'rejected',
          reason: 'executable not found',
        }),
      } as any,
      limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
      now,
      createApprovalId: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      logger: makeLogger(),
    });

    const command = makeCommand({ executable: '/nonexistent/path' });
    const result = await orchestratorWithBadResolver.executeTerminalCommand(command);

    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('TERMINAL_INVALID_IDENTITY');
  });

  it('processes rejection outcome', async () => {
    vi.spyOn(h.orchestrator['provider'], 'establishUserDecision').mockResolvedValue({
      decision: 'reject' as const,
      boundary: 'test-boundary' as const,
      decidedAt: NOW,
      expiresAt: null,
    } as TrustedUserDecision);

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command);

    expect(result.state).toBe('rejected');
  });

  it('processes cancellation outcome', async () => {
    const abortController = new AbortController();
    abortController.abort();

    vi.spyOn(h.orchestrator['provider'], 'establishUserDecision').mockResolvedValue({
      decision: 'approve' as const,
      boundary: 'test-boundary' as const,
      decidedAt: NOW,
      expiresAt: null,
    } as TrustedUserDecision);

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command, { abortSignal: abortController.signal });

    expect(result.state).toBe('cancelled');
  });

  it('processes expiration outcome', async () => {
    const orchestratorWithEarlyExpiry = new TerminalApprovalOrchestrator({
      trustedApprovalService: h.service,
      trustedDecisionProvider: gate.provider,
      approvals: h.approvalRepo,
      terminalExecutionService: new TerminalExecutionService({
        executableResolver: new DefaultExecutableResolver('posix'),
        executablePolicy: new DefaultExecutablePolicy('posix'),
        limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
        logger: makeLogger(),
        trustedAuthorizationVerifier: {
          async verify(_capability: TerminalAuthorizationCapability | undefined, _binding: TerminalAuthorizationBinding): Promise<boolean> {
            return true;
          },
        },
      }),
      executableResolver: new DefaultExecutableResolver('posix'),
      limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
      workspaceBoundaryValidator: undefined,
      now: () => NOW - 10000000,
      createApprovalId: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      logger: makeLogger(),
    });

    const command = makeCommand();
    const result = await orchestratorWithEarlyExpiry.executeTerminalCommand(command);

    expect(result.state).toBe('rejected');
    expect(result.error?.code).toBe('TERMINAL_INVALID_REQUEST');
  });

  it('handles provider returning null (cancelled)', async () => {
    vi.spyOn(h.orchestrator['provider'], 'establishUserDecision').mockResolvedValue(null);

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command);

    expect(result.state).toBe('cancelled');
  });

  it('handles provider failure fails closed', async () => {
    const failingProvider: TrustedDecisionProvider = {
      establishUserDecision: async () => {
        throw new Error('dialog crashed');
      },
    };
    const orchestratorWithFailingProvider = new TerminalApprovalOrchestrator({
      trustedApprovalService: h.service,
      trustedDecisionProvider: failingProvider,
      approvals: h.approvalRepo,
      terminalExecutionService: new TerminalExecutionService({
        executableResolver: new DefaultExecutableResolver('posix'),
        executablePolicy: new DefaultExecutablePolicy('posix'),
        limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
        logger: makeLogger(),
        trustedAuthorizationVerifier: {
          async verify(_capability: TerminalAuthorizationCapability | undefined, _binding: TerminalAuthorizationBinding): Promise<boolean> {
            return true;
          },
        },
      }),
      executableResolver: new DefaultExecutableResolver('posix'),
      limits: DEFAULT_TERMINAL_EXECUTION_SERVICE_LIMITS,
      now,
      createApprovalId: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      logger: makeLogger(),
    });

    const command = makeCommand();
    const result = await orchestratorWithFailingProvider.executeTerminalCommand(command);

    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('TERMINAL_INVALID_REQUEST');
  });

  it('returns disposal outcome on orchestrator disposal', async () => {
    await h.orchestrator.dispose();

    const command = makeCommand();
    const result = await h.orchestrator.executeTerminalCommand(command);

    expect(result.state).toBe('rejected');
    expect(result.error?.code).toBe('TERMINAL_UNSUPPORTED_CONFIGURATION');
  });
});