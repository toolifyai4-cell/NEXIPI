import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PersistenceFoundation,
  SqlJsProposalRepository,
  SqlJsApprovalRepository,
  type SQLDatabase,
  type ProposalStatus,
} from '@nexipi/persistence';
import {
  createTrustedApprovalService,
  defaultNow,
  TrustedApprovalService,
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
} from '../persistence-repository-adapters.js';
import { ApprovalController } from '../approval-controller.js';
import type { Logger } from '@nexipi/core';

const NOW = 1_700_000_000_000;
const WORKSPACE_ID = 'ws_a';
const FILE_URI = 'file:///rootA/file.ts';
const PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROPOSED_CONTENT = 'const x = 1;';
const PROPOSED_HASH = sha256(PROPOSED_CONTENT);
const ORIGINAL_CONTENT = 'const x = 0;';
const ORIGINAL_HASH = sha256(ORIGINAL_CONTENT);

interface Posted {
  type: string;
  payload: unknown;
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

interface Harness {
  db: SQLDatabase;
  proposalRepo: SqlJsProposalRepository;
  approvalRepo: SqlJsApprovalRepository;
  service: TrustedApprovalService;
  controller: ApprovalController;
  gate: ReturnType<typeof makeGate>;
  posted: Posted[];
  dispose: () => Promise<void>;
}

async function createHarness(
  overrides: { now?: () => number; provider?: TrustedDecisionProvider } = {}
): Promise<Harness> {
  const foundation = new PersistenceFoundation();
  await foundation.init();
  const db = foundation.getRawDatabase() as SQLDatabase;
  const proposalRepo = new SqlJsProposalRepository(db);
  const approvalRepo = new SqlJsApprovalRepository(db);
  const proposalPort = new ProposalRepositoryAdapter(proposalRepo);
  const approvalPort = new ApprovalRepositoryAdapter(approvalRepo);
  const gate = makeGate();
  const provider = overrides.provider ?? gate.provider;
  const now = overrides.now ?? (() => NOW);
  const service = createTrustedApprovalService({
    proposals: proposalPort,
    approvals: approvalPort,
    trustedDecisionProvider: provider,
    now,
    createApprovalId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const posted: Posted[] = [];
  const controller = new ApprovalController({
    trustedApprovalService: service,
    proposals: proposalPort,
    approvals: approvalPort,
    postMessage: message => posted.push({ type: 'message', payload: message }),
    logger: makeLogger(),
  });
  return {
    db,
    proposalRepo,
    approvalRepo,
    service,
    controller,
    gate,
    posted,
    dispose: async () => {
      controller.dispose();
      foundation.close();
    },
  };
}

async function createProposalInRepo(
  repo: SqlJsProposalRepository,
  overrides: Partial<{
    id: string;
    proposalVersion: number;
    workspaceId: string;
    fileUri: string;
    relativePath: string;
    originalContentHash: string;
    proposedContent: string;
    proposedContentHash: string;
    status: ProposalStatus;
    createdAt: number;
    expiresAt: number;
  }> = {}
): Promise<void> {
  const input = {
    id: overrides.id ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? 1,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    workspaceFolderUri: 'file:///rootA',
    fileUri: overrides.fileUri ?? FILE_URI,
    relativePath: overrides.relativePath ?? 'file.ts',
    originalContentHash: overrides.originalContentHash ?? ORIGINAL_HASH,
    originalSize: Buffer.byteLength(ORIGINAL_CONTENT, 'utf8'),
    originalMtime: overrides.createdAt ?? NOW,
    operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: PROPOSED_CONTENT }],
    proposedContent: overrides.proposedContent ?? PROPOSED_CONTENT,
    proposedContentHash: overrides.proposedContentHash ?? PROPOSED_HASH,
    proposedSize: Buffer.byteLength(PROPOSED_CONTENT, 'utf8'),
    status: (overrides.status ?? 'awaiting-approval') as ProposalStatus,
    createdAt: overrides.createdAt ?? NOW,
    expiresAt: overrides.expiresAt ?? NOW + 1_000_000,
  };
  const result = await repo.createProposal(input);
  if (result.error !== null) {
    throw new Error(`createProposal failed: ${result.error.message}`);
  }
}

function registerPending(
  controller: ApprovalController,
  overrides: Partial<{
    proposalId: string;
    proposalVersion: number;
    workspaceId: string;
    fileUri: string;
    proposedContentHash: string;
    expiresAt: number;
  }> = {}
): void {
  controller.onProposalCreated({
    proposalId: overrides.proposalId ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? 1,
    fileUri: overrides.fileUri ?? FILE_URI,
    relativePath: 'file.ts',
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    workspaceName: 'rootA',
    proposedContentHash: overrides.proposedContentHash ?? PROPOSED_HASH,
    proposedSize: Buffer.byteLength(PROPOSED_CONTENT, 'utf8'),
    createdAt: NOW,
    expiresAt: overrides.expiresAt ?? NOW + 1_000_000,
    preview: {
      kind: 'edit-preview',
      proposalId: '',
      fileUri: FILE_URI,
      relativePath: 'file.ts',
      originalContent: '',
      proposedContent: '',
      diffSummary: { linesAdded: 0, linesRemoved: 0, linesModified: 0 },
      truncated: false,
      originalTruncated: false,
      proposedTruncated: false,
    },
  });
}

function approvalDecisionMessages(
  h: Harness
): Array<{ decision: 'approve' | 'reject' | null; status: string; reason?: string }> {
  return h.posted
    .filter(
      m =>
        m.type === 'message' &&
        typeof m.payload === 'object' &&
        m.payload !== null &&
        (m.payload as { type?: string }).type === 'approvalDecision'
    )
    .map(
      m =>
        (
          m.payload as {
            payload: { decision: 'approve' | 'reject' | null; status: string; reason?: string };
          }
        ).payload
    );
}

async function getApprovalForVersion(h: Harness, proposalId: string, proposalVersion: number) {
  return h.service.getApprovalForVersion(proposalId, proposalVersion);
}

describe('ApprovalController — trusted approval flow', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.dispose();
    vi.restoreAllMocks();
  });

  it('approve action establishes a trusted decision and persists an approval record', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });

    await decisionPromise;

    const decisions = approvalDecisionMessages(h);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.decision).toBe('approve');
    expect(decisions[0]!.status).toBe('approved');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).not.toBeNull();
    expect(approval.approval!.lifecycleState).toBe('approved');
    expect(approval.approval!.decision).toBe('approve');
    expect(approval.approval!.approvedContentHash).toBe(PROPOSED_HASH);
    expect(approval.approval!.provenance.kind).toBe('trusted-boundary');
    expect(h.gate.calls.length).toBe(1);
  });

  it('reject action records a rejection and denies application', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'reject',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'reject',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });

    await decisionPromise;

    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.decision).toBe('reject');
    expect(decisions[0]!.status).toBe('rejected');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval!.lifecycleState).toBe('rejected');

    const authorized = await h.service.verifyApplicationAuthorization(PROPOSAL_ID, 1, NOW);
    expect(authorized.authorized).toBe(false);
  });

  it('dismiss records no decision and application is denied', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    await h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'dismiss',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    expect(h.gate.calls.length).toBe(0);
    const decisions = approvalDecisionMessages(h);
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.decision).toBeNull();
    expect(decisions[0]!.status).toBe('dismissed');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();

    const authorized = await h.service.verifyApplicationAuthorization(PROPOSAL_ID, 1, NOW);
    expect(authorized.authorized).toBe(false);
  });

  it('provider returning null (cancel) fails closed with no approval record', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle(null);

    await expect(decisionPromise).resolves.not.toThrow();

    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();
    expect(h.gate.calls.length).toBe(1);
  });

  it('provider failure fails closed with no approval record', async () => {
    const failingProvider: TrustedDecisionProvider = {
      establishUserDecision: async () => {
        throw new Error('dialog crashed');
      },
    };
    const h2 = await createHarness({ provider: failingProvider });
    await createProposalInRepo(h2.proposalRepo);
    registerPending(h2.controller);

    await h2.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    const decisions = approvalDecisionMessages(h2);
    expect(decisions[0]!.status).toBe('failed');

    const approval = await getApprovalForVersion(h2, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();

    await h2.dispose();
  });

  it('unavailable trusted provider fails closed', async () => {
    const h2 = await createHarness({ provider: { establishUserDecision: async () => null } });
    await createProposalInRepo(h2.proposalRepo);
    registerPending(h2.controller);

    await h2.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    const decisions = approvalDecisionMessages(h2);
    expect(decisions[0]!.status).toBe('failed');

    const approval = await getApprovalForVersion(h2, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();

    await h2.dispose();
  });

  it('disposal during an open approval prevents any late approval record', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    h.controller.dispose();

    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });

    await expect(decisionPromise).resolves.not.toThrow();

    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();
    expect(h.controller.isDisposed()).toBe(true);
  });

  it('concurrent approval attempts establish only one trusted decision', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const p1 = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    // Wait for the first call to reach the provider gate before issuing the
    // second call, so the concurrency guard is meaningfully exercised.
    let calls = 0;
    for (let i = 0; i < 100 && calls !== 1; i++) {
      await Promise.resolve();
      calls = h.gate.calls.length;
    }
    expect(h.gate.calls.length).toBe(1);

    const p2 = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    await p2;

    expect(h.gate.calls.length).toBe(1);
    const decisions = approvalDecisionMessages(h);
    expect(decisions.find(d => d.status === 'failed')?.reason).toContain('already in progress');

    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await p1;

    const approvals = await h.service.getApprovalsByProposal(PROPOSAL_ID, 1);
    expect(approvals.approvals.length).toBe(1);
    expect(approvals.approvals[0]!.lifecycleState).toBe('approved');

    const authorized = await h.service.verifyApplicationAuthorization(PROPOSAL_ID, 1, NOW);
    expect(authorized.authorized).toBe(true);
  });

  it('disposed controller rejects any approval action', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);
    h.controller.dispose();

    await h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');
    expect(decisions[0]!.reason).toContain('disposing');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();
  });

  it('workspace or file identity mismatch is rejected', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    await h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws_b',
      fileUri: 'file:///rootB/file.ts',
    });

    expect(h.gate.calls.length).toBe(0);
    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');
    expect(decisions[0]!.reason).toContain('identity mismatch');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();
  });

  it('unknown proposal not pending is rejected', async () => {
    await h.controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    expect(h.gate.calls.length).toBe(0);
    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');
    expect(decisions[0]!.reason).toContain('No pending approval request');
  });

  it('expired proposal cannot be approved', async () => {
    await createProposalInRepo(h.proposalRepo, {
      createdAt: NOW - 2_000_000,
      expiresAt: NOW - 1_000_000,
    });
    registerPending(h.controller, { expiresAt: NOW - 1_000_000 });

    await h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });

    expect(h.gate.calls.length).toBe(0);
    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('failed');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval).toBeNull();
  });

  it('webview content hash hint is ignored; trusted proposal hash is bound', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      approvedContentHash: '0'.repeat(64),
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await decisionPromise;

    // The controller binds the hash from the trusted proposal, not the webview hint.
    expect(h.gate.calls.length).toBe(1);
    const decisions = approvalDecisionMessages(h);
    expect(decisions[0]!.status).toBe('approved');

    const approval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(approval.approval!.approvedContentHash).toBe(PROPOSED_HASH);
    expect(approval.approval!.approvedContentHash).not.toBe('0'.repeat(64));
  });

  it('persistence reload preserves the approval and authorization', async () => {
    await createProposalInRepo(h.proposalRepo);
    registerPending(h.controller);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await decisionPromise;

    const firstApproval = await getApprovalForVersion(h, PROPOSAL_ID, 1);
    expect(firstApproval.approval!.lifecycleState).toBe('approved');

    const proposalPort2 = new ProposalRepositoryAdapter(new SqlJsProposalRepository(h.db));
    const approvalPort2 = new ApprovalRepositoryAdapter(new SqlJsApprovalRepository(h.db));
    const reloadedService = createTrustedApprovalService({
      proposals: proposalPort2,
      approvals: approvalPort2,
      trustedDecisionProvider: h.gate.provider,
      now: defaultNow,
      createApprovalId: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });

    const authorization = await reloadedService.verifyApplicationAuthorization(PROPOSAL_ID, 1, NOW);
    expect(authorization.authorized).toBe(true);
    expect(authorization.approval!.lifecycleState).toBe('approved');

    const reloadedApproval = await reloadedService.getApprovalForVersion(PROPOSAL_ID, 1);
    expect(reloadedApproval.approval!.proposalId).toBe(PROPOSAL_ID);
    expect(reloadedApproval.approval!.proposalVersion).toBe(1);
    expect(reloadedApproval.approval!.workspaceId).toBe(WORKSPACE_ID);
    expect(reloadedApproval.approval!.fileUri).toBe(FILE_URI);
    expect(reloadedApproval.approval!.approvedContentHash).toBe(PROPOSED_HASH);
  });
});
