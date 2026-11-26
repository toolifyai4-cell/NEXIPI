import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  decideApproval,
  revokeApproval,
  markExpired,
  verifyApprovalForApplication,
  createAuthorizationToApply,
} from '../approval-lifecycle.js';
import { ApprovalDomainError, ApprovalErrorCode } from '../approval-errors.js';
import {
  createPendingApproval,
  isTrustedProvenance,
  isTerminalState,
  isApplicationAuthorizedState,
  type ApprovalProvenance,
} from '../approval-contracts.js';

const VALID_APPROVAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440001';
const VALID_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DIFFERENT_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const TRUSTED_PROVENANCE: ApprovalProvenance = {
  kind: 'trusted-boundary',
  boundary: 'nexipi-trusted-approval-service',
};
const MODEL_PROVENANCE: ApprovalProvenance = { kind: 'model-tool-input' };
const PROPOSAL_CREATION_PROVENANCE: ApprovalProvenance = { kind: 'proposal-creation' };
const DECIDED_AT = 1700000000000;
const EXPIRES_AT = 1700000120000;
const NOW_BEFORE_EXPIRY = 1700000050000;
const NOW_AFTER_EXPIRY = 1700000130000;

function makePendingApproval(
  overrides: Partial<{
    approvalId: string;
    proposalId: string;
    proposalVersion: number;
    approvedContentHash: string;
    provenance: ApprovalProvenance;
    expiresAt: number | null;
    createdAt: number;
  }> = {}
): Approval {
  return createPendingApproval({
    approvalId: VALID_APPROVAL_ID,
    proposalId: VALID_PROPOSAL_ID,
    proposalVersion: 1,
    approvedContentHash: VALID_HASH,
    provenance: TRUSTED_PROVENANCE,
    expiresAt: null,
    workspaceId: 'ws_workspaceA',
    fileUri: 'file:///workspaceA/file.txt',
    createdAt: 1700000000000,
    ...overrides,
  });
}

function throwIfNotApprovalDomainError(error: unknown): asserts error is ApprovalDomainError {
  expect(error).toBeInstanceOf(ApprovalDomainError);
}

