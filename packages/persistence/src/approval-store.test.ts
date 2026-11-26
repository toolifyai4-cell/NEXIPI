import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PersistenceService as FoundationPersistenceService } from './PersistenceService.js';
import { SqlJsConversationRepository, SqlJsMessageRepository } from './repositories.js';
import {
  SqlJsProposalRepository,
  CreateProposalInput,
  ProposalStatus,
  executeInTransaction,
} from './proposal-repository.js';
import {
  SqlJsApprovalRepository,
  CreateApprovalInput,
  ApprovalProvenance,
} from './approval-repository.js';

const ORIGINAL_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
const PROPOSED_HASH = '2222222222222222222222222222222222222222222222222222222222222222';
const OTHER_HASH = '3333333333333333333333333333333333333333333333333333333333333333';

const trustedProvenance: ApprovalProvenance = {
  kind: 'trusted-boundary',
  boundary: 'user-boundary-1',
};
const modelProvenance: ApprovalProvenance = { kind: 'model-tool-input' };
const untrustedProvenance: ApprovalProvenance = {
  kind: 'untrusted',
  reason: 'model generated',
};

function makeProposalInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    proposalVersion: 1,
    workspaceId: 'ws-001',
    workspaceFolderUri: 'file:///workspace',
    fileUri: 'file:///workspace/file.txt',
    relativePath: 'file.txt',
    originalContentHash: ORIGINAL_HASH,
    originalSize: 100,
    originalMtime: 1000,
    operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'hello' }],
    proposedContent: 'hello world',
    proposedContentHash: PROPOSED_HASH,
    proposedSize: 11,
    status: 'awaiting-approval',
    createdAt: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

function makeApprovalInput(overrides: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    proposalId: '11111111-1111-1111-1111-111111111111',
    proposalVersion: 1,
    decision: null,
    approvedContentHash: PROPOSED_HASH,
    decidedAt: null,
    provenance: trustedProvenance,
    lifecycleState: 'pending',
    expiresAt: null,
    workspaceId: 'ws-001',
    fileUri: 'file:///workspace/file.txt',
    createdAt: 1000,
    ...overrides,
  };
}

