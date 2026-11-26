import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TrustedApprovalService,
  createTrustedApprovalService,
  FailingTrustedDecisionProvider,
  type ProposalRepositoryPort,
  type ApprovalRepositoryPort,
  type TrustedDecisionProvider,
  type TrustedUserDecision,
  type ApprovalRecordView,
  ApprovalErrorCode,
  ApprovalDomainError,
} from '../trusted-approval-service.js';
import {
  Approval,
  ApprovalCreationRequest,
  type ApprovalProvenance,
  type ApprovalLifecycleState,
} from '../approval-contracts.js';

const NOW = 1_700_000_000_000;
const WORKSPACE_ID = 'ws_123';
const FILE_URI = 'file:///root/foo.txt';
const PROPOSAL_ID = '11111111-1111-1111-1111-111111111111';
const PROPOSAL_VERSION = 1;
const CONTENT_HASH =
  'a'.repeat(64) as `${typeof 'a'}`; // placeholder, replaced below with valid hex

function validHash(hex: string): string {
  return hex;
}

const PROPOSED_CONTENT_HASH = validHash(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
);
const OTHER_HASH = validHash(
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
);

function makeProposal(overrides: {
  proposalId?: string;
  proposalVersion?: number;
  workspaceId?: string;
  fileUri?: string;
  proposedContentHash?: string;
  status?: string;
} = {}): ProposalView {
  return {
    id: overrides.proposalId ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? PROPOSAL_VERSION,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    fileUri: overrides.fileUri ?? FILE_URI,
    proposedContentHash: overrides.proposedContentHash ?? PROPOSED_CONTENT_HASH,
    status: overrides.status ?? 'awaiting-approval',
  };
}

function makeRequest(overrides: Partial<ApprovalCreationRequest> = {}): ApprovalCreationRequest {
  return {
    proposalId: overrides.proposalId ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? PROPOSAL_VERSION,
    decision: overrides.decision ?? 'approve',
    approvedContentHash: overrides.approvedContentHash ?? PROPOSED_CONTENT_HASH,
    provenance: overrides.provenance ?? {
      kind: 'trusted-boundary',
      boundary: 'test-boundary',
    },
    decidedAt: overrides.decidedAt ?? NOW,
    expiresAt: overrides.expiresAt ?? null,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    fileUri: overrides.fileUri ?? FILE_URI,
  };
}

interface InMemoryProposalEntry {
  proposalId: string;
  proposalVersion: number;
  proposal: ProposalView;
}

class InMemoryProposalRepository implements ProposalRepositoryPort {
  private readonly store = new Map<string, Map<number, ProposalView>>();

  insert(proposal: ProposalView): void {
    let byVersion = this.store.get(proposal.id);
    if (!byVersion) {
      byVersion = new Map();
      this.store.set(proposal.id, byVersion);
    }
    byVersion.set(proposal.proposalVersion, proposal);
  }

  async getProposal(
    proposalId: string,
    proposalVersion: number
  ): Promise<{ proposal: ProposalView | null; error: Error | null }> {
    const byVersion = this.store.get(proposalId);
    if (!byVersion) {
      return { proposal: null, error: null };
    }
    return { proposal: byVersion.get(proposalVersion) ?? null, error: null };
  }
}

class InMemoryApprovalRepository implements ApprovalRepositoryPort {
  private readonly store = new Map<string, ApprovalRecordView>();

  async createApproval(input: {
    id: string;
    proposalId: string;
    proposalVersion: number;
    decision: 'approve' | 'reject' | null;
    approvedContentHash: string;
    decidedAt: number | null;
    provenance: ApprovalProvenance;
    lifecycleState: ApprovalLifecycleState;
    expiresAt: number | null;
    workspaceId: string;
    fileUri: string;
    createdAt: number;
  }): Promise<{ approval: ApprovalRecordView | null; error: Error | null }> {
    if (this.store.has(input.id)) {
      return { approval: null, error: new Error('duplicate approval id') };
    }
    const record: ApprovalRecordView = {
      id: input.id,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      decision: input.decision,
      approvedContentHash: input.approvedContentHash,
      decidedAt: input.decidedAt,
      provenance: input.provenance,
      lifecycleState: input.lifecycleState,
      expiresAt: input.expiresAt,
      workspaceId: input.workspaceId,
      fileUri: input.fileUri,
      createdAt: input.createdAt,
    };
    this.store.set(input.id, record);
    return { approval: record, error: null };
  }

  async getApproval(
    approvalId: string
  ): Promise<{ approval: ApprovalRecordView | null; error: Error | null }> {
    return { approval: this.store.get(approvalId) ?? null, error: null };
  }

