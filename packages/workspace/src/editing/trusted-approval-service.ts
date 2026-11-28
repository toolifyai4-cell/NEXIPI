/**
 * Phase 10 Stage E3 — Trusted approval service.
 *
 * Provides the trustworthy boundary between:
 *   1. Model-generated edit proposals,
 *   2. Explicit user approval or rejection,
 *   3. Persisted approval records, and
 *   4. Permission to apply a specific approved proposal.
 *
 * The service is deliberately independent of VS Code and the SQL driver: it
 * depends on repository abstractions (injected ports) and a host-controlled
 * trusted-decision provider (injected). Trusted-user approval can only be
 * established through the injected provider; the service fails closed when the
 * provider is absent or cannot establish a valid user decision.
 *
 * A model-supplied provenance, a caller-supplied `trusted-boundary` string, or
 * a persisted record alone is never sufficient to create a trusted approval.
 */

import {
  type Approval,
  type ApprovalCreationRequest,
  type ApprovalCreationResult,
  type ApprovalCreationBoundary,
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalProvenance,
  type ApprovalVerificationResult,
  type AuthorizationToApply,
  isTrustedProvenance,
} from './approval-contracts.js';
import { ApprovalDomainError, ApprovalErrorCode, createApprovalError } from './approval-errors.js';
import { ApprovalDecisionRequestSchema, validateApproval } from './approval-schemas.js';
import { verifyApprovalForApplication, createAuthorizationToApply } from './approval-lifecycle.js';

/**
 * Statuses in which a proposal may receive an approval decision. Terminal or
 * post-approval statuses are not approvable.
 */
const APPROVABLE_PROPOSAL_STATUSES = new Set([
  'pending-validation',
  'validated',
  'awaiting-approval',
]);

/**
 * View of a persisted proposal sufficient for approval binding checks and
 * eventual authorized application. Kept narrow so the workspace domain stays
 * decoupled from the persistence package and the SQL driver.
 */
export interface ProposalView {
  readonly id: string;
  readonly proposalVersion: number;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly relativePath: string;
  /**
   * Hash of the file content as it existed when the proposal was created
   * (SHA-256 over UTF-8 bytes, same semantics as {@link sha256}). Used by the
   * edit-authorization boundary to detect stale files at apply time.
   */
  readonly originalContentHash: string;
  readonly proposedContentHash: string;
  readonly proposedContent: string;
  readonly status: string;
}

export interface ProposalRepositoryPort {
  getProposal(
    proposalId: string,
    proposalVersion: number
  ): Promise<{ proposal: ProposalView | null; error: Error | null }>;
}

/**
 * View of a persisted approval record. Mirrors the persistence approval record
 * without importing the persistence package.
 */
export interface ApprovalRecordView {
  readonly id: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: ApprovalDecision | null;
  readonly approvedContentHash: string;
  readonly decidedAt: number | null;
  readonly provenance: ApprovalProvenance;
  readonly lifecycleState: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: number;
}

export interface CreateApprovalView {
  readonly id: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: ApprovalDecision | null;
  readonly approvedContentHash: string;
  readonly decidedAt: number | null;
  readonly provenance: ApprovalProvenance;
  readonly lifecycleState: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: number;
}

export type ApprovalRepositoryResult = {
  approval: ApprovalRecordView | null;
  error: Error | null;
};

export type ApprovalRepositoryListResult = {
  approvals: ApprovalRecordView[];
  error: Error | null;
};

export interface ApprovalRepositoryPort {
  createApproval(input: CreateApprovalView): Promise<ApprovalRepositoryResult>;
  getApproval(approvalId: string): Promise<ApprovalRepositoryResult>;
  getApprovalForVersion(
    proposalId: string,
    proposalVersion: number
  ): Promise<ApprovalRepositoryResult>;
  getApprovalsByProposal(
    proposalId: string,
    proposalVersion?: number
  ): Promise<ApprovalRepositoryListResult>;
  recordRevocation(approvalId: string): Promise<ApprovalRepositoryResult>;
  recordExpiration(approvalId: string): Promise<ApprovalRepositoryResult>;
}