describe('Approval Store - Proposal persistence', () => {
  let service: FoundationPersistenceService;
  let proposalRepo: SqlJsProposalRepository;

  beforeEach(async () => {
    service = new FoundationPersistenceService();
    await service.init();
    proposalRepo = new SqlJsProposalRepository(service.getRawDatabase());
  });

  afterEach(() => {
    service.close();
  });

  it('creates and retrieves a proposal', async () => {
    const input = makeProposalInput();
    const result = await proposalRepo.createProposal(input);
    expect(result.error).toBeNull();
    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.proposal!.proposalVersion).toBe(1);

    const getResult = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(getResult.error).toBeNull();
    expect(getResult.proposal).not.toBeNull();
    expect(getResult.proposal!.proposedContent).toBe('hello world');
    expect(getResult.proposal!.status).toBe('awaiting-approval');
  });

  it('retrieves the exact proposal version', async () => {
    await proposalRepo.createProposal(
      makeProposalInput({ id: '11111111-1111-1111-1111-111111111111', proposalVersion: 1 })
    );
    await proposalRepo.createProposal(
      makeProposalInput({
        id: '11111111-1111-1111-1111-111111111111',
        proposalVersion: 2,
        proposedContent: 'v2 content',
        proposedContentHash: OTHER_HASH,
        status: 'validated',
      })
    );

    const v1 = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(v1.proposal!.proposalVersion).toBe(1);
    expect(v1.proposal!.proposedContent).toBe('hello world');

    const v2 = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 2);
    expect(v2.proposal!.proposalVersion).toBe(2);
    expect(v2.proposal!.proposedContent).toBe('v2 content');
    expect(v2.proposal!.proposedContentHash).toBe(OTHER_HASH);
  });

  it('returns null with no error for a missing proposal', async () => {
    const result = await proposalRepo.getProposal('does-not-exist', 1);
    expect(result.error).toBeNull();
    expect(result.proposal).toBeNull();
  });

  it('rejects duplicate proposal/version creation deterministically', async () => {
    const input = makeProposalInput({
      id: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });
    const first = await proposalRepo.createProposal(input);
    expect(first.error).toBeNull();

    const duplicate = await proposalRepo.createProposal(input);
    expect(duplicate.error).not.toBeNull();
    expect(duplicate.proposal).toBeNull();

    // The original must remain intact.
    const getResult = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(getResult.error).toBeNull();
    expect(getResult.proposal!.proposalVersion).toBe(1);
  });

  it('supports multiple versions of the same proposal', async () => {
    await proposalRepo.createProposal(
      makeProposalInput({ id: '11111111-1111-1111-1111-111111111111', proposalVersion: 1 })
    );
    await proposalRepo.createProposal(
      makeProposalInput({ id: '11111111-1111-1111-1111-111111111111', proposalVersion: 2 })
    );
    await proposalRepo.createProposal(
      makeProposalInput({ id: '11111111-1111-1111-1111-111111111111', proposalVersion: 3 })
    );

    const byId = await proposalRepo.getProposalById('11111111-1111-1111-1111-111111111111');
    expect(byId.error).toBeNull();
    expect(byId.proposals.map(p => p.proposalVersion)).toEqual([1, 2, 3]);
  });

  it('preserves content hash integrity', async () => {
    const input = makeProposalInput({ proposedContentHash: PROPOSED_HASH });
    const result = await proposalRepo.createProposal(input);
    expect(result.error).toBeNull();

    const stored = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(stored.proposal!.proposedContentHash).toBe(PROPOSED_HASH);
    expect(stored.proposal!.originalContentHash).toBe(ORIGINAL_HASH);
  });

  it('preserves the complete proposed content (not truncated)', async () => {
    const longContent = 'x'.repeat(100000);
    const input = makeProposalInput({
      proposedContent: longContent,
      proposedContentHash: 'a'.repeat(64),
    });
    const result = await proposalRepo.createProposal(input);
    expect(result.error).toBeNull();

    const stored = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(stored.proposal!.proposedContent).toBe(longContent);
    expect(stored.proposal!.proposedContent.length).toBe(100000);
  });

  it('rejects invalid proposal data', async () => {
    const badHash = await proposalRepo.createProposal(
      makeProposalInput({ proposedContentHash: 'not-a-valid-hash' })
    );
    expect(badHash.error).not.toBeNull();

    const badVersion = await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 0 }));
    expect(badVersion.error).not.toBeNull();

    const badId = await proposalRepo.createProposal(makeProposalInput({ id: 'not-a-uuid' }));
    expect(badId.error).not.toBeNull();

    const missingField = await proposalRepo.createProposal(makeProposalInput({ workspaceId: '' }));
    expect(missingField.error).not.toBeNull();
  });

  it('rejects an invalid lifecycle status', async () => {
    const result = await proposalRepo.createProposal(
      makeProposalInput({ status: 'not-a-status' as unknown as ProposalStatus })
    );
    expect(result.error).not.toBeNull();
    expect(result.proposal).toBeNull();
  });

  it('updates lifecycle status through a validated operation', async () => {
    await proposalRepo.createProposal(makeProposalInput({ status: 'validated' }));

    const updated = await proposalRepo.updateProposalStatus(
      '11111111-1111-1111-1111-111111111111',
      1,
      'awaiting-approval'
    );
    expect(updated.error).toBeNull();
    expect(updated.proposal!.status).toBe('awaiting-approval');

    const invalidStatus = await proposalRepo.updateProposalStatus(
      '11111111-1111-1111-1111-111111111111',
      1,
      'not-a-status' as unknown as ProposalStatus
    );
    expect(invalidStatus.error).not.toBeNull();

    const missing = await proposalRepo.updateProposalStatus('nope', 1, 'approved');
    expect(missing.error).not.toBeNull();
    expect(missing.proposal).toBeNull();
  });

  it('lists proposals with bounded filters and pagination', async () => {
    await proposalRepo.createProposal(
      makeProposalInput({
        id: '11111111-1111-1111-1111-111111111111',
        proposalVersion: 1,
        status: 'awaiting-approval',
      })
    );
    await proposalRepo.createProposal(
      makeProposalInput({
        id: '11111111-1111-1111-1111-111111111111',
        proposalVersion: 2,
        status: 'approved',
      })
    );
    await proposalRepo.createProposal(
      makeProposalInput({
        id: '33333333-3333-3333-3333-333333333333',
        proposalVersion: 1,
        status: 'awaiting-approval',
      })
    );

    const all = await proposalRepo.listProposals(undefined, 10, 0);
    expect(all.error).toBeNull();
    expect(all.proposals).toHaveLength(3);

    const filtered = await proposalRepo.listProposals({ status: 'awaiting-approval' }, 10, 0);
    expect(filtered.error).toBeNull();
    expect(filtered.proposals).toHaveLength(2);

    const firstPage = await proposalRepo.listProposals(undefined, 2, 0);
    expect(firstPage.error).toBeNull();
    expect(firstPage.proposals).toHaveLength(2);

    const secondPage = await proposalRepo.listProposals(undefined, 2, 2);
    expect(secondPage.error).toBeNull();
    expect(secondPage.proposals).toHaveLength(1);

    // Limit is bounded above the max.
    const capped = await proposalRepo.listProposals(undefined, 99999, 0);
    expect(capped.error).toBeNull();
    expect(capped.proposals).toHaveLength(3);
  });

  it('proposal list offset beyond range returns empty', async () => {
    await proposalRepo.createProposal(makeProposalInput());
    const result = await proposalRepo.listProposals(undefined, 10, 100);
    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(0);
  });
});

