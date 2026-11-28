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
  sha256,
  type TrustedDecisionProvider,
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
  TerminalTrustedAuthorizationVerifier,
  type TerminalTrustedAuthorizationVerifierOptions,
} from '../terminal-trusted-authorization-verifier.js';
import type {
  TerminalAuthorizationBinding,
  TerminalAuthorizationCapability,
} from '@nexipi/models/tools';
import { computeContentHash } from '@nexipi/models/tools';

const NOW = 1_700_000_000_000;
const WORKSPACE_ID = 'ws_a';

const EXECUTABLE = '/usr/bin/ls';
const ARGUMENTS = ['-la'];
const WORKING_DIRECTORY = '/workspace';

const PROPOSED_CONTENT = 'const x = 1;';
const PROPOSED_HASH = sha256(PROPOSED_CONTENT);

interface AuthHarness {
  db: SQLDatabase;
  proposalRepo: SqlJsProposalRepository;
  approvalRepo: SqlJsApprovalRepository;
  service: ReturnType<typeof createTrustedApprovalService>;
  verifier: TerminalTrustedAuthorizationVerifier;
  gate: {
    provider: TrustedDecisionProvider;
    calls: TrustedUserDecisionRequest[];
    settle: (value: TrustedUserDecision | null) => void;
  };
  dispose: () => Promise<void>;
}