/**
 * Details of a terminal command presented for user approval.
 *
 * Environment configuration is referenced by identity only; secret values
 * are never included in the approval request.
 */
export interface TerminalCommandApprovalDetails {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environmentConfigId?: string | undefined;
}

/**
 * A request to establish a trusted user decision. The provider is
 * host-controlled (for example a VS Code dialog wired in Stage F). It is the
 * sole authority on whether a real user made a decision.
 */
export interface TrustedUserDecisionRequest {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: ApprovalDecision;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly expiresAt: number | null;
  /**
   * Optional terminal command details (Stage E). When present, the decision
   * provider should present the terminal command to the user for review
   * instead of an edit proposal. These fields are display-only and are not
   * used to authorize execution.
   */
  readonly terminalCommand?: TerminalCommandApprovalDetails | undefined;
}

/**
 * The outcome of a trusted user decision. Trust-relevant fields (decision,
 * boundary, decidedAt, expiresAt) come from the provider, never from the
 * caller, so a caller cannot forge the user's decision or provenance.
 */
export interface TrustedUserDecision {
  readonly decision: ApprovalDecision;
  readonly boundary: string;
  readonly decidedAt: number;
  readonly expiresAt: number | null;
}

/**
 * Host-controlled trusted-user decision boundary. Stage E3 provides the
 * interface and a fail-closed default; Stage F connects the real VS Code UI.
 */
export interface TrustedDecisionProvider {
  /**
   * Establish or confirm a trusted user decision for a proposal edit.
   *
   * @returns the confirmed user decision, or `null` when no decision was
   *          established (user cancelled, timed out, or the provider is
   *          unavailable). The service fails closed on `null`.
   */
  establishUserDecision(request: TrustedUserDecisionRequest): Promise<TrustedUserDecision | null>;
}

/**
 * Default trusted-decision provider that fails closed. No trusted decision
 * can be established without a real provider, so any attempt to create a
 * trusted approval is rejected.
 */
export class FailingTrustedDecisionProvider implements TrustedDecisionProvider {
  async establishUserDecision(): Promise<null> {
    await Promise.resolve();
    return null;
  }
}

export interface TrustedApprovalServiceDependencies {
  proposals: ProposalRepositoryPort;
  approvals: ApprovalRepositoryPort;
  trustedDecisionProvider: TrustedDecisionProvider;
  now: () => number;
  createApprovalId: () => ApprovalId;
}

export const defaultNow = (): number => Date.now();

export const defaultCreateApprovalId = (): ApprovalId => crypto.randomUUID();

/**
 * Trusted approval service.
 *
 * Implements the {@link ApprovalCreationBoundary} seam and exposes approval
 * verification, lifecycle, and retrieval operations consumed by E4 through the
 * {@link EditAuthorizationBoundary} seam. Retrieval alone never grants
 * permission; authorization requires a verified, trusted, non-expired,
 * non-revoked approval bound to the exact proposal ID, version, and content
 * hash.
 */
export class TrustedApprovalService implements ApprovalCreationBoundary {
  private readonly proposals: ProposalRepositoryPort;
  private readonly approvals: ApprovalRepositoryPort;
  private readonly trustedDecisionProvider: TrustedDecisionProvider;
  private readonly now: () => number;
  private readonly createApprovalId: () => ApprovalId;

  constructor(deps: TrustedApprovalServiceDependencies) {
    this.proposals = deps.proposals;
    this.approvals = deps.approvals;
    this.trustedDecisionProvider = deps.trustedDecisionProvider;
    this.now = deps.now;
    this.createApprovalId = deps.createApprovalId;
  }