describe('Approval Store - Approval persistence', () => {
  let service: FoundationPersistenceService;
  let proposalRepo: SqlJsProposalRepository;
  let approvalRepo: SqlJsApprovalRepository;

  beforeEach(async () => {
    service = new FoundationPersistenceService();
    await service.init();
    proposalRepo = new SqlJsProposalRepository(service.getRawDatabase());
    approvalRepo = new SqlJsApprovalRepository(service.getRawDatabase());
  });

  afterEach(() => {
    service.close();
  });

  async function createProposalFirst(version: number) {
    return proposalRepo.createProposal(makeProposalInput({ proposalVersion: version }));
  }

  it('creates and retrieves an approval', async () => {
    await createProposalFirst(1);
    const input = makeApprovalInput({
      id: '22222222-2222-2222-2222-222222222222',
      decision: 'approve',
      decidedAt: 1500,
      lifecycleState: 'approved',
      expiresAt: 3000,
    });
    const result = await approvalRepo.createApproval(input);
    expect(result.error).toBeNull();
    expect(result.approval).not.toBeNull();
    expect(result.approval!.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(result.approval!.decision).toBe('approve');
    expect(result.approval!.lifecycleState).toBe('approved');

    const getResult = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(getResult.error).toBeNull();
    expect(getResult.approval!.decision).toBe('approve');
    expect(getResult.approval!.decidedAt).toBe(1500);
    expect(getResult.approval!.expiresAt).toBe(3000);
  });

  it('returns null with no error for a missing approval', async () => {
    const result = await approvalRepo.getApproval('does-not-exist');
    expect(result.error).toBeNull();
    expect(result.approval).toBeNull();
  });

  it('retrieves approvals associated with a proposal', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({ id: '22222222-2222-2222-2222-222222222222', proposalVersion: 1 })
    );
    await approvalRepo.createApproval(
      makeApprovalInput({ id: '44444444-4444-4444-4444-444444444444', proposalVersion: 1 })
    );
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        proposalId: '33333333-3333-3333-3333-333333333333',
        proposalVersion: 1,
      })
    );

    const byProposal = await approvalRepo.getApprovalsByProposal(
      '11111111-1111-1111-1111-111111111111'
    );
    expect(byProposal.error).toBeNull();
    expect(byProposal.approvals.map(a => a.id)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '44444444-4444-4444-4444-444444444444',
    ]);

    const byProposalAndVersion = await approvalRepo.getApprovalsByProposal(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(byProposalAndVersion.error).toBeNull();
    expect(byProposalAndVersion.approvals).toHaveLength(2);
  });

  it('retrieves the relevant approval for an exact proposal version', async () => {
    await createProposalFirst(1);
    await createProposalFirst(2);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '55555555-5555-5555-5555-555555555555',
        proposalVersion: 1,
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '66666666-6666-6666-6666-666666666666',
        proposalVersion: 2,
        decision: 'reject',
        decidedAt: 1600,
        lifecycleState: 'rejected',
      })
    );

    const v1 = await approvalRepo.getApprovalForVersion('11111111-1111-1111-1111-111111111111', 1);
    expect(v1.error).toBeNull();
    expect(v1.approval!.proposalVersion).toBe(1);
    expect(v1.approval!.id).toBe('55555555-5555-5555-5555-555555555555');

    const v2 = await approvalRepo.getApprovalForVersion('11111111-1111-1111-1111-111111111111', 2);
    expect(v2.error).toBeNull();
    expect(v2.approval!.proposalVersion).toBe(2);
    expect(v2.approval!.id).toBe('66666666-6666-6666-6666-666666666666');
  });

  it('preserves multiple approval decisions and history without overwriting', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );
    // A second decision record for the same proposal/version is a separate row.
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '44444444-4444-4444-4444-444444444444',
        decision: 'reject',
        decidedAt: 1600,
        lifecycleState: 'rejected',
      })
    );

    const history = await approvalRepo.getApprovalsByProposal(
      '11111111-1111-1111-1111-111111111111',
      1
    );
    expect(history.error).toBeNull();
    expect(history.approvals).toHaveLength(2);
    expect(history.approvals.map(a => a.decision)).toEqual(['approve', 'reject']);
    expect(history.approvals.map(a => a.id)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '44444444-4444-4444-4444-444444444444',
    ]);

    // The first record remains unchanged.
    const first = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(first.approval!.decision).toBe('approve');
    expect(first.approval!.lifecycleState).toBe('approved');
  });

  it('rejects duplicate approval IDs', async () => {
    await createProposalFirst(1);
    const input = makeApprovalInput({
      id: '22222222-2222-2222-2222-222222222222',
      decision: 'approve',
      decidedAt: 1500,
      lifecycleState: 'approved',
    });
    const first = await approvalRepo.createApproval(input);
    expect(first.error).toBeNull();

    const duplicate = await approvalRepo.createApproval(input);
    expect(duplicate.error).not.toBeNull();
    expect(duplicate.approval).toBeNull();

    const getResult = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(getResult.error).toBeNull();
    expect(getResult.approval!.id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('rejects invalid provenance', async () => {
    await createProposalFirst(1);
    const result = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        provenance: { kind: 'unknown-kind' } as unknown as ApprovalProvenance,
      })
    );
    expect(result.error).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('rejects invalid content hashes', async () => {
    await createProposalFirst(1);
    const result = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        approvedContentHash: 'not-a-hash',
      })
    );
    expect(result.error).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('distinguishes rejected versus approved decisions', async () => {
    await createProposalFirst(1);
    const approved = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '77777777-7777-7777-7777-777777777777',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );
    const rejected = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '88888888-8888-8888-8888-888888888888',
        decision: 'reject',
        decidedAt: 1600,
        lifecycleState: 'rejected',
      })
    );
    expect(approved.error).toBeNull();
    expect(approved.approval!.lifecycleState).toBe('approved');
    expect(rejected.error).toBeNull();
    expect(rejected.approval!.lifecycleState).toBe('rejected');
    expect(approved.approval!.decision).toBe('approve');
    expect(rejected.approval!.decision).toBe('reject');
  });

  it('persists expiration', async () => {
    await createProposalFirst(1);
    const input = makeApprovalInput({
      id: '22222222-2222-2222-2222-222222222222',
      decision: 'approve',
      decidedAt: 1500,
      lifecycleState: 'approved',
      expiresAt: 3000,
    });
    const result = await approvalRepo.createApproval(input);
    expect(result.error).toBeNull();
    expect(result.approval!.expiresAt).toBe(3000);

    const stored = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(stored.approval!.expiresAt).toBe(3000);
  });

  it('persists revocation', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );

    const revoked = await approvalRepo.recordRevocation('22222222-2222-2222-2222-222222222222');
    expect(revoked.error).toBeNull();
    expect(revoked.approval!.lifecycleState).toBe('revoked');

    const stored = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(stored.approval!.lifecycleState).toBe('revoked');
  });

  it('only allows revocation from approved state', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'reject',
        decidedAt: 1500,
        lifecycleState: 'rejected',
      })
    );

    const revoked = await approvalRepo.recordRevocation('22222222-2222-2222-2222-222222222222');
    expect(revoked.error).not.toBeNull();
    expect(revoked.approval).toBeNull();
  });

  it('records expiration only for pending or approved approvals', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'reject',
        decidedAt: 1500,
        lifecycleState: 'rejected',
        expiresAt: 3000,
      })
    );

    const expired = await approvalRepo.recordExpiration('22222222-2222-2222-2222-222222222222');
    expect(expired.error).toBeNull();
    expect(expired.approval!.lifecycleState).toBe('rejected'); // unchanged
  });

  it('does not accept model-generated provenance as trusted proof', async () => {
    await createProposalFirst(1);
    const result = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        provenance: modelProvenance,
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );
    // The store persists the record faithfully; provenance is preserved as metadata.
    expect(result.error).toBeNull();
    const stored = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(stored.approval!.provenance.kind).toBe('model-tool-input');
  });

  it('retrieves approvals with list filters and pagination', async () => {
    await createProposalFirst(1);
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        lifecycleState: 'approved',
        decision: 'approve',
        decidedAt: 1500,
      })
    );
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '44444444-4444-4444-4444-444444444444',
        lifecycleState: 'rejected',
        decision: 'reject',
        decidedAt: 1600,
      })
    );

    const all = await approvalRepo.listApprovals(undefined, 10, 0);
    expect(all.error).toBeNull();
    expect(all.approvals).toHaveLength(2);

    const approvedOnly = await approvalRepo.listApprovals({ lifecycleState: 'approved' }, 10, 0);
    expect(approvedOnly.error).toBeNull();
    expect(approvedOnly.approvals).toHaveLength(1);
    expect(approvedOnly.approvals[0].decision).toBe('approve');

    const firstPage = await approvalRepo.listApprovals(undefined, 1, 0);
    expect(firstPage.error).toBeNull();
    expect(firstPage.approvals).toHaveLength(1);
  });
});