  async getApprovalForVersion(
    proposalId: string,
    proposalVersion: number
  ): Promise<{ approval: ApprovalRecordView | null; error: Error | null }> {
    const matches = [...this.store.values()].filter(
      (a) => a.proposalId === proposalId && a.proposalVersion === proposalVersion
    );
    matches.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return { approval: matches[0] ?? null, error: null };
  }

  async getApprovalsByProposal(
    proposalId: string,
    proposalVersion?: number
  ): Promise<{ approvals: ApprovalRecordView[]; error: Error | null }> {
    const matches = [...this.store.values()].filter(
      (a) =>
        a.proposalId === proposalId &&
        (proposalVersion === undefined || a.proposalVersion === proposalVersion)
    );
    return { approvals: matches, error: null };
  }

  async recordRevocation(
    approvalId: string
  ): Promise<{ approval: ApprovalRecordView | null; error: Error | null }> {
    const existing = this.store.get(approvalId);
    if (!existing) {
      return { approval: null, error: new Error('approval not found') };
    }
    if (existing.lifecycleState !== 'approved') {
      return {
        approval: null,
        error: new Error(
          `Only an approved approval can be revoked; current state is '${existing.lifecycleState}'`
        ),
      };
    }
    const updated: ApprovalRecordView = { ...existing, lifecycleState: 'revoked' };
    this.store.set(approvalId, updated);
    return { approval: updated, error: null };
  }

  async recordExpiration(
    approvalId: string
  ): Promise<{ approval: ApprovalRecordView | null; error: Error | null }> {
    const existing = this.store.get(approvalId);
    if (!existing) {
      return { approval: null, error: new Error('approval not found') };
    }
    if (
      existing.lifecycleState === 'expired' ||
      existing.lifecycleState === 'rejected' ||
      existing.lifecycleState === 'revoked'
    ) {
      return { approval: existing, error: null };
    }
    const updated: ApprovalRecordView = { ...existing, lifecycleState: 'expired' };
    this.store.set(approvalId, updated);
    return { approval: updated, error: null };
  }
}

function makeProvider(decision: TrustedUserDecision | null): TrustedDecisionProvider {
  return {
    establishUserDecision: vi.fn(async () => decision),
  };
}

function buildService(overrides: {
  proposals?: ProposalRepositoryPort;
  approvals?: ApprovalRepositoryPort;
  provider?: TrustedDecisionProvider | null;
  now?: () => number;
  createApprovalId?: () => string;
} = {}): TrustedApprovalService {
  return new TrustedApprovalService({
    proposals: overrides.proposals ?? new InMemoryProposalRepository(),
    approvals: overrides.approvals ?? new InMemoryApprovalRepository(),
    trustedDecisionProvider:
      overrides.provider ?? makeProvider({ decision: 'approve', boundary: 'test-boundary', decidedAt: NOW, expiresAt: null }),
    now: overrides.now ?? (() => NOW),
    createApprovalId: overrides.createApprovalId ?? (() => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  });
}

async function expectApprovalError(
  promise: Promise<{ approvalId: string; approval: Approval }>,
  code: ApprovalErrorCode
): Promise<ApprovalDomainError> {
  let error: unknown = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ApprovalDomainError);
  expect((error as ApprovalDomainError).code).toBe(code);
  return error as ApprovalDomainError;
}

