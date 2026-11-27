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
} from '@nexipi/workspace/tools';
import type { FileSystemProvider, ProposalRepositoryPort } from '@nexipi/workspace';
import { defaultNow, sha256, type Approval, type TrustedApprovalService } from '@nexipi/workspace';

/**
 * Trusted edit authorization boundary bound to a single workspace.
 */
export class TrustedEditAuthorizationBoundary implements EditAuthorizationBoundary {
  private readonly service: TrustedApprovalService;
  private readonly proposals: ProposalRepositoryPort;
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceId: string;
  private readonly now: () => number;

  constructor(deps: {
    trustedApprovalService: TrustedApprovalService;
    proposalRepository: ProposalRepositoryPort;
    fileSystem: FileSystemProvider;
    workspaceId: string;
    now?: () => number;
  }) {
    this.service = deps.trustedApprovalService;
    this.proposals = deps.proposalRepository;
    this.fileSystem = deps.fileSystem;
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

    // Stale-file protection: confirm the target file is still in the state it
    // was in when the proposal was created. Compare the hash of the current
    // on-disk content (SHA-256 over UTF-8 bytes, identical to the
    // proposal-time hash in propose-edit.ts:479) against the proposal's
    // recorded original content hash. Deny fail-closed when the file has
    // changed, disappeared, or cannot be safely read.
    //
    // This is a check-then-use gate, not an atomic write: between this read
    // and the adapter's write the file could change again, which the VS Code
    // filesystem API cannot prevent. The file is verified as close to the
    // write as possible, and the denial below fails closed rather than
    // overwriting a modified or missing file.
    let currentContent: string;
    try {
      currentContent = await this.fileSystem.readFile(proposal.fileUri);
    } catch (error) {
      if (isAbortError(error)) {
        return { authorized: false, reason: 'Operation cancelled', staleDetected: false };
      }
      return {
        authorized: false,
        staleDetected: true,
        reason: `Unable to read target file before applying: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const currentHash = sha256(currentContent);
    if (currentHash !== proposal.originalContentHash) {
      return {
        authorized: false,
        staleDetected: true,
        reason:
          'Target file has changed since the proposal was created; application denied to avoid overwriting concurrent modifications',
      };
    }

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

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}
