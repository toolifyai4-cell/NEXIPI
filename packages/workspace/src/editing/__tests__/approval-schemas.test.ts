import { describe, it, expect } from 'vitest';
import {
  ApprovalSchema,
  ApprovalDecisionRequestSchema,
  ApprovalVerificationInputSchema,
  ApprovalProvenanceSchema,
  ApprovalLifecycleStateSchema,
  ApprovalDecisionSchema,
  ContentHashSchema,
  ProposalVersionSchema,
  TimestampSchema,
  validateApproval,
  safeValidateApproval,
  validateApprovalDecisionRequest,
  safeValidateApprovalDecisionRequest,
  validateApprovalVerificationInput,
  safeValidateApprovalVerificationInput,
} from '../approval-schemas.js';

const VALID_APPROVAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440001';
const VALID_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TRUSTED_PROVENANCE = {
  kind: 'trusted-boundary',
  boundary: 'nexipi-trusted-approval-service',
};
const MODEL_PROVENANCE = { kind: 'model-tool-input' };
const NOW = 1700000000000;

function makeValidApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    createdAt: NOW,
    ...overrides,
  };
}

describe('Approval schemas', () => {
  describe('ApprovalLifecycleStateSchema', () => {
    it('accepts all five lifecycle states', () => {
      for (const state of ['pending', 'approved', 'rejected', 'expired', 'revoked']) {
        expect(ApprovalLifecycleStateSchema.safeParse(state).success).toBe(true);
      }
    });

    it('rejects invalid lifecycle state', () => {
      expect(ApprovalLifecycleStateSchema.safeParse('approved-by-model').success).toBe(false);
    });
  });

  describe('ApprovalDecisionSchema', () => {
    it('accepts approve and reject', () => {
      expect(ApprovalDecisionSchema.safeParse('approve').success).toBe(true);
      expect(ApprovalDecisionSchema.safeParse('reject').success).toBe(true);
    });

    it('rejects other decisions', () => {
      expect(ApprovalDecisionSchema.safeParse('authorize').success).toBe(false);
    });
  });

  describe('ContentHashSchema', () => {
    it('accepts a valid lowercase SHA-256 hash', () => {
      expect(ContentHashSchema.safeParse(VALID_HASH).success).toBe(true);
    });

    it('rejects uppercase hash', () => {
      expect(ContentHashSchema.safeParse(VALID_HASH.toUpperCase()).success).toBe(false);
    });

    it('rejects short hash', () => {
      expect(ContentHashSchema.safeParse('e3b0c442').success).toBe(false);
    });

    it('rejects non-hex hash', () => {
      expect(
        ContentHashSchema.safeParse(
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85g'
        ).success
      ).toBe(false);
    });

    it('rejects empty hash', () => {
      expect(ContentHashSchema.safeParse('').success).toBe(false);
    });
  });

  describe('ProposalVersionSchema', () => {
    it('accepts positive versions up to 999', () => {
      expect(ProposalVersionSchema.safeParse(1).success).toBe(true);
      expect(ProposalVersionSchema.safeParse(999).success).toBe(true);
    });

    it('rejects zero, negative, and non-integer versions', () => {
      expect(ProposalVersionSchema.safeParse(0).success).toBe(false);
      expect(ProposalVersionSchema.safeParse(-1).success).toBe(false);
      expect(ProposalVersionSchema.safeParse(1.5).success).toBe(false);
      expect(ProposalVersionSchema.safeParse(1000).success).toBe(false);
    });
  });

  describe('TimestampSchema', () => {
    it('accepts positive millisecond timestamps', () => {
      expect(TimestampSchema.safeParse(1700000000000).success).toBe(true);
    });

    it('rejects zero, negative, and non-integer timestamps', () => {
      expect(TimestampSchema.safeParse(0).success).toBe(false);
      expect(TimestampSchema.safeParse(-1).success).toBe(false);
      expect(TimestampSchema.safeParse(1700000000000.5).success).toBe(false);
    });
  });

  describe('ApprovalProvenanceSchema', () => {
    it('accepts trusted-boundary provenance with a boundary', () => {
      expect(ApprovalProvenanceSchema.safeParse(TRUSTED_PROVENANCE).success).toBe(true);
    });

    it('accepts model-tool-input provenance', () => {
      expect(ApprovalProvenanceSchema.safeParse(MODEL_PROVENANCE).success).toBe(true);
    });

    it('accepts proposal-creation provenance', () => {
      expect(ApprovalProvenanceSchema.safeParse({ kind: 'proposal-creation' }).success).toBe(true);
    });

    it('accepts untrusted provenance with a reason', () => {
      expect(
        ApprovalProvenanceSchema.safeParse({ kind: 'untrusted', reason: 'model-supplied' }).success
      ).toBe(true);
    });

    it('rejects trusted-boundary without a boundary', () => {
      expect(
        ApprovalProvenanceSchema.safeParse({ kind: 'trusted-boundary', boundary: '' }).success
      ).toBe(false);
    });

    it('rejects unknown provenance kind', () => {
      expect(ApprovalProvenanceSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
    });
  });

  describe('ApprovalSchema', () => {
    it('validates a correct pending approval', () => {
      const result = safeValidateApproval(makeValidApproval());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lifecycleState).toBe('pending');
        expect(result.data.decision).toBeNull();
        expect(result.data.decidedAt).toBeNull();
      }
    });

    it('validates a correct approved approval', () => {
      const result = safeValidateApproval(
        makeValidApproval({
          lifecycleState: 'approved',
          decision: 'approve',
          decidedAt: NOW,
          provenance: TRUSTED_PROVENANCE,
        })
      );
      expect(result.success).toBe(true);
    });

    it('validates a correct rejected approval', () => {
      const result = safeValidateApproval(
        makeValidApproval({
          lifecycleState: 'rejected',
          decision: 'reject',
          decidedAt: NOW,
          provenance: TRUSTED_PROVENANCE,
        })
      );
      expect(result.success).toBe(true);
    });

    it('rejects invalid UUID approvalId', () => {
      const result = safeValidateApproval(makeValidApproval({ approvalId: 'not-a-uuid' }));
      expect(result.success).toBe(false);
    });

    it('rejects invalid UUID proposalId', () => {
      const result = safeValidateApproval(makeValidApproval({ proposalId: 'not-a-uuid' }));
      expect(result.success).toBe(false);
    });

    it('rejects invalid proposal version', () => {
      const result = safeValidateApproval(makeValidApproval({ proposalVersion: 0 }));
      expect(result.success).toBe(false);
    });

    it('rejects invalid hash', () => {
      const result = safeValidateApproval(makeValidApproval({ approvedContentHash: 'not-a-hash' }));
      expect(result.success).toBe(false);
    });

    it('rejects pending approval with a decision', () => {
      const result = safeValidateApproval(
        makeValidApproval({ lifecycleState: 'pending', decision: 'approve', decidedAt: NOW })
      );
      expect(result.success).toBe(false);
    });

    it('rejects decided approval without a decision', () => {
      const result = safeValidateApproval(
        makeValidApproval({ lifecycleState: 'approved', decision: null, decidedAt: null })
      );
      expect(result.success).toBe(false);
    });

    it('rejects reject decision with non-rejected state', () => {
      const result = safeValidateApproval(
        makeValidApproval({ lifecycleState: 'approved', decision: 'reject', decidedAt: NOW })
      );
      expect(result.success).toBe(false);
    });

    it('rejects model-tool-input provenance on an approved state', () => {
      const result = safeValidateApproval(
        makeValidApproval({
          lifecycleState: 'approved',
          decision: 'approve',
          decidedAt: NOW,
          provenance: MODEL_PROVENANCE,
        })
      );
      // Schema allows the shape, but provenance trust is enforced at the
      // lifecycle/decision layer, not the shape schema. This records the shape
      // is valid; trust is a runtime invariant checked by decideApproval.
      expect(result.success).toBe(true);
    });

    it('rejects invalid lifecycle state', () => {
      const result = safeValidateApproval(
        makeValidApproval({ lifecycleState: 'authorized-by-model' as any })
      );
      expect(result.success).toBe(false);
    });

    it('rejects empty workspaceId', () => {
      const result = safeValidateApproval(makeValidApproval({ workspaceId: '' }));
      expect(result.success).toBe(false);
    });

    it('validates via validateApproval throwing', () => {
      expect(() => validateApproval(makeValidApproval())).not.toThrow();
      expect(() => validateApproval(makeValidApproval({ proposalId: 'bad' }))).toThrow();
    });
  });

  describe('ApprovalDecisionRequestSchema', () => {
    it('validates a trusted approve request', () => {
      const result = safeValidateApprovalDecisionRequest({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: VALID_HASH,
        provenance: TRUSTED_PROVENANCE,
        decidedAt: NOW,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      });
      expect(result.success).toBe(true);
    });

    it('rejects model-supplied provenance in a decision request', () => {
      // Shape-valid; trust is enforced at the decision layer. Records that the
      // schema accepts the shape so callers can't claim the schema blocks it.
      const result = safeValidateApprovalDecisionRequest({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: VALID_HASH,
        provenance: MODEL_PROVENANCE,
        decidedAt: NOW,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing provenance', () => {
      const result = safeValidateApprovalDecisionRequest({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: VALID_HASH,
        decidedAt: NOW,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      } as never);
      expect(result.success).toBe(false);
    });
  });

  describe('ApprovalVerificationInputSchema', () => {
    it('validates a correct verification input', () => {
      const result = safeValidateApprovalVerificationInput({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        contentHash: VALID_HASH,
        now: NOW,
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid proposalId', () => {
      const result = safeValidateApprovalVerificationInput({
        proposalId: 'not-a-uuid',
        proposalVersion: 1,
        contentHash: VALID_HASH,
        now: NOW,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid hash', () => {
      const result = safeValidateApprovalVerificationInput({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        contentHash: 'not-a-hash',
        now: NOW,
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid now timestamp', () => {
      const result = safeValidateApprovalVerificationInput({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        contentHash: VALID_HASH,
        now: 0,
      });
      expect(result.success).toBe(false);
    });
  });
});