describe('TrustedApprovalService — trusted boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('valid host-controlled user approval creates a trusted approval', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({
      decision: 'approve',
      boundary: 'host-ui-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    const service = buildService({ proposals, approvals, provider });

    const result = await service.createApprovalDecision(makeRequest());

    expect(result.approval.provenance).toEqual({
      kind: 'trusted-boundary',
      boundary: 'host-ui-boundary',
    });
    expect(result.approval.decision).toBe('approve');
    expect(result.approval.lifecycleState).toBe('approved');
    expect(result.approval.provenance.kind).toBe('trusted-boundary');
    expect(result.approval.decidedAt).toBe(NOW);
    expect(result.approvalId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('valid host-controlled rejection creates a rejection record', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({
      decision: 'reject',
      boundary: 'host-ui-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    const service = buildService({ proposals, approvals, provider });

    const result = await service.createApprovalDecision(makeRequest({ decision: 'reject' }));

    expect(result.approval.decision).toBe('reject');
    expect(result.approval.lifecycleState).toBe('rejected');
    expect(result.approval.provenance.kind).toBe('trusted-boundary');
  });

  it('missing trusted-decision provider fails closed', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      approvals: new InMemoryApprovalRepository(),
      provider: null,
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest()),
      ApprovalErrorCode.TRUSTED_BOUNDARY_UNAVAILABLE
    );
  });

  it('FailingTrustedDecisionProvider fails closed', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      approvals: new InMemoryApprovalRepository(),
      provider: new FailingTrustedDecisionProvider(),
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest()),
      ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED
    );
  });

  it('model-supplied approval data cannot create trusted approval', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      approvals: new InMemoryApprovalRepository(),
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(
        makeRequest({ provenance: { kind: 'model-tool-input' } })
      ),
      ApprovalErrorCode.INVALID_PROVENANCE
    );
  });

  it('forged trusted-boundary provenance without an established decision is rejected', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      approvals: new InMemoryApprovalRepository(),
      provider: makeProvider(null), // provider establishes no decision
    });

    await expectApprovalError(
      service.createApprovalDecision(
        makeRequest({ provenance: { kind: 'trusted-boundary', boundary: 'forged' } })
      ),
      ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED
    );
  });

  it('untrusted provenance claiming a user decision is not sufficient', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      approvals: new InMemoryApprovalRepository(),
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(
        makeRequest({ provenance: { kind: 'untrusted', reason: 'user' } })
      ),
      ApprovalErrorCode.INVALID_PROVENANCE
    );
  });

  it('directly constructed approval records cannot bypass the trusted service', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider(null);
    const service = buildService({ proposals, approvals, provider });

    // Constructing an Approval object locally does not persist it or make it
    // trusted; the service has no path to inject a raw approval, and the
    // provider establishes no decision, so creation fails closed.
    const forged: Approval = {
      kind: 'edit-approval',
      approvalId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      proposalId: PROPOSAL_ID,
      proposalVersion: PROPOSAL_VERSION,
      decision: 'approve',
      approvedContentHash: PROPOSED_CONTENT_HASH,
      decidedAt: NOW,
      provenance: { kind: 'trusted-boundary', boundary: 'forged' },
      lifecycleState: 'approved',
      expiresAt: null,
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
      createdAt: NOW,
    };
    expect(forged.provenance.kind).toBe('trusted-boundary');

    await expectApprovalError(
      service.createApprovalDecision(makeRequest()),
      ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED
    );

    // Nothing was persisted despite the forged in-memory Approval object.
    const stored = await approvals.getApproval('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(stored.approval).toBeNull();
  });
});

describe('TrustedApprovalService — proposal and hash binding', () => {
  it('missing proposal is denied', async () => {
    const proposals = new InMemoryProposalRepository(); // empty
    const service = buildService({ proposals });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest()),
      ApprovalErrorCode.NOT_AUTHORIZED
    );
  });

  it('wrong proposal version is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ proposalVersion: 1 }));
    const service = buildService({
      proposals,
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest({ proposalVersion: 2 })),
      ApprovalErrorCode.NOT_AUTHORIZED
    );
  });

  it('wrong content hash is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const service = buildService({
      proposals,
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest({ approvedContentHash: OTHER_HASH })),
      ApprovalErrorCode.CONTENT_HASH_MISMATCH
    );
  });

  it('modified proposal content invalidates the previous approval', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ proposedContentHash: PROPOSED_CONTENT_HASH }));
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    await service.createApprovalDecision(makeRequest());

    // Modify the persisted proposal hash; the previous approval no longer matches.
    proposals.insert(makeProposal({ proposedContentHash: OTHER_HASH }));

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(result.authorized).toBe(false);
    expect(result.contentHashMatches).toBe(false);
    expect(result.reason).toContain('content hash');
  });

  it('approval for one proposal cannot authorize another', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ proposalId: PROPOSAL_ID }));
    proposals.insert(makeProposal({ proposalId: '22222222-2222-2222-2222-222222222222' }));
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    await service.createApprovalDecision(makeRequest({ proposalId: PROPOSAL_ID }));

    const result = await service.verifyApplicationAuthorization(
      '22222222-2222-2222-2222-222222222222',
      PROPOSAL_VERSION
    );
    expect(result.authorized).toBe(false);
    expect(result.versionMatches).toBe(false);
  });

  it('workspace identity mismatch is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ workspaceId: 'other-workspace' }));
    const service = buildService({
      proposals,
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest({ workspaceId: WORKSPACE_ID })),
      ApprovalErrorCode.NOT_AUTHORIZED
    );
  });

  it('file identity mismatch is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ fileUri: 'file:///root/other.txt' }));
    const service = buildService({
      proposals,
      provider: makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null }),
    });

    await expectApprovalError(
      service.createApprovalDecision(makeRequest({ fileUri: FILE_URI })),
      ApprovalErrorCode.NOT_AUTHORIZED
    );
  });
});