  /**
   * Stage D/E1 seam: create an approval decision.
   *
   * Creates an approval record only after a trusted user decision has been
   * established through the injected provider. Fails closed on any missing,
   * stale, mismatched, or untrusted input.
   */
  async createApprovalDecision(
    request: ApprovalCreationRequest,
    signal?: AbortSignal
  ): Promise<ApprovalCreationResult> {
    // 1. Validate the caller's request shape (Zod, runtime enforcement).
    //    ApprovalCreationRequest carries no approvalId (the service generates
    //    one), so validate against the decision schema with approvalId omitted.
    const validated = ApprovalDecisionRequestSchema.omit({
      approvalId: true,
    }).safeParse(request);
    if (!validated.success) {
      throw createApprovalError(
        ApprovalErrorCode.INVALID_ID,
        `Invalid approval decision request: ${validated.error.issues
          .map(issue => issue.message)
          .join(', ')}`
      );
    }

    // 2. Load the referenced proposal version. The repository enforces exact
    //    proposal ID + version binding via its composite foreign key.
    const proposalResult = await this.proposals.getProposal(
      request.proposalId,
      request.proposalVersion
    );
    if (proposalResult.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Unable to read proposal: ${proposalResult.error.message}`
      );
    }
    const proposal = proposalResult.proposal;
    if (proposal === null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Proposal not found: ${request.proposalId}/${request.proposalVersion}`
      );
    }