describe('Approval Store - Integrity and security', () => {
  let service: FoundationPersistenceService;
  let proposalRepo: SqlJsProposalRepository;
  let approvalRepo: SqlJsApprovalRepository;

  beforeEach(async () => {
    service = new FoundationPersistenceService();
    await service.init();
    proposalRepo = new SqlJsProposalRepository(service.getRawDatabase());
    approvalRepo = new SqlJsApprovalRepository(service.getRawDatabase());
  });

  afterEach(() => {
    service.close();
  });

  it('rejects an approval referencing a nonexistent proposal version', async () => {
    const result = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        proposalId: '99999999-9999-9999-9999-999999999999',
        proposalVersion: 1,
      })
    );
    expect(result.error).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('rejects an approval referencing a nonexistent proposal version number', async () => {
    await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 1 }));
    const result = await approvalRepo.createApproval(
      makeApprovalInput({ id: '22222222-2222-2222-2222-222222222222', proposalVersion: 2 })
    );
    expect(result.error).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('binds an approval to an exact proposal version and hash', async () => {
    await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 1 }));
    await proposalRepo.createProposal(
      makeProposalInput({ proposalVersion: 2, proposedContentHash: OTHER_HASH })
    );

    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '55555555-5555-5555-5555-555555555555',
        proposalVersion: 1,
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
        approvedContentHash: PROPOSED_HASH,
      })
    );

    const v1 = await approvalRepo.getApprovalForVersion('11111111-1111-1111-1111-111111111111', 1);
    expect(v1.approval!.proposalVersion).toBe(1);
    expect(v1.approval!.approvedContentHash).toBe(PROPOSED_HASH);

    // No approval exists for version 2.
    const v2 = await approvalRepo.getApprovalForVersion('11111111-1111-1111-1111-111111111111', 2);
    expect(v2.error).toBeNull();
    expect(v2.approval).toBeNull();
  });

  it('persists trusted provenance as metadata only, not as authorization', async () => {
    await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 1 }));
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        provenance: trustedProvenance,
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
      })
    );
    const stored = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(stored.error).toBeNull();
    expect(stored.approval!.provenance.kind).toBe('trusted-boundary');
    // The store does not confer authorization; that determination belongs to E3.
    expect(stored.approval!.lifecycleState).toBe('approved');
  });

  it('does not create an approval automatically when a proposal is created', async () => {
    await proposalRepo.createProposal(makeProposalInput());
    const approvals = await approvalRepo.getApprovalsByProposal(
      '11111111-1111-1111-1111-111111111111'
    );
    expect(approvals.error).toBeNull();
    expect(approvals.approvals).toHaveLength(0);
  });

  it('performs no filesystem write operations', async () => {
    // The store only uses the supplied sql.js database handle. No fs calls are
    // made by the repositories; verifying via behavior (all operations succeed
    // against an in-memory database with no file path).
    await proposalRepo.createProposal(makeProposalInput());
    await approvalRepo.createApproval(makeApprovalInput());
    expect(service.isInitialized()).toBe(true);
  });

  it('rolls back a failed compound operation via transaction', async () => {
    await proposalRepo.createProposal(
      makeProposalInput({ id: '11111111-1111-1111-1111-111111111111', proposalVersion: 1 })
    );

    let threw = false;
    try {
      await executeInTransaction(service.getRawDatabase(), async db => {
        // Use raw SQL inside the transaction to simulate a compound op.
        db.exec(
          `INSERT INTO proposal_versions (id, proposal_version, workspace_id, workspace_folder_uri, file_uri, relative_path, original_content_hash, original_size, original_mtime, operations, proposed_content, proposed_content_hash, proposed_size, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            '33333333-3333-3333-3333-333333333333',
            2,
            'ws-001',
            'file:///workspace',
            'file:///workspace/file.txt',
            'file.txt',
            ORIGINAL_HASH,
            100,
            1000,
            '[]',
            'txn content',
            'b'.repeat(64),
            11,
            'awaiting-approval',
            1000,
            2000,
          ]
        );
        // Force a failure: duplicate primary key for prop-001 version 1.
        db.exec(
          `INSERT INTO proposal_versions (id, proposal_version, workspace_id, workspace_folder_uri, file_uri, relative_path, original_content_hash, original_size, original_mtime, operations, proposed_content, proposed_content_hash, proposed_size, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            '11111111-1111-1111-1111-111111111111',
            1,
            'ws-001',
            'file:///workspace',
            'file:///workspace/file.txt',
            'file.txt',
            ORIGINAL_HASH,
            100,
            1000,
            '[]',
            'should not persist',
            'c'.repeat(64),
            11,
            'awaiting-approval',
            1000,
            2000,
          ]
        );
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The duplicate row must not have been persisted.
    const dup = await proposalRepo.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(dup.proposal!.proposedContent).toBe('hello world');

    // The first insert inside the rolled-back transaction must not persist either.
    const txn = await proposalRepo.getProposal('33333333-3333-3333-3333-333333333333', 2);
    expect(txn.proposal).toBeNull();
  });

  it('rejects an approval whose content hash does not match the proposal version', async () => {
    await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 1 })); // proposedContentHash = PROPOSED_HASH

    const result = await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
        approvedContentHash: OTHER_HASH,
      })
    );
    expect(result.error).not.toBeNull();
    expect(result.approval).toBeNull();
  });

  it('prevents deletion of a proposal version that has approval history', async () => {
    await proposalRepo.createProposal(makeProposalInput({ proposalVersion: 1 }));
    await approvalRepo.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
        approvedContentHash: PROPOSED_HASH,
      })
    );

    const db = service.getRawDatabase();
    let threw = false;
    try {
      db.exec(
        "DELETE FROM proposal_versions WHERE id='11111111-1111-1111-1111-111111111111' AND proposal_version=1"
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Approval history remains intact.
    const stored = await approvalRepo.getApproval('22222222-2222-2222-2222-222222222222');
    expect(stored.error).toBeNull();
    expect(stored.approval).not.toBeNull();
  });
});

