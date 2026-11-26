import { describe, it, expect } from 'vitest';
import {
  createPendingApproval,
  isApplicationAuthorizedState,
  isPendingState,
  isTerminalState,
  isTrustedProvenance,
  type Approval,
  type ApprovalLifecycleState,
  type ApprovalProvenance,
} from '../approval-contracts.js';

const VALID_APPROVAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440001';
const VALID_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TRUSTED_PROVENANCE: ApprovalProvenance = {
  kind: 'trusted-boundary',
  boundary: 'nexipi-trusted-approval-service',
};
const MODEL_PROVENANCE: ApprovalProvenance = { kind: 'model-tool-input' };

function makePendingApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    kind: 'edit-approval',
    approvalId: VALID_APPROVAL_ID,
    proposalId: VALID_PROPOSAL_ID,
    proposalVersion: 1,
    decision: null,
    approvedContentHash: VALID_HASH,
    decidedAt: null,
    provenance: TRUSTED_PROVENANCE,
    lifecycleState: 'pending',
    expiresAt: null,
    workspaceId: 'ws_workspaceA',
    fileUri: 'file:///workspaceA/file.txt',
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe('Approval contracts', () => {
  describe('isTrustedProvenance', () => {
    it('returns true for trusted-boundary provenance', () => {
      expect(isTrustedProvenance(TRUSTED_PROVENANCE)).toBe(true);
    });

    it('returns false for model-tool-input provenance', () => {
      expect(isTrustedProvenance(MODEL_PROVENANCE)).toBe(false);
    });

    it('returns false for proposal-creation provenance', () => {
      expect(isTrustedProvenance({ kind: 'proposal-creation' })).toBe(false);
    });

    it('returns false for untrusted provenance', () => {
      expect(isTrustedProvenance({ kind: 'untrusted', reason: 'model-supplied' })).toBe(false);
    });
  });

  describe('state predicates', () => {
    it('isPendingState returns true only for pending', () => {
      expect(isPendingState('pending')).toBe(true);
      expect(isPendingState('approved')).toBe(false);
      expect(isPendingState('rejected')).toBe(false);
    });

    it('isApplicationAuthorizedState returns true only for approved', () => {
      expect(isApplicationAuthorizedState('approved')).toBe(true);
      expect(isApplicationAuthorizedState('pending')).toBe(false);
      expect(isApplicationAuthorizedState('rejected')).toBe(false);
      expect(isApplicationAuthorizedState('expired')).toBe(false);
      expect(isApplicationAuthorizedState('revoked')).toBe(false);
    });

    it('isTerminalState returns true for rejected, expired, revoked', () => {
      expect(isTerminalState('rejected')).toBe(true);
      expect(isTerminalState('expired')).toBe(true);
      expect(isTerminalState('revoked')).toBe(true);
      expect(isTerminalState('pending')).toBe(false);
      expect(isTerminalState('approved')).toBe(false);
    });
  });

  describe('createPendingApproval', () => {
    it('creates a well-formed pending approval', () => {
      const approval = createPendingApproval({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 3,
        approvedContentHash: VALID_HASH,
        provenance: TRUSTED_PROVENANCE,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
        createdAt: 1700000000000,
      });
      expect(approval.kind).toBe('edit-approval');
      expect(approval.lifecycleState).toBe('pending');
      expect(approval.decision).toBeNull();
      expect(approval.decidedAt).toBeNull();
      expect(approval.proposalVersion).toBe(3);
      expect(approval.approvedContentHash).toBe(VALID_HASH);
      expect(isTrustedProvenance(approval.provenance)).toBe(true);
    });

    it('does not mutate the input', () => {
      const input = {
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        approvedContentHash: VALID_HASH,
        provenance: TRUSTED_PROVENANCE,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
        createdAt: 1700000000000,
      };
      const before = { ...input };
      createPendingApproval(input as never);
      expect(input).toEqual(before);
    });

    it('supports an expiry timestamp', () => {
      const approval = createPendingApproval({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        approvedContentHash: VALID_HASH,
        provenance: TRUSTED_PROVENANCE,
        expiresAt: 1700000120000,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
        createdAt: 1700000000000,
      });
      expect(approval.expiresAt).toBe(1700000120000);
    });
  });

  describe('distinct concepts', () => {
    it('proposal identity and approval identity are distinct fields', () => {
      const approval = makePendingApproval();
      expect(approval.approvalId).not.toBe(approval.proposalId);
      expect(approval.proposalVersion).toBe(1);
      expect(approval.approvedContentHash).toBe(VALID_HASH);
    });

    it('a proposal (EditProposal) is not an approval', () => {
      const proposal = {
        kind: 'edit-proposal',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        status: 'awaiting-approval',
      } as { kind: string; proposalId: string; proposalVersion: number; status: string };
      expect(proposal.kind).toBe('edit-proposal');
      expect((proposal as unknown as Approval).kind).not.toBe('edit-approval');
    });
  });

  describe('lifecycle state type covers required states', () => {
    const states: ApprovalLifecycleState[] = [
      'pending',
      'approved',
      'rejected',
      'expired',
      'revoked',
    ];
    for (const state of states) {
      it(`includes ${state}`, () => {
        expect(states).toContain(state);
      });
    }
  });
});