describe('Approval lifecycle', () => {
  describe('applyTransition - valid transitions', () => {
    it('transitions pending to approved', () => {
      expect(applyTransition('pending', 'approved')).toBe('approved');
    });

    it('transitions pending to rejected', () => {
      expect(applyTransition('pending', 'rejected')).toBe('rejected');
    });

    it('transitions pending to expired', () => {
      expect(applyTransition('pending', 'expired')).toBe('expired');
    });

    it('transitions approved to revoked', () => {
      expect(applyTransition('approved', 'revoked')).toBe('revoked');
    });

    it('transitions approved to expired', () => {
      expect(applyTransition('approved', 'expired')).toBe('expired');
    });
  });

  describe('applyTransition - duplicate transitions are idempotent', () => {
    it('pending to pending is a no-op', () => {
      expect(applyTransition('pending', 'pending')).toBe('pending');
    });

    it('approved to approved is a no-op', () => {
      expect(applyTransition('approved', 'approved')).toBe('approved');
    });

    it('rejected to rejected is a no-op', () => {
      expect(applyTransition('rejected', 'rejected')).toBe('rejected');
    });

    it('expired to expired is a no-op', () => {
      expect(applyTransition('expired', 'expired')).toBe('expired');
    });

    it('revoked to revoked is a no-op', () => {
      expect(applyTransition('revoked', 'revoked')).toBe('revoked');
    });
  });

  describe('applyTransition - invalid transitions throw', () => {
    const invalid: Array<[string, string]> = [
      ['rejected', 'approved'],
      ['expired', 'approved'],
      ['revoked', 'approved'],
      ['rejected', 'pending'],
      ['expired', 'pending'],
      ['revoked', 'pending'],
      ['rejected', 'expired'],
      ['expired', 'rejected'],
      ['revoked', 'rejected'],
      ['approved', 'pending'],
      ['pending', 'approved-to-reject'],
    ];
    for (const [from, to] of invalid) {
      it(`rejects transition from ${from} to ${to}`, () => {
        expect(() => applyTransition(from as any, to as any)).toThrow(ApprovalDomainError);
        try {
          applyTransition(from as any, to as any);
        } catch (error) {
          throwIfNotApprovalDomainError(error);
          expect((error as ApprovalDomainError).code).toBe(ApprovalErrorCode.INVALID_TRANSITION);
        }
      });
    }
  });

  describe('decideApproval - trusted approve', () => {
    it('approves a pending approval via trusted provenance', () => {
      const approval = makePendingApproval();
      const decided = decideApproval(
        approval,
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        EXPIRES_AT
      );
      expect(decided.lifecycleState).toBe('approved');
      expect(decided.decision).toBe('approve');
      expect(decided.decidedAt).toBe(DECIDED_AT);
      expect(decided.expiresAt).toBe(EXPIRES_AT);
      expect(isTrustedProvenance(decided.provenance)).toBe(true);
      expect(decided.approvedContentHash).toBe(VALID_HASH);
      // original is not mutated
      expect(approval.lifecycleState).toBe('pending');
    });

    it('binds the approval to the exact proposal id, version and content hash', () => {
      const approval = makePendingApproval({ proposalVersion: 5, approvedContentHash: VALID_HASH });
      const decided = decideApproval(approval, 'approve', TRUSTED_PROVENANCE, DECIDED_AT, null);
      expect(decided.proposalId).toBe(VALID_PROPOSAL_ID);
      expect(decided.proposalVersion).toBe(5);
      expect(decided.approvedContentHash).toBe(VALID_HASH);
    });
  });

  describe('decideApproval - trusted reject', () => {
    it('rejects a pending approval via trusted provenance', () => {
      const approval = makePendingApproval();
      const decided = decideApproval(approval, 'reject', TRUSTED_PROVENANCE, DECIDED_AT, null);
      expect(decided.lifecycleState).toBe('rejected');
      expect(decided.decision).toBe('reject');
      expect(decided.decidedAt).toBe(DECIDED_AT);
      expect(isTerminalState(decided.lifecycleState)).toBe(true);
      expect(isApplicationAuthorizedState(decided.lifecycleState)).toBe(false);
    });
  });

  describe('decideApproval - provenance trust enforcement', () => {
    it('rejects model-tool-input provenance for approve', () => {
      const approval = makePendingApproval();
      expect(() => decideApproval(approval, 'approve', MODEL_PROVENANCE, DECIDED_AT, null)).toThrow(
        ApprovalDomainError
      );
      expect(() =>
        decideApproval(approval, 'approve', MODEL_PROVENANCE, DECIDED_AT, null)
      ).toThrowError(/not trusted/);
    });

    it('rejects model-tool-input provenance for reject', () => {
      const approval = makePendingApproval();
      expect(() => decideApproval(approval, 'reject', MODEL_PROVENANCE, DECIDED_AT, null)).toThrow(
        ApprovalDomainError
      );
    });

    it('rejects proposal-creation provenance for approve', () => {
      const approval = makePendingApproval();
      expect(() =>
        decideApproval(approval, 'approve', PROPOSAL_CREATION_PROVENANCE, DECIDED_AT, null)
      ).toThrow(ApprovalDomainError);
    });

    it('does not accept model-supplied approval data as trusted proof', () => {
      // A model-supplied approval record (model-tool-input provenance) must
      // never be promoted to an approved state.
      const modelApproval = createPendingApproval({
        approvalId: '660e8400-e29b-41d4-a716-446655440002',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        approvedContentHash: VALID_HASH,
        provenance: MODEL_PROVENANCE,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
        createdAt: 1700000000000,
      });
      expect(isTrustedProvenance(modelApproval.provenance)).toBe(false);
      expect(() =>
        decideApproval(modelApproval, 'approve', MODEL_PROVENANCE, DECIDED_AT, null)
      ).toThrow(ApprovalDomainError);
    });
  });

  describe('decideApproval - preconditions', () => {
    it('throws when the approval is not pending', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      expect(() =>
        decideApproval(approved, 'reject', TRUSTED_PROVENANCE, DECIDED_AT + 1000, null)
      ).toThrow(ApprovalDomainError);
      try {
        decideApproval(approved, 'reject', TRUSTED_PROVENANCE, DECIDED_AT + 1000, null);
      } catch (error) {
        throwIfNotApprovalDomainError(error);
        expect((error as ApprovalDomainError).code).toBe(ApprovalErrorCode.NOT_PENDING);
      }
    });

    it('throws on invalid decidedAt', () => {
      const approval = makePendingApproval();
      expect(() => decideApproval(approval, 'approve', TRUSTED_PROVENANCE, 0, null)).toThrow(
        ApprovalDomainError
      );
      expect(() => decideApproval(approval, 'approve', TRUSTED_PROVENANCE, -1, null)).toThrow(
        ApprovalDomainError
      );
    });
  });

  describe('revokeApproval', () => {
    it('revokes an approved approval', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        EXPIRES_AT
      );
      const revoked = revokeApproval(approved);
      expect(revoked.lifecycleState).toBe('revoked');
      expect(isTerminalState(revoked.lifecycleState)).toBe(true);
      expect(isApplicationAuthorizedState(revoked.lifecycleState)).toBe(false);
      expect(approved.lifecycleState).toBe('approved'); // not mutated
    });

    it('throws when revoking a non-approved approval', () => {
      expect(() => revokeApproval(makePendingApproval())).toThrow(ApprovalDomainError);
      const rejected = decideApproval(
        makePendingApproval(),
        'reject',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      expect(() => revokeApproval(rejected)).toThrow(ApprovalDomainError);
    });

    it('revoking an already revoked approval is idempotent', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const revoked = revokeApproval(approved);
      expect(revokeApproval(revoked).lifecycleState).toBe('revoked');
    });
  });

  describe('markExpired', () => {
    it('expires a pending approval past its expiry', () => {
      const approval = makePendingApproval({ expiresAt: EXPIRES_AT });
      const expired = markExpired(approval, NOW_AFTER_EXPIRY);
      expect(expired.lifecycleState).toBe('expired');
      expect(isTerminalState(expired.lifecycleState)).toBe(true);
    });

    it('expires an approved approval past its expiry', () => {
      const approved = decideApproval(
        makePendingApproval({ expiresAt: EXPIRES_AT }),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        EXPIRES_AT
      );
      const expired = markExpired(approved, NOW_AFTER_EXPIRY);
      expect(expired.lifecycleState).toBe('expired');
    });

    it('does not expire before the expiry timestamp', () => {
      const approval = makePendingApproval({ expiresAt: EXPIRES_AT });
      expect(markExpired(approval, NOW_BEFORE_EXPIRY).lifecycleState).toBe('pending');
    });

    it('does not expire when expiresAt is null', () => {
      const approval = makePendingApproval({ expiresAt: null });
      expect(markExpired(approval, NOW_AFTER_EXPIRY).lifecycleState).toBe('pending');
    });

    it('leaves rejected and revoked approvals unchanged (terminal, non-expired)', () => {
      const rejected = decideApproval(
        makePendingApproval(),
        'reject',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      expect(markExpired(rejected, NOW_AFTER_EXPIRY).lifecycleState).toBe('rejected');
      const revoked = revokeApproval(
        decideApproval(makePendingApproval(), 'approve', TRUSTED_PROVENANCE, DECIDED_AT, null)
      );
      expect(markExpired(revoked, NOW_AFTER_EXPIRY).lifecycleState).toBe('revoked');
    });

    it('keeps an already expired approval expired', () => {
      const approval = makePendingApproval({ expiresAt: EXPIRES_AT });
      const expired = markExpired(approval, NOW_AFTER_EXPIRY);
      expect(markExpired(expired, NOW_AFTER_EXPIRY).lifecycleState).toBe('expired');
    });

    it('throws on invalid now timestamp', () => {
      expect(() => markExpired(makePendingApproval({ expiresAt: EXPIRES_AT }), 0)).toThrow(
        ApprovalDomainError
      );
    });
  });

  describe('verifyApprovalForApplication - authorization checks', () => {
    function verify(approval: Approval | null, now: number = NOW_BEFORE_EXPIRY) {
      return verifyApprovalForApplication(approval, {
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        contentHash: VALID_HASH,
        now,
      });
    }

    it('authorizes a valid approved approval', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        EXPIRES_AT
      );
      const result = verify(approved, NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.versionMatches).toBe(true);
      expect(result.contentHashMatches).toBe(true);
      expect(result.statePermitsApplication).toBe(true);
      expect(result.notExpired).toBe(true);
      expect(result.provenanceTrusted).toBe(true);
    });

    it('does not authorize a pending approval', () => {
      const result = verify(makePendingApproval(), NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.statePermitsApplication).toBe(false);
      expect(result.reason).toContain('not in approved state');
    });

    it('does not authorize a rejected approval (rejection is not approval)', () => {
      const rejected = decideApproval(
        makePendingApproval(),
        'reject',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const result = verify(rejected, NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.statePermitsApplication).toBe(false);
      expect(result.reason).toContain('not in approved state');
    });

    it('does not authorize an expired approval', () => {
      const approved = decideApproval(
        makePendingApproval({ expiresAt: EXPIRES_AT }),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        EXPIRES_AT
      );
      const result = verify(approved, NOW_AFTER_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.notExpired).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('does not authorize a revoked approval', () => {
      const revoked = revokeApproval(
        decideApproval(makePendingApproval(), 'approve', TRUSTED_PROVENANCE, DECIDED_AT, null)
      );
      const result = verify(revoked, NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.statePermitsApplication).toBe(false);
    });

    it('does not authorize with no approval record', () => {
      const result = verify(null, NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.approval).toBeNull();
      expect(result.reason).toBe('No approval record found');
    });

    it('rejects a stale proposal version', () => {
      const approved = decideApproval(
        makePendingApproval({ proposalVersion: 1 }),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const result = verify(approved, NOW_BEFORE_EXPIRY);
      // verify against version 2 while approval is bound to version 1
      const staleResult = verifyApprovalForApplication(approved, {
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 2,
        contentHash: VALID_HASH,
        now: NOW_BEFORE_EXPIRY,
      });
      expect(staleResult.authorized).toBe(false);
      expect(staleResult.versionMatches).toBe(false);
      expect(staleResult.reason).toContain('proposal ID or version');
    });

    it('rejects a content hash mismatch', () => {
      const approved = decideApproval(
        makePendingApproval({ approvedContentHash: VALID_HASH }),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const mismatchResult = verifyApprovalForApplication(approved, {
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        contentHash: DIFFERENT_HASH,
        now: NOW_BEFORE_EXPIRY,
      });
      expect(mismatchResult.authorized).toBe(false);
      expect(mismatchResult.contentHashMatches).toBe(false);
      expect(mismatchResult.reason).toContain('content hash');
    });

    it('rejects a mismatched proposal id', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const result = verifyApprovalForApplication(approved, {
        proposalId: '660e8400-e29b-41d4-a716-446655440002',
        proposalVersion: 1,
        contentHash: VALID_HASH,
        now: NOW_BEFORE_EXPIRY,
      });
      expect(result.authorized).toBe(false);
      expect(result.versionMatches).toBe(false);
    });

    it('rejects untrusted provenance approval', () => {
      const modelApproval = createPendingApproval({
        approvalId: VALID_APPROVAL_ID,
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        approvedContentHash: VALID_HASH,
        provenance: MODEL_PROVENANCE,
        expiresAt: null,
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
        createdAt: 1700000000000,
      });
      // Manually place it into an approved-looking state without a trusted
      // decision: verification must still refuse because provenance is untrusted.
      const result = verify(modelApproval, NOW_BEFORE_EXPIRY);
      expect(result.authorized).toBe(false);
      expect(result.provenanceTrusted).toBe(false);
      expect(result.reason).toContain('not trusted');
    });
  });

  describe('createAuthorizationToApply', () => {
    it('derives an authorization for a valid approved approval', () => {
      const approved = decideApproval(
        makePendingApproval(),
        'approve',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      const auth = createAuthorizationToApply(approved, NOW_BEFORE_EXPIRY);
      expect(auth).not.toBeNull();
      if (auth) {
        expect(auth.approvalId).toBe(VALID_APPROVAL_ID);
        expect(auth.proposalId).toBe(VALID_PROPOSAL_ID);
        expect(auth.proposalVersion).toBe(1);
        expect(auth.contentHash).toBe(VALID_HASH);
        expect(auth.authorizedAt).toBe(NOW_BEFORE_EXPIRY);
      }
    });

    it('returns null for an approval that cannot authorize', () => {
      const rejected = decideApproval(
        makePendingApproval(),
        'reject',
        TRUSTED_PROVENANCE,
        DECIDED_AT,
        null
      );
      expect(createAuthorizationToApply(rejected, NOW_BEFORE_EXPIRY)).toBeNull();
    });
  });

  describe('immutability', () => {
    it('does not mutate the original approval across lifecycle operations', () => {
      const original = makePendingApproval();
      const decided = decideApproval(original, 'approve', TRUSTED_PROVENANCE, DECIDED_AT, null);
      const revoked = revokeApproval(decided);
      expect(original.lifecycleState).toBe('pending');
      expect(decided.lifecycleState).toBe('approved');
      expect(revoked.lifecycleState).toBe('revoked');
    });
  });
});