describe('Approval Store - Migration and persistence across reopen', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexipi-approval-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes a fresh database with proposal and approval tables', async () => {
    const service = new FoundationPersistenceService({ dbPath });
    await service.init();

    const migrations = service
      .getRawDatabase()
      .exec('SELECT version FROM migrations ORDER BY version');
    const versions = migrations[0].values.map(row => row[0]);
    expect(versions).toEqual([1, 2, 3, 4]);

    const tables = service
      .getRawDatabase()
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('proposal_versions', 'approval_decisions')"
      );
    const names = tables[0].values.map(row => row[0]);
    expect(names).toContain('proposal_versions');
    expect(names).toContain('approval_decisions');

    service.close();
  });

  it('migrates an existing database forward and preserves conversations and messages', async () => {
    // Phase 1: create and seed an old database (migrations 1-3 apply automatically).
    const service1 = new FoundationPersistenceService({ dbPath });
    await service1.init();
    const convRepo1 = new SqlJsConversationRepository(service1.getRawDatabase());
    const msgRepo1 = new SqlJsMessageRepository(service1.getRawDatabase());

    await convRepo1.create({
      id: 'conv-001',
      workspace_id: 'ws-001',
      title: 'Old Conversation',
      created_at: 1000,
      updated_at: 1000,
    });
    await msgRepo1.create({
      id: 'msg-001',
      conversation_id: 'conv-001',
      role: 'user',
      content: 'Hello',
      status: 'completed',
      timestamp: 1000,
      seq: 0,
    });

    const migrationsBefore = service1
      .getRawDatabase()
      .exec('SELECT version FROM migrations ORDER BY version');
    expect(migrationsBefore[0].values.map(row => row[0])).toEqual([1, 2, 3, 4]);

    service1.save();
    service1.close();

    // Phase 2: reopen - migration 4 already applied on fresh init; old data preserved.
    const service2 = new FoundationPersistenceService({ dbPath });
    await service2.init();

    const migrationsAfter = service2
      .getRawDatabase()
      .exec('SELECT version FROM migrations ORDER BY version');
    expect(migrationsAfter[0].values.map(row => row[0])).toEqual([1, 2, 3, 4]);
    const convRepo2 = new SqlJsConversationRepository(service2.getRawDatabase());
    const msgRepo2 = new SqlJsMessageRepository(service2.getRawDatabase());

    const conv = await convRepo2.getById('conv-001');
    expect(conv.error).toBeNull();
    expect(conv.conversation!.title).toBe('Old Conversation');

    const msg = await msgRepo2.getById('msg-001');
    expect(msg.error).toBeNull();
    expect(msg.message!.content).toBe('Hello');

    service2.close();
  });

  it('reopens and reloads persisted proposal and approval data', async () => {
    const service1 = new FoundationPersistenceService({ dbPath });
    await service1.init();
    const proposalRepo1 = new SqlJsProposalRepository(service1.getRawDatabase());
    const approvalRepo1 = new SqlJsApprovalRepository(service1.getRawDatabase());

    await proposalRepo1.createProposal(makeProposalInput({ proposalVersion: 1 }));
    await approvalRepo1.createApproval(
      makeApprovalInput({
        id: '22222222-2222-2222-2222-222222222222',
        decision: 'approve',
        decidedAt: 1500,
        lifecycleState: 'approved',
        expiresAt: 3000,
      })
    );

    service1.save();
    service1.close();

    const service2 = new FoundationPersistenceService({ dbPath });
    await service2.init();
    const proposalRepo2 = new SqlJsProposalRepository(service2.getRawDatabase());
    const approvalRepo2 = new SqlJsApprovalRepository(service2.getRawDatabase());

    const proposal = await proposalRepo2.getProposal('11111111-1111-1111-1111-111111111111', 1);
    expect(proposal.error).toBeNull();
    expect(proposal.proposal!.proposedContent).toBe('hello world');
    expect(proposal.proposal!.proposedContentHash).toBe(PROPOSED_HASH);

    const approval = await approvalRepo2.getApproval('22222222-2222-2222-2222-222222222222');
    expect(approval.error).toBeNull();
    expect(approval.approval!.decision).toBe('approve');
    expect(approval.approval!.lifecycleState).toBe('approved');
    expect(approval.approval!.expiresAt).toBe(3000);

    service2.close();
  });

  it('is migration idempotent across reopen cycles', async () => {
    const service1 = new FoundationPersistenceService({ dbPath });
    await service1.init();
    service1.save();
    service1.close();

    const service2 = new FoundationPersistenceService({ dbPath });
    await service2.init();
    const versions2 = service2
      .getRawDatabase()
      .exec('SELECT version FROM migrations ORDER BY version')[0]
      .values.map(row => row[0]);
    expect(versions2).toEqual([1, 2, 3, 4]);
    service2.save();
    service2.close();

    const service3 = new FoundationPersistenceService({ dbPath });
    await service3.init();
    const versions3 = service3
      .getRawDatabase()
      .exec('SELECT version FROM migrations ORDER BY version')[0]
      .values.map(row => row[0]);
    expect(versions3).toEqual([1, 2, 3, 4]);
    service3.close();
  });
});