function makeLogger(): { debug: () => {}; info: () => {}; warn: () => {}; error: () => {} } {
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

async function createAuthHarness(): Promise<AuthHarness> {
  const foundation = new PersistenceFoundation();
  await foundation.init();
  const db = foundation.getRawDatabase() as SQLDatabase;
  const proposalRepo = new SqlJsProposalRepository(db);
  const approvalRepo = new SqlJsApprovalRepository(db);
  const proposalPort = new ProposalRepositoryAdapter(proposalRepo);
  const approvalPort = new ApprovalRepositoryAdapter(approvalRepo);
  const gate = makeGate();
  const provider = gate.provider;
  const now = defaultNow;
  const service = createTrustedApprovalService({
    proposals: proposalPort,
    approvals: approvalPort,
    trustedDecisionProvider: provider,
    now,
    createApprovalId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });

  const options: TerminalTrustedAuthorizationVerifierOptions = {
    trustedApprovalService: service,
    approvals: approvalPort,
    now,
    logger: makeLogger(),
  };
  const verifier = new TerminalTrustedAuthorizationVerifier(options);

  return {
    db,
    proposalRepo,
    approvalRepo,
    service,
    verifier,
    gate,
    dispose: async () => {
      foundation.close();
    },
  };
}

function makeBinding(executable = EXECUTABLE, args = ARGUMENTS, wd = WORKING_DIRECTORY, wsId = WORKSPACE_ID, envId?: string): { executable: string; arguments: string[]; workingDirectory: string; workspaceId: string; environmentConfigId?: string; contentHash: string } {
  const contentHash = computeContentHash({ executable, arguments: args, workingDirectory: wd, workspaceId: wsId, environmentConfigId: envId });

  return { executable, arguments: args, workingDirectory: wd, workspaceId: wsId, environmentConfigId: envId, contentHash };
}

async function createApprovedCapability(harness: AuthHarness, binding: ReturnType<typeof makeBinding>): Promise<TerminalAuthorizationCapability> {
  const approvalId = 'cap_test_1';
  const approval = {
    id: approvalId,
    proposalId: 'cmd_test_1',
    proposalVersion: 1,
    decision: 'approve' as const,
    approvedContentHash: binding.contentHash,
    decidedAt: NOW,
    provenance: { kind: 'trusted-boundary' as const, boundary: 'test-boundary' },
    lifecycleState: 'approved' as const,
    expiresAt: null,
    workspaceId: binding.workspaceId,
    fileUri: `terminal://command/cmd_test_1`,
    createdAt: NOW,
  };

  const result = await harness.service.approvals.createApproval(approval);
  if (result.error !== null || result.approval === null) {
    throw new Error(`Failed to create approval: ${result.error?.message ?? 'unknown'}`);
  }

  const auth = await harness.service.createAuthorizationToApply(approvalId, NOW);
  if (auth === null) {
    throw new Error('Failed to create authorization');
  }

  return {
    kind: 'terminal-authorization-capability',
    capabilityId: auth.approvalId,
    boundContentHash: auth.contentHash,
    expiresAt: undefined,
  };
}

function makeCommand(executable = EXECUTABLE, args = ARGUMENTS, wd = WORKING_DIRECTORY, wsId = WORKSPACE_ID, envConfigId?: string): { kind: 'terminal-command'; commandId: string; executable: string; arguments: string[]; workingDirectory: string; workspaceId: string; environmentConfig?: { kind: string; id?: string } | undefined; proposedAt: number } {
  return {
    kind: 'terminal-command',
    commandId: 'cmd_test_1',
    executable,
    arguments: args,
    workingDirectory: wd,
    workspaceId: wsId,
    environmentConfig: envConfigId ? { kind: 'environment-config-reference', id: envConfigId } : undefined,
    proposedAt: NOW,
  };
}

describe('TerminalTrustedAuthorizationVerifier', () => {
  let h: AuthHarness;

  beforeEach(async () => {
    h = await createAuthHarness();
  });

  afterEach(async () => {
    await h.dispose;
    vi.restoreAllMocks();
  });

  it('verifies a valid capability created through the trusted boundary', async () => {
    const binding = makeBinding();
    const capability = await createApprovedCapability(h, binding);

    const result = await h.verifier.verify(capability, binding);

    expect(result).toBe(true);
    expect(h.verifier.usedCapabilityIdsSnapshot).toContain(capability.capabilityId);
  });

  it('rejects undefined capability', async () => {
    const binding = makeBinding();

    const result = await h.verifier.verify(undefined, binding);

    expect(result).toBe(false);
    expect(h.verifier.usedCapabilityIdsSnapshot).toHaveLength(0);
  });

  it('rejects plain object that is not a boundary-created capability', async () => {
    const binding = makeBinding();
    const plainObject = {
      kind: 'trusted-approval-decision',
      decision: 'approved',
    } as unknown as TerminalAuthorizationCapability;

    const result = await h.verifier.verify(plainObject, binding);

    expect(result).toBe(false);
    expect(h.verifier.usedCapabilityIdsSnapshot).toHaveLength(0);
  });

  it('rejects capability with mismatched content hash', async () => {
    const binding1 = makeBinding();
    const capability = await createApprovedCapability(h, binding1);

    const binding2 = makeBinding('/usr/bin/cat', ['-la']);

    const result = await h.verifier.verify(capability, binding2);

    expect(result).toBe(false);
    expect(h.verifier.usedCapabilityIdsSnapshot).toHaveLength(0);
  });

  it('rejects reuse of single-use capability', async () => {
    const binding = makeBinding();
    const capability = await createApprovedCapability(h, binding);

    // First use succeeds
    const result1 = await h.verifier.verify(capability, binding);
    expect(result1).toBe(true);

    // Second use fails (single-use enforcement)
    const result2 = await h.verifier.verify(capability, binding);
    expect(result2).toBe(false);
  });

  it('rejects expired capability', async () => {
    const binding = makeBinding();
    const capability = await createApprovedCapability(h, binding);

    const expiredCapability = {
      ...capability,
      expiresAt: NOW - 1000,
    };

    const result = await h.verifier.verify(expiredCapability, binding);

    expect(result).toBe(false);
  });

  it('rejects capability that does not exist in approval repository', async () => {
    const binding = makeBinding();
    const fakeCapability: TerminalAuthorizationCapability = {
      kind: 'terminal-authorization-capability',
      capabilityId: 'nonexistent-cap-id',
      boundContentHash: binding.contentHash,
      expiresAt: undefined,
    };

    const result = await h.verifier.verify(fakeCapability, binding);

    expect(result).toBe(false);
  });

  it('rejects capability when approval is in wrong state', async () => {
    const binding = makeBinding();
    const approvalId = 'cap_wrong_state';

    // Create approval but in rejected state
    const createResult = await harness.service.approvals.createApproval({
      id: approvalId,
      proposalId: 'cmd_test_1',
      proposalVersion: 1,
      decision: 'reject',
      approvedContentHash: binding.contentHash,
      decidedAt: NOW,
      provenance: { kind: 'trusted-boundary', boundary: 'test-boundary' },
      lifecycleState: 'rejected' as const,
      expiresAt: null,
      workspaceId: binding.workspaceId,
      fileUri: `terminal://command/cmd_test_1`,
      createdAt: NOW,
    });
    if (createResult.error !== null) {
      throw new Error(`Failed to create approval: ${createResult.error.message}`);
    }

    const capability: TerminalAuthorizationCapability = {
      kind: 'terminal-authorization-capability',
      capabilityId: approvalId,
      boundContentHash: binding.contentHash,
      expiresAt: undefined,
    };

    const verifyResult = await h.verifier.verify(capability, binding);

    expect(result).toBe(false);
  });

  it('rejects capability when approval has wrong content hash', async () => {
    const binding = makeBinding();
    const approvalId = 'cap_wrong_hash';

    const wrongHash = sha256('different content');
    const createResult = await harness.service.approvals.createApproval({
      id: approvalId,
      proposalId: 'cmd_test_1',
      proposalVersion: 1,
      decision: 'approve',
      approvedContentHash: wrongHash,
      decidedAt: NOW,
      provenance: { kind: 'trusted-boundary', boundary: 'test-boundary' },
      lifecycleState: 'approved' as const,
      expiresAt: null,
      workspaceId: binding.workspaceId,
      fileUri: `terminal://command/cmd_test_1`,
      createdAt: NOW,
    });
    if (createResult.error !== null) {
      throw new Error(`Failed to create approval: ${createResult.error.message}`);
    }

    const capability: TerminalAuthorizationCapability = {
      kind: 'terminal-authorization-capability',
      capabilityId: approvalId,
      boundContentHash: binding.contentHash,
      expiresAt: undefined,
    };

    const verifyResult = await h.verifier.verify(capability, binding);

    expect(result).toBe(false);
  });

  it('allows verification with capability that has no expiry', async () => {
    const binding = makeBinding();
    const capability = await createApprovedCapability(h, binding);

    const result = await h.verifier.verify(capability, binding);

    expect(result).toBe(true);
  });
});