describe('TrustedApprovalService — lifecycle and authorization', () => {
  it('pending approval is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const service = buildService({ proposals, approvals });

    // Insert a pending approval directly via the repo port to simulate a
    // pending record; verification must deny it.
    await approvals.createApproval({
      id: 'pending-id',
      proposalId: PROPOSAL_ID,
      proposalVersion: PROPOSAL_VERSION,
      decision: null,
      approvedContentHash: PROPOSED_CONTENT_HASH,
      decidedAt: null,
      provenance: { kind: 'trusted-boundary', boundary: 'b' },
      lifecycleState: 'pending',
      expiresAt: null,
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
      createdAt: NOW,
    });

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(result.authorized).toBe(false);
    expect(result.statePermitsApplication).toBe(false);
  });

  it('approved and valid authorization is accepted', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    await service.createApprovalDecision(makeRequest());

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(result.authorized).toBe(true);
    expect(result.statePermitsApplication).toBe(true);
    expect(result.provenanceTrusted).toBe(true);
    expect(result.notExpired).toBe(true);
    expect(result.contentHashMatches).toBe(true);
    expect(result.versionMatches).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('createAuthorizationToApply returns an authorization for a valid approval', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    const { approvalId } = await service.createApprovalDecision(makeRequest());

    const authorization = await service.createAuthorizationToApply(approvalId);
    expect(authorization).not.toBeNull();
    expect(authorization?.proposalId).toBe(PROPOSAL_ID);
    expect(authorization?.proposalVersion).toBe(PROPOSAL_VERSION);
    expect(authorization?.contentHash).toBe(PROPOSED_CONTENT_HASH);
    expect(authorization?.authorizedAt).toBe(NOW);
  });

  it('rejected approval is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'reject', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    await service.createApprovalDecision(makeRequest({ decision: 'reject' }));

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(result.authorized).toBe(false);
    expect(result.statePermitsApplication).toBe(false);
  });

  it('expired approval is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: NOW - 1000 });
    const service = buildService({ proposals, approvals, provider, now: () => NOW + 5000 });

    await service.createApprovalDecision(makeRequest({ expiresAt: NOW - 1000 }));

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION, NOW + 5000);
    expect(result.authorized).toBe(false);
    expect(result.notExpired).toBe(false);
  });

  it('revoked approval is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    const { approvalId } = await service.createApprovalDecision(makeRequest());
    await service.revokeApproval(approvalId);

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(result.authorized).toBe(false);
    expect(result.statePermitsApplication).toBe(false);
  });

  it('stale approval (wrong version) is denied', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal({ proposalVersion: 1 }));
    proposals.insert(makeProposal({ proposalVersion: 2, proposedContentHash: OTHER_HASH }));
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'approve', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    await service.createApprovalDecision(
      makeRequest({ proposalVersion: 1, approvedContentHash: PROPOSED_CONTENT_HASH })
    );

    const result = await service.verifyApplicationAuthorization(PROPOSAL_ID, 2);
    expect(result.authorized).toBe(false);
    expect(result.versionMatches).toBe(false);
  });

  it('invalid lifecycle transition is rejected on revocation of non-approved', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider({ decision: 'reject', boundary: 'b', decidedAt: NOW, expiresAt: null });
    const service = buildService({ proposals, approvals, provider });

    const { approvalId } = await service.createApprovalDecision(
      makeRequest({ decision: 'reject' })
    );

    await expect(service.revokeApproval(approvalId)).rejects.toThrow();
  });

  it('approval retrieval alone does not grant permission', async () => {
    const proposals = new InMemoryProposalRepository();
    proposals.insert(makeProposal());
    const approvals = new InMemoryApprovalRepository();
    const provider = makeProvider(null); // no trusted decision established
    const service = buildService({ proposals, approvals, provider });

    // Retrieval returns no approval because none was created through the trusted service.
    const retrieved = await service.getApprovalForVersion(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(retrieved.approval).toBeNull();

    // Retrieval of an existing record returns the record; it is not itself an
    // authorization decision (authorization is a separate verify call).
    await approvals.createApproval({
      id: 'retrieved-id',
      proposalId: PROPOSAL_ID,
      proposalVersion: PROPOSAL_VERSION,
      decision: 'approve',
      approvedContentHash: PROPOSED_CONTENT_HASH,
      decidedAt: NOW,
      provenance: { kind: 'trusted-boundary', boundary: 'b' },
      lifecycleState: 'approved',
      expiresAt: null,
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
      createdAt: NOW,
    });
    const fetched = await service.getApproval('retrieved-id');
    expect(fetched.approval?.lifecycleState).toBe('approved');

    // The separate authorization check still applies every binding rule.
    const authorized = await service.verifyApplicationAuthorization(PROPOSAL_ID, PROPOSAL_VERSION);
    expect(authorized.authorized).toBe(true);
    expect(authorized.provenanceTrusted).toBe(true);
  });
});
