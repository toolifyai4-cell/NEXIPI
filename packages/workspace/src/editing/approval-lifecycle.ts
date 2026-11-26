/**
 * Phase 10 Stage E1 — Approval lifecycle state machine.
 *
 * Pure, deterministic lifecycle logic for edit approvals. No filesystem
 * access, no VS Code imports, no model-facing tools, no I/O of any kind.
 *
 * Lifecycle states:
 *   pending   - created, awaiting a trusted decision
 *   approved  - trusted user approved; bound to one proposal ID, version and
 *               content hash
 *   rejected  - trusted user rejected; terminal
 *   expired   - approval passed its expiresAt; terminal
 *   revoked   - approval revoked; terminal
 *
 * Valid transitions:
 *   pending -> approved   (trusted approve decision)
 *   pending -> rejected   (trusted reject decision)
 *   pending -> expired    (time-based expiry before a decision)
 *   approved -> revoked   (trusted revocation)
 *   approved -> expired   (time-based expiry after approval)
 *
 * Same-state transitions are idempotent (no-op). Every other cross-state
 * transition is forbidden and throws, which guarantees rejection/expiration/
 * revocation can never be interpreted as approval.
 */

import type {
  Approval,
  ApprovalDecision,
  ApprovalLifecycleState,
  ApprovalProvenance,
  ApprovalVerificationInput,
  ApprovalVerificationResult,
  AuthorizationToApply,
} from './approval-contracts.js';
import { isApplicationAuthorizedState, isTrustedProvenance } from './approval-contracts.js';
import { ApprovalErrorCode, createApprovalError } from './approval-errors.js';

const VALID_TRANSITIONS: Record<ApprovalLifecycleState, readonly ApprovalLifecycleState[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['revoked', 'expired'],
  rejected: [],
  expired: [],
  revoked: [],
};

/**
 * Applies a lifecycle state transition. Same-state (duplicate) transitions are
 * idempotent and return the current state without error. Any other transition
 * not in the valid set is forbidden and throws ApprovalDomainError.
 *
 * @throws ApprovalDomainError with code APPROVAL_INVALID_TRANSITION for
 *         forbidden or conflicting transitions.
 */
export function applyTransition(
  currentState: ApprovalLifecycleState,
  nextState: ApprovalLifecycleState
): ApprovalLifecycleState {
  if (currentState === nextState) {
    return currentState;
  }
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed || !allowed.includes(nextState)) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_TRANSITION,
      `Invalid approval lifecycle transition from '${currentState}' to '${nextState}'`
    );
  }
  return nextState;
}

/**
 * Decides a pending approval. Only a trusted application boundary provenance
 * is accepted; model-tool-input or proposal-creation provenance is rejected
 * outright, enforcing that model-generated actions cannot create a trusted
 * approval. The bound content hash is preserved from the pending approval.
 *
 * @throws ApprovalDomainError when the approval is not pending, when the
 *         provenance is not trusted, or when the timestamp is invalid.
 */
export function decideApproval(
  approval: Approval,
  decision: ApprovalDecision,
  provenance: ApprovalProvenance,
  decidedAt: number,
  expiresAt: number | null
): Approval {
  if (approval.lifecycleState !== 'pending') {
    throw createApprovalError(
      ApprovalErrorCode.NOT_PENDING,
      `Only a pending approval can be decided; current state is '${approval.lifecycleState}'`
    );
  }
  if (!isTrustedProvenance(provenance)) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_PROVENANCE,
      'Only a trusted application boundary can create an approval decision; model-supplied or proposal-creation provenance is not trusted proof of user approval'
    );
  }
  if (!Number.isFinite(decidedAt) || decidedAt <= 0) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_TIMESTAMP,
      `decidedAt must be a positive millisecond timestamp, received ${decidedAt}`
    );
  }
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < 0)) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_TIMESTAMP,
      `expiresAt must be a non-negative millisecond timestamp or null, received ${expiresAt}`
    );
  }

  const nextState = decision === 'approve' ? 'approved' : 'rejected';
  applyTransition(approval.lifecycleState, nextState);

  return {
    ...approval,
    decision,
    approvedContentHash: approval.approvedContentHash,
    decidedAt,
    provenance,
    lifecycleState: nextState,
    expiresAt,
  };
}

