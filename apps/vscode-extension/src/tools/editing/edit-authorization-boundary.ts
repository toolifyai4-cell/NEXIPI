/**
 * Phase 10 Stage E4 — Edit authorization boundary.
 *
 * {@link EditAuthorizationBoundary} implementation backed by the trusted
 * approval service and the persisted proposal store. It is the trust boundary:
 * the model supplies only proposalId and proposalVersion, and every
 * authorization decision is derived from persisted, trusted state (the exact
 * proposal version, content hash, approval decision, lifecycle state,
 * provenance, expiration and revocation).
 *
 * One boundary instance is bound to a single workspace identity. A proposal
 * authorizes application only when it belongs to that workspace, which is what
 * enforces multi-root isolation: an approval from workspace A cannot authorize
 * a proposal in workspace B, and a disposed workspace cannot keep authorizing
 * (its boundary instance is removed from the extension's registry).
 */

import type {
  EditAuthorizationBoundary,
  EditAuthorizationRequest,
  EditAuthorizationResult,
  ProposalRepositoryPort,
} from '@nexipi/workspace';
import {
  TrustedApprovalService,
  defaultNow,
  type Approval,
} from '@nexipi/workspace';

/**
 * Trusted edit authorization boundary bound to a single workspace.
 */
export class TrustedEditAuthorizationBoundary implements EditAuthorizationBoundary {
  private readonly service: TrustedApprovalService;
  private readonly proposals: ProposalRepositoryPort;
  private readonly workspaceId: string;
  private readonly now: () => number;

  constructor(deps: {
    trustedApprovalService: TrustedApprovalService;
    proposalRepository: ProposalRepositoryPort;
    workspaceId: string;
    now?: () => number;
  }) {
    this.service = deps.trustedApprovalService;
    this.proposals = deps.proposalRepository;
    this.workspaceId = deps.workspaceId;
    this.now = deps.now ?? defaultNow;
  }

  async verifyAndAuthorizeApplication(
    request: EditAuthorizationRequest
  ): Promise<EditAuthorizationResult> {
    const { proposalId, proposalVersion } = request;
    const now = this.now();

    // Load the exact persisted proposal. The model cannot supply the proposal
    // content, file identity, or workspace -- these come from persisted state.
    const proposalResult = await this.proposals.getProposal(proposalId, proposalVersion);
    if (proposalResult.error !== null) {
      return {
        authorized: false,
        reason: `Unable to read proposal: ${proposalResult.error.message}`,
      };
    }
    const proposal = proposalResult.proposal;
    if (proposal === null) {
      return { authorized: false, reason: 'Proposal not found' };
    }

    // Workspace identity is trusted persisted state, not model input. A
    // proposal bound to a different workspace is denied here, which is what
    // keeps approvals from workspace A from authorizing workspace B.
    if (proposal.workspaceId !== this.workspaceId) {
      return {
        authorized: false,
        reason: 'Workspace identity mismatch: proposal does not belong to this workspace',
      };
    }

    // Verify the exact approved content hash, the approval decision and
    // lifecycle state, trusted provenance, expiration and revocation through
    // the service's established trust mechanism. All checks run against the
    // persisted proposal version and content.
    const verification = await this.service.verifyApplicationAuthorization(
      proposalId,
      proposalVersion,
      now
    );
    if (!verification.authorized) {
      return {
        authorized: false,
        approval: verification.approval ?? undefined,
        reason: verification.reason ?? 'Edit application is not authorized',
      };
    }

    const approval = verification.approval as Approval;

    // Authorization established. Produce an AuthorizationToApply and the exact
    // file identity and content to apply, all derived from persisted state.
    return {
      authorized: true,
      approval,
      authorizationToApply: {
        approvalId: approval.approvalId,
        proposalId: approval.proposalId,
        proposalVersion: approval.proposalVersion,
        contentHash: approval.approvedContentHash,
        authorizedAt: now,
      },
      apply: {
        fileUri: proposal.fileUri,
        relativePath: proposal.relativePath,
        proposedContent: proposal.proposedContent,
        proposedContentHash: proposal.proposedContentHash,
      },
    };
  }
}
