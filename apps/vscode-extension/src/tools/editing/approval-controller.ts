/**
 * Phase 10 Stage F — Approval controller.
 *
 * Orchestrates the trusted edit approval flow between the webview UI, the
 * host-controlled {@link TrustedDecisionProvider}, and the {@link
 * TrustedApprovalService}.
 *
 * Responsibilities:
 *   - Track pending proposals created by `propose_edit` (keyed by proposal ID,
 *     scoped to the current extension lifecycle).
 *   - Present each pending proposal to the webview for review (`proposalCreated`).
 *   - On a user `approvalAction` (approve / reject / dismiss), establish the
 *     decision through the host-controlled provider (native VS Code dialog),
 *     then record it through the trusted approval service.
 *   - Publish the decision outcome back to the webview (`approvalDecision`).
 *
 * Security:
 *   - The webview's `approvalAction` is only a request; it never establishes
 *     approval by itself. The native provider confirms the user's decision.
 *   - The displayed proposal is looked up from the pending map (populated from
 *     the persisted proposal at creation time), not reconstructed from
 *     model-supplied data.
 *   - Dismiss/cancel establishes no decision (provider returns null -> fail
 *     closed).
 *   - Duplicate or conflicting decisions for an already-terminal approval are
 *     rejected by the persistence lifecycle.
 */

import type {
  ApprovalRepositoryPort,
  ProposalRepositoryPort,
  TrustedApprovalService,
  TrustedDecisionProvider,
  TrustedUserDecision,
} from '@nexipi/workspace';
import type { Logger } from '@nexipi/core';

export interface PendingProposal {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly proposedContentHash: string;
  readonly proposedSize: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly preview: unknown; // bounded EditPreview from the propose_edit output
}

export interface ApprovalActionPayload {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: 'approve' | 'reject' | 'dismiss';
  readonly workspaceId: string;
  readonly fileUri: string;
}

export interface ApprovalDecisionPayload {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: 'approve' | 'reject' | null;
  readonly status: 'pending' | 'approved' | 'rejected' | 'dismissed' | 'failed';
  readonly reason?: string;
}

export interface ProposalCreatedPayload {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly proposedContentHash: string;
  readonly proposedSize: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly preview: unknown;
}

export interface ApprovalControllerDependencies {
  trustedApprovalService: TrustedApprovalService;
  trustedDecisionProvider: TrustedDecisionProvider;
  proposals: ProposalRepositoryPort;
  approvals: ApprovalRepositoryPort;
  postMessage: (message: unknown) => void;
  logger: Logger;
}

/**
 * Coordinates the approval lifecycle for a single extension activation.
 */
export class ApprovalController {
  private readonly service: TrustedApprovalService;
  private readonly provider: TrustedDecisionProvider;
  private readonly proposals: ProposalRepositoryPort;
  private readonly approvals: ApprovalRepositoryPort;
  private readonly postMessage: (message: unknown) => void;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingProposal>();
  private _isDisposed = false;

  constructor(deps: ApprovalControllerDependencies) {
    this.service = deps.trustedApprovalService;
    this.provider = deps.trustedDecisionProvider;
    this.proposals = deps.proposals;
    this.approvals = deps.approvals;
    this.postMessage = deps.postMessage;
    this.logger = deps.logger;
  }

  /** Proposals pending review, keyed by proposal ID. */
  getPendingProposals(): readonly PendingProposal[] {
    if (this._isDisposed) {
      return [];
    }
    return Array.from(this.pending.values());
  }

  isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    this._isDisposed = true;
    this.pending.clear();
  }

  /**
   * Registers a newly created proposal for review. Called by the routed
   * `propose_edit` tool after the proposal is persisted.
   */
  onProposalCreated(proposal: PendingProposal): void {
    if (this._isDisposed) {
      return;
    }
    this.pending.set(proposal.proposalId, proposal);
    void this.postMessage({
      type: 'proposalCreated',
      payload: proposal,
    });
    this.logger.info('Pending proposal presented for review', {
      proposalId: proposal.proposalId,
      proposalVersion: proposal.proposalVersion,
      fileUri: proposal.fileUri,
      workspaceId: proposal.workspaceId,
    });
  }

  /**
   * Clears pending proposals for a disposed workspace so they cannot be acted
   * on after workspace removal.
   */
  clearPendingForWorkspace(workspaceId: string): void {
    for (const [proposalId, proposal] of this.pending.entries()) {
      if (proposal.workspaceId === workspaceId) {
        this.pending.delete(proposalId);
        void this.postMessage({
          type: 'approvalDecision',
          payload: {
            proposalId,
            proposalVersion: proposal.proposalVersion,
            decision: null,
            status: 'dismissed',
            reason: 'Workspace disposed',
          },
        });
      }
    }
  }

  /**
   * Handles a user approval action from the webview. The action is only a
   * request: the real decision is established by the host-controlled provider.
   */
  async handleApprovalAction(action: ApprovalActionPayload): Promise<void> {
    if (this._isDisposed) {
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: action.proposalId,
          proposalVersion: action.proposalVersion,
          decision: null,
          status: 'failed',
          reason: 'Extension is disposing',
        },
      });
      return;
    }

    const pending = this.pending.get(action.proposalId);
    if (!pending) {
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: action.proposalId,
          proposalVersion: action.proposalVersion,
          decision: null,
          status: 'failed',
          reason: 'No pending approval request for this proposal',
        },
      });
      return;
    }

    // Workspace and file identity must match the pending (persisted) proposal.
    if (pending.workspaceId !== action.workspaceId || pending.fileUri !== action.fileUri) {
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: action.proposalId,
          proposalVersion: action.proposalVersion,
          decision: null,
          status: 'failed',
          reason: 'Workspace or file identity mismatch',
        },
      });
      return;
    }

    // A dismissal/cancellation establishes no decision: fail closed without
    // involving the provider. Approve/reject go through the host-controlled
    // provider, which confirms the user's actual choice.
    if (action.decision === 'dismiss') {
      this.pending.delete(action.proposalId);
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: pending.proposalId,
          proposalVersion: pending.proposalVersion,
          decision: null,
          status: 'dismissed',
          reason: 'Dismissed by user',
        },
      });
      return;
    }

    // Establish the trusted user decision through the host-controlled provider.
    // The provider confirms the decision; the webview request alone is never
    // sufficient.
    let confirmed: TrustedUserDecision | null;
    try {
      confirmed = await this.provider.establishUserDecision({
        proposalId: pending.proposalId,
        proposalVersion: pending.proposalVersion,
        decision: action.decision,
        workspaceId: pending.workspaceId,
        fileUri: pending.fileUri,
        expiresAt: pending.expiresAt,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Trusted decision provider failed', {
        proposalId: pending.proposalId,
        error: err.message,
      });
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: pending.proposalId,
          proposalVersion: pending.proposalVersion,
          decision: null,
          status: 'failed',
          reason: 'Approval provider unavailable',
        },
      });
      return;
    }

    if (confirmed === null) {
      // User cancelled / dismissed / timed out. No decision is established.
      // Fail closed: do not approve.
      this.pending.delete(action.proposalId);
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: pending.proposalId,
          proposalVersion: pending.proposalVersion,
          decision: null,
          status: 'dismissed',
          reason: 'No trusted decision established',
        },
      });
      return;
    }

    // Record the decision through the trusted approval service. Trust-relevant
    // fields come from the confirmed provider decision, not the caller.
    try {
      await this.service.createApprovalDecision({
        proposalId: pending.proposalId,
        proposalVersion: pending.proposalVersion,
        decision: confirmed.decision,
        approvedContentHash: pending.proposedContentHash,
        provenance: { kind: 'trusted-boundary', boundary: confirmed.boundary },
        decidedAt: confirmed.decidedAt,
        expiresAt: confirmed.expiresAt,
        workspaceId: pending.workspaceId,
        fileUri: pending.fileUri,
      });

      this.pending.delete(action.proposalId);
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: pending.proposalId,
          proposalVersion: pending.proposalVersion,
          decision: confirmed.decision,
          status: confirmed.decision === 'approve' ? 'approved' : 'rejected',
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to record approval decision', {
        proposalId: pending.proposalId,
        code: (error as { code?: string })?.code,
        error: err.message,
      });
      await this.postMessage({
        type: 'approvalDecision',
        payload: {
          proposalId: pending.proposalId,
          proposalVersion: pending.proposalVersion,
          decision: null,
          status: 'failed',
          reason: 'Failed to record approval decision',
        },
      });
    }
  }
}