/**
 * Revokes an approved approval. Only an approval in the `approved` state can be
 * revoked; the result is the terminal `revoked` state, which prevents any
 * subsequent authorization.
 *
 * @throws ApprovalDomainError when the transition is invalid (e.g. revoking a
 *         pending, rejected, or already-revoked approval).
 */
export function revokeApproval(approval: Approval): Approval {
  applyTransition(approval.lifecycleState, 'revoked');
  return { ...approval, lifecycleState: 'revoked' };
}

/**
 * Marks an approval expired when its `expiresAt` has passed. Only `pending` or
 * `approved` approvals can expire; terminal rejected/revoked approvals are left
 * unchanged. Returns the approval unchanged when it has no expiry, is already
 * expired, is terminal non-expired, or has not yet expired.
 */
export function markExpired(approval: Approval, now: number): Approval {
  if (!Number.isFinite(now) || now <= 0) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_TIMESTAMP,
      `now must be a positive millisecond timestamp, received ${now}`
    );
  }
  if (approval.expiresAt === null) {
    return approval;
  }
  if (approval.lifecycleState === 'expired') {
    return approval;
  }
  if (approval.lifecycleState === 'rejected' || approval.lifecycleState === 'revoked') {
    return approval;
  }
  if (now > approval.expiresAt) {
    applyTransition(approval.lifecycleState, 'expired');
    return { ...approval, lifecycleState: 'expired' };
  }
  return approval;
}

/**
 * Verifies whether an approval authorizes applying a particular proposal
 * version and content hash at a given point in time. This is the authorization
 * boundary decision: authorization is granted only when every check passes.
 *
 * Rejection, expiration and revocation never authorize application, and
 * untrusted provenance never authorizes application.
 */
export function verifyApprovalForApplication(
  approval: Approval | null,
  input: ApprovalVerificationInput
): ApprovalVerificationResult {
  const { proposalId, proposalVersion, contentHash, now } = input;
  if (!Number.isFinite(now) || now <= 0) {
    throw createApprovalError(
      ApprovalErrorCode.INVALID_TIMESTAMP,
      `now must be a positive millisecond timestamp, received ${now}`
    );
  }

  if (approval === null) {
    return {
      authorized: false,
      approval: null,
      reason: 'No approval record found',
      versionMatches: false,
      contentHashMatches: false,
      statePermitsApplication: false,
      notExpired: false,
      provenanceTrusted: false,
    };
  }

  const versionMatches =
    approval.proposalId === proposalId && approval.proposalVersion === proposalVersion;
  const contentHashMatches = approval.approvedContentHash === contentHash;
  const statePermitsApplication = isApplicationAuthorizedState(approval.lifecycleState);
  const notExpired = approval.expiresAt === null || now <= approval.expiresAt;
  const provenanceTrusted = isTrustedProvenance(approval.provenance);

  const authorized =
    versionMatches &&
    contentHashMatches &&
    statePermitsApplication &&
    notExpired &&
    provenanceTrusted;

  let reason: string | null = null;
  if (!authorized) {
    const reasons: string[] = [];
    if (!versionMatches) {
      reasons.push('proposal ID or version does not match the approval');
    }
    if (!contentHashMatches) {
      reasons.push('content hash does not match the approved content');
    }
    if (!statePermitsApplication) {
      reasons.push(`approval is not in approved state (${approval.lifecycleState})`);
    }
    if (!notExpired) {
      reasons.push('approval has expired');
    }
    if (!provenanceTrusted) {
      reasons.push('approval provenance is not trusted');
    }
    reason = reasons.join('; ');
  }

  return {
    authorized,
    approval,
    reason,
    versionMatches,
    contentHashMatches,
    statePermitsApplication,
    notExpired,
    provenanceTrusted,
  };
}

/**
 * Derives an `AuthorizationToApply` from an approval when the approval is
 * currently valid for application of its own bound proposal version and content
 * hash. Returns null when the approval cannot authorize application.
 */
export function createAuthorizationToApply(
  approval: Approval,
  now: number
): AuthorizationToApply | null {
  const verification = verifyApprovalForApplication(approval, {
    proposalId: approval.proposalId,
    proposalVersion: approval.proposalVersion,
    contentHash: approval.approvedContentHash,
    now,
  });
  if (!verification.authorized) {
    return null;
  }
  return {
    approvalId: approval.approvalId,
    proposalId: approval.proposalId,
    proposalVersion: approval.proposalVersion,
    contentHash: approval.approvedContentHash,
    authorizedAt: now,
  };
}