    // 3. Verify workspace identity.
    if (proposal.workspaceId !== request.workspaceId) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        'Workspace identity mismatch: approval workspace does not match proposal workspace'
      );
    }

    // 4. Verify file identity.
    if (proposal.fileUri !== request.fileUri) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        'File identity mismatch: approval file URI does not match proposal file URI'
      );
    }

    // 5. Verify the approved content hash matches the persisted proposal hash.
    if (proposal.proposedContentHash !== request.approvedContentHash) {
      throw createApprovalError(
        ApprovalErrorCode.CONTENT_HASH_MISMATCH,
        `Approved content hash does not match the persisted proposal content hash for ${request.proposalId}/${request.proposalVersion}`
      );
    }

    // 6. Verify the proposal is eligible for application (approvable status).
    if (!APPROVABLE_PROPOSAL_STATUSES.has(proposal.status)) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Proposal is not in an approvable state (${proposal.status})`
      );
    }

    // 7. Provenance must be trusted-boundary. Model-tool-input,
    //    proposal-creation, and untrusted provenance are rejected outright.
    if (!isTrustedProvenance(request.provenance)) {
      throw createApprovalError(
        ApprovalErrorCode.INVALID_PROVENANCE,
        'Only a trusted user decision can create a trusted approval; model-tool-input, proposal-creation, and untrusted provenance are not trusted proof of user approval'
      );
    }

    // 8. Expiry gate before opening the native dialog. A proposal that has
    //    already expired must not receive a trusted decision; fail closed
    //    without showing the dialog.
    const now = this.now();
    if (request.expiresAt !== null && now > request.expiresAt) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Proposal has expired and cannot be approved: ${request.proposalId}/${request.proposalVersion}`
      );
    }

    // 9. Cancellation gate before opening the native dialog. If the requesting
    //    controller was disposed while waiting, fail closed without showing
    //    the dialog.
    if (signal?.aborted) {
      throw createApprovalError(
        ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED,
        'Approval request was cancelled before a user decision could be established'
      );
    }

    // 10. Trusted-user boundary: the decision must be established by the
    //     host-controlled provider. Fail closed when the provider is absent or
    //     cannot establish a valid user decision.
    if (!this.trustedDecisionProvider) {
      throw createApprovalError(
        ApprovalErrorCode.TRUSTED_BOUNDARY_UNAVAILABLE,
        'Trusted decision provider is unavailable; approval cannot be created without a verified user decision'
      );
    }

    const confirmed = await this.trustedDecisionProvider.establishUserDecision({
      proposalId: request.proposalId,
      proposalVersion: request.proposalVersion,
      decision: request.decision,
      workspaceId: request.workspaceId,
      fileUri: request.fileUri,
      expiresAt: request.expiresAt,
    });

    if (confirmed === null) {
      throw createApprovalError(
        ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED,
        'No trusted user decision was established; approval denied'
      );
    }

    // 11. Expiry gate after the dialog resolves. The proposal may have expired
    //     while the user was considering the dialog; fail closed before
    //     persisting any decision.
    const decidedNow = this.now();
    if (request.expiresAt !== null && decidedNow > request.expiresAt) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Proposal expired before the trusted decision was persisted: ${request.proposalId}/${request.proposalVersion}`
      );
    }

    // 12. Cancellation gate after the dialog resolves. If the requesting
    //     controller was disposed while the dialog was open, fail closed
    //     before persisting any decision.
    if (signal?.aborted) {
      throw createApprovalError(
        ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED,
        'Approval request was cancelled before the trusted decision could be persisted'
      );
    }

    // 13. Build the approval record. Trust-relevant fields (decision, boundary,
    //     decidedAt, expiresAt) come from the confirmed provider decision, not
    //     the caller, so a caller cannot forge the user's decision or provenance.
    const createdAt = this.now();
    const approvalId = this.createApprovalId();
    const decision = confirmed.decision;
    const lifecycleState = decision === 'approve' ? 'approved' : 'rejected';

    const approval: Approval = {
      kind: 'edit-approval',
      approvalId,
      proposalId: request.proposalId,
      proposalVersion: request.proposalVersion,
      decision,
      approvedContentHash: request.approvedContentHash,
      decidedAt: confirmed.decidedAt ?? createdAt,
      provenance: { kind: 'trusted-boundary', boundary: confirmed.boundary },
      lifecycleState,
      expiresAt: confirmed.expiresAt ?? null,
      workspaceId: request.workspaceId,
      fileUri: request.fileUri,
      createdAt,
    };

    validateApproval(approval);

    // 14. Persist through the repository abstraction. A duplicate approvalId
    //     fails deterministically (primary-key violation); no partial record is
    //     left on failure because each decision is its own row.
    const createResult = await this.approvals.createApproval({
      id: approvalId,
      proposalId: approval.proposalId,
      proposalVersion: approval.proposalVersion,
      decision: approval.decision,
      approvedContentHash: approval.approvedContentHash,
      decidedAt: approval.decidedAt,
      provenance: approval.provenance,
      lifecycleState: approval.lifecycleState,
      expiresAt: approval.expiresAt,
      workspaceId: approval.workspaceId,
      fileUri: approval.fileUri,
      createdAt: approval.createdAt,
    });

    if (createResult.error !== null || createResult.approval === null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to persist approval decision: ${createResult.error?.message ?? 'unknown error'}`
      );
    }

    return { approvalId, approval };
  }

  /**
   * Verifies whether an approval authorizes applying a proposal version.
   *
   * The persisted proposal's content hash is used (never a caller-supplied
   * hash), so the caller cannot forge a hash match. Retrieval alone does not
   * grant permission; the returned result reflects every authorization check.
   */
  async verifyApplicationAuthorization(
    proposalId: string,
    proposalVersion: number,
    now?: number
  ): Promise<ApprovalVerificationResult> {
    const evaluationNow = now ?? this.now();

    const proposalResult = await this.proposals.getProposal(proposalId, proposalVersion);
    if (proposalResult.error !== null || proposalResult.proposal === null) {
      return this.failedVerification('Proposal not found');
    }

    const approvalResult = await this.approvals.getApprovalForVersion(proposalId, proposalVersion);
    if (approvalResult.error !== null) {
      return this.failedVerification('Authorization store lookup failed');
    }

    return verifyApprovalForApplication(
      approvalResult.approval === null ? null : this.toDomainApproval(approvalResult.approval),
      {
        proposalId,
        proposalVersion,
        contentHash: proposalResult.proposal.proposedContentHash,
        now: evaluationNow,
      }
    );
  }

  /**
   * Derives an {@link AuthorizationToApply} from an approval when it is
   * currently valid for application of its bound proposal version and content
   * hash. Returns `null` when the approval cannot authorize application.
   */
  async createAuthorizationToApply(
    approvalId: string,
    now?: number
  ): Promise<AuthorizationToApply | null> {
    const evaluationNow = now ?? this.now();
    const result = await this.approvals.getApproval(approvalId);
    if (result.error !== null || result.approval === null) {
      return null;
    }
    return createAuthorizationToApply(this.toDomainApproval(result.approval), evaluationNow);
  }

  /**
   * Maps a persisted approval record view to the domain Approval contract,
   * supplying the `kind` and renaming `id` to `approvalId`.
   */
  private toDomainApproval(record: ApprovalRecordView): Approval {
    return {
      kind: 'edit-approval',
      approvalId: record.id,
      proposalId: record.proposalId,
      proposalVersion: record.proposalVersion,
      decision: record.decision,
      approvedContentHash: record.approvedContentHash,
      decidedAt: record.decidedAt,
      provenance: record.provenance,
      lifecycleState: record.lifecycleState,
      expiresAt: record.expiresAt,
      workspaceId: record.workspaceId,
      fileUri: record.fileUri,
      createdAt: record.createdAt,
    };
  }

  /**
   * Revokes an approved approval. Only an approval in the `approved` state can
   * be revoked; the result is the terminal `revoked` state.
   */
  async revokeApproval(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.approvals.recordRevocation(approvalId);
    if (result.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to revoke approval: ${result.error.message}`
      );
    }
    return result;
  }

  /**
   * Records expiration for an approval when its `expiresAt` has passed. Only
   * `pending` or `approved` approvals can expire.
   */
  async recordExpiration(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.approvals.recordExpiration(approvalId);
    if (result.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to record expiration: ${result.error.message}`
      );
    }
    return result;
  }

  /**
   * Retrieves an approval record by ID. Retrieval alone does not grant
   * permission; use {@link verifyApplicationAuthorization} for authorization.
   */
  async getApproval(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.approvals.getApproval(approvalId);
    if (result.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to read approval: ${result.error.message}`
      );
    }
    return result;
  }

  /**
   * Retrieves the latest approval record for a proposal version. Retrieval
   * alone does not grant permission.
   */
  async getApprovalForVersion(
    proposalId: string,
    proposalVersion: number
  ): Promise<ApprovalRepositoryResult> {
    const result = await this.approvals.getApprovalForVersion(proposalId, proposalVersion);
    if (result.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to read approval: ${result.error.message}`
      );
    }
    return result;
  }

  /**
   * Lists approval records for a proposal (optionally a version). Retrieval
   * alone does not grant permission.
   */
  async getApprovalsByProposal(
    proposalId: string,
    proposalVersion?: number
  ): Promise<ApprovalRepositoryListResult> {
    const result = await this.approvals.getApprovalsByProposal(proposalId, proposalVersion);
    if (result.error !== null) {
      throw createApprovalError(
        ApprovalErrorCode.NOT_AUTHORIZED,
        `Failed to list approvals: ${result.error.message}`
      );
    }
    return result;
  }

  private failedVerification(reason: string): ApprovalVerificationResult {
    return {
      authorized: false,
      approval: null,
      reason,
      versionMatches: false,
      contentHashMatches: false,
      statePermitsApplication: false,
      notExpired: false,
      provenanceTrusted: false,
    };
  }
}

/**
 * Convenience factory for {@link TrustedApprovalService} with default clock
 * and ID generators. The trusted-decision provider and repositories are still
 * injected so the boundary remains testable with controlled doubles.
 */
export function createTrustedApprovalService(
  deps: Omit<TrustedApprovalServiceDependencies, 'now' | 'createApprovalId'> & {
    now?: () => number;
    createApprovalId?: () => ApprovalId;
  }
): TrustedApprovalService {
  return new TrustedApprovalService({
    proposals: deps.proposals,
    approvals: deps.approvals,
    trustedDecisionProvider: deps.trustedDecisionProvider,
    now: deps.now ?? defaultNow,
    createApprovalId: deps.createApprovalId ?? defaultCreateApprovalId,
  });
}

/**
 * Type guard narrowing an `ApprovalDomainError` for trusted-boundary failures.
 */
export function isTrustedBoundaryError(error: unknown): error is ApprovalDomainError {
  return (
    error instanceof ApprovalDomainError &&
    (error.code === ApprovalErrorCode.TRUSTED_BOUNDARY_UNAVAILABLE ||
      error.code === ApprovalErrorCode.TRUSTED_DECISION_NOT_ESTABLISHED)
  );
}
