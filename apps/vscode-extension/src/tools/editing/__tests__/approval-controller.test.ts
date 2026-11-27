import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersistenceFoundation } from '@nexipi/persistence';
import { SqlJsProposalRepository, SqlJsApprovalRepository } from '@nexipi/persistence';
import {
  TrustedApprovalService,
  defaultNow,
  ApprovalErrorCode,
} from '@nexipi/workspace';
import { ApprovalController } from '../approval-controller';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from '../persistence-repository-adapters';

const ORIGINAL_HASH =
  '1111111111111111111111111111111111111111111111111111111111111111';
const PROPOSED_HASH =
  '2222222222222222222222222222222222222222222222222222222222222222';
const OTHER_HASH =
  '3333333333333333333333333333333333333333333333333333333333333333';

function makeProposalInput(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    proposalVersion: 1,
    workspaceId: 'ws-1',
    workspaceFolderUri: 'file:///workspace',
    fileUri: 'file:///workspace/file.txt',
    relativePath: 'file.txt',
    originalContentHash: ORIGINAL_HASH,
    originalSize: 10,
    originalMtime: 1000,
    operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'proposed' }],
    proposedContent: 'proposed',
    proposedContentHash: PROPOSED_HASH,
    proposedSize: 8,
    status: 'awaiting-approval' as const,
    createdAt: 1000,
    expiresAt: 2_000_000_000_000,
    ...overrides,
  };
}

function pendingProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: '11111111-1111-1111-1111-111111111111',
    proposalVersion: 1,
    fileUri: 'file:///workspace/file.txt',
    relativePath: 'file.txt',
    workspaceId: 'ws-1',
    workspaceName: 'workspace',
    proposedContentHash: PROPOSED_HASH,
    proposedSize: 8,
    createdAt: 1000,
    expiresAt: 2_000_000_000_000,
    preview: {},
    ...overrides,
  };
}

describe('ApprovalController', () => {
  let service: PersistenceFoundation;
  let proposalRepository: SqlJsProposalRepository;
  let approvalRepository: SqlJsApprovalRepository;
  let proposalPort: ProposalRepositoryAdapter;
  let approvalPort: ApprovalRepositoryAdapter;
  let trustedService: TrustedApprovalService;
  let provider: { establishUserDecision: ReturnType<typeof vi.fn> };
  let postMessage: ReturnType<typeof vi.fn>;
  let controller: ApprovalController;

  beforeEach(async () => {
    service = new PersistenceFoundation();
    await service.init();
    const rawDb = service.getRawDatabase();
    proposalRepository = new SqlJsProposalRepository(rawDb);
    approvalRepository = new SqlJsApprovalRepository(rawDb);
    proposalPort = new ProposalRepositoryAdapter(proposalRepository);
    approvalPort = new ApprovalRepositoryAdapter(approvalRepository);

    provider = { establishUserDecision: vi.fn() };
    trustedService = new TrustedApprovalService({
      proposals: proposalPort,
      approvals: approvalPort,
      trustedDecisionProvider: provider as never,
      now: defaultNow,
      createApprovalId: () => crypto.randomUUID() as never,
    });

    postMessage = vi.fn();
    controller = new ApprovalController({
      trustedApprovalService: trustedService,
      proposals: proposalPort,
      approvals: approvalPort,
      postMessage,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    await proposalRepository.createProposal(makeProposalInput());
  });

  afterEach(() => {
    service.close();
  });

  it('presents a created proposal for review and tracks it as pending', () => {
    controller.onProposalCreated(pendingProposal());

    expect(controller.getPendingProposals()).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposalCreated' })
    );
  });

  it('records an explicit approval through the trusted service', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValue({
      decision: 'approve',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: 2_000_000_000_000,
    });
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(controller.getPendingProposals()).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'approved', decision: 'approve' }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.error).toBeNull();
    expect(approval.approval!.decision).toBe('approve');
    expect(approval.approval!.approvedContentHash).toBe(PROPOSED_HASH);
  });

  it('records an explicit rejection', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValue({
      decision: 'reject',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
    });
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'reject',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(controller.getPendingProposals()).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'rejected', decision: 'reject' }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.approval!.decision).toBe('reject');
  });

  it('dismissal does not approve and records no approval', async () => {
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'dismiss',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(provider.establishUserDecision).not.toHaveBeenCalled();
    expect(controller.getPendingProposals()).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'dismissed', decision: null }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.approval).toBeNull();
  });

  it('fails closed when the provider establishes no decision (cancel)', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValue(null);
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(controller.getPendingProposals()).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'failed', decision: null }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.approval).toBeNull();
  });

  it('rejects a wrong content hash', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValue({
      decision: 'approve',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
    });
    controller.onProposalCreated(pendingProposal({ proposedContentHash: OTHER_HASH }));

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'failed' }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.approval).toBeNull();
  });

  it('rejects a wrong workspace identity', async () => {
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-other',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(provider.establishUserDecision).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'failed', reason: 'Workspace or file identity mismatch' }) })
    );
  });

  it('does not process a duplicate decision for an already-terminal approval', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValue({
      decision: 'approve',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
    });
    controller.onProposalCreated(pendingProposal());

    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    // Second conflicting decision for the same terminal proposal: fail closed.
    await controller.handleApprovalAction({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'reject',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'failed' }) })
    );
    const approval = await approvalPort.getApprovalForVersion(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(approval.approval!.decision).toBe('approve');
  });

  it('rejects an unknown proposal', async () => {
    controller.onProposalCreated(pendingProposal({ proposalId: '00000000-0000-0000-0000-000000000000' }));

    await controller.handleApprovalAction({
      proposalId: '00000000-0000-0000-0000-000000000000',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approvalDecision', payload: expect.objectContaining({ status: 'failed' }) })
    );
  });
});
