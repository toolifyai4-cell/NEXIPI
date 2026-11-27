/**
 * Phase 10 Stage E4 — Persistence repository adapters.
 *
 * Adapts the E2 sql.js proposal and approval repositories to the structural
 * repository ports expected by {@link TrustedApprovalService} (defined in the
 * workspace package). These adapters live in the extension (the composition
 * root) so that `packages/workspace` stays independent of `@nexipi/persistence`
 * and of sql.js.
 *
 * The extension reuses the existing PersistenceService/database instance: the
 * underlying {@link SqlJsProposalRepository} and {@link SqlJsApprovalRepository}
 * are constructed from the shared raw sql.js database handle exposed by the
 * persistence service. No second database or persistence service is created.
 */

import type {
  ApprovalRepositoryPort,
  ApprovalRecordView,
  ApprovalRepositoryResult,
  ApprovalRepositoryListResult,
  CreateApprovalView,
  ProposalRepositoryPort,
  ProposalView,
} from '@nexipi/workspace';
import type {
  SqlJsApprovalRepository,
  SqlJsProposalRepository,
  ApprovalRecord,
  ProposalRecord,
} from '@nexipi/persistence';

/**
 * Adapts {@link SqlJsProposalRepository} to {@link ProposalRepositoryPort}.
 *
 * Exposes only `getProposal`, which is all the trusted approval service needs
 * from the proposal store. The returned view includes the proposed content and
 * relative path so the edit-authorization boundary can hand the exact content
 * and file identity to the apply adapter.
 */
export class ProposalRepositoryAdapter implements ProposalRepositoryPort {
  constructor(private readonly repository: SqlJsProposalRepository) {}

  async getProposal(
    proposalId: string,
    proposalVersion: number
  ): Promise<{ proposal: ProposalView | null; error: Error | null }> {
    const result = await this.repository.getProposal(proposalId, proposalVersion);
    if (result.error !== null) {
      return { proposal: null, error: result.error };
    }
    if (result.proposal === null) {
      return { proposal: null, error: null };
    }
    return { proposal: toProposalView(result.proposal), error: null };
  }
}

function toProposalView(record: ProposalRecord): ProposalView {
  return {
    id: record.id,
    proposalVersion: record.proposalVersion,
    workspaceId: record.workspaceId,
    fileUri: record.fileUri,
    relativePath: record.relativePath,
    originalContentHash: record.originalContentHash,
    proposedContentHash: record.proposedContentHash,
    proposedContent: record.proposedContent,
    status: record.status,
  };
}

/**
 * Adapts {@link SqlJsApprovalRepository} to {@link ApprovalRepositoryPort}.
 *
 * Provenance is persisted as a JSON string by the sql.js repository and parsed
 * back on read, so the view carries a structured {@link ApprovalProvenance}
 * without the adapter re-interpreting it.
 */
export class ApprovalRepositoryAdapter implements ApprovalRepositoryPort {
  constructor(private readonly repository: SqlJsApprovalRepository) {}

  async createApproval(input: CreateApprovalView): Promise<ApprovalRepositoryResult> {
    const result = await this.repository.createApproval(toCreateApprovalInput(input));
    return toApprovalRepositoryResult(result);
  }

  async getApproval(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.repository.getApproval(approvalId);
    return toApprovalRepositoryResult(result);
  }

  async getApprovalForVersion(
    proposalId: string,
    proposalVersion: number
  ): Promise<ApprovalRepositoryResult> {
    const result = await this.repository.getApprovalForVersion(proposalId, proposalVersion);
    return toApprovalRepositoryResult(result);
  }

  async getApprovalsByProposal(
    proposalId: string,
    proposalVersion?: number
  ): Promise<ApprovalRepositoryListResult> {
    const result = await this.repository.getApprovalsByProposal(proposalId, proposalVersion);
    return {
      approvals: result.approvals.map(toApprovalRecordView),
      error: result.error,
    };
  }

  async recordRevocation(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.repository.recordRevocation(approvalId);
    return toApprovalRepositoryResult(result);
  }

  async recordExpiration(approvalId: string): Promise<ApprovalRepositoryResult> {
    const result = await this.repository.recordExpiration(approvalId);
    return toApprovalRepositoryResult(result);
  }
}

function toCreateApprovalInput(
  input: CreateApprovalView
): Parameters<SqlJsApprovalRepository['createApproval']>[0] {
  return {
    id: input.id,
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    decision: input.decision,
    approvedContentHash: input.approvedContentHash,
    decidedAt: input.decidedAt,
    provenance: input.provenance,
    lifecycleState: input.lifecycleState,
    expiresAt: input.expiresAt,
    workspaceId: input.workspaceId,
    fileUri: input.fileUri,
    createdAt: input.createdAt,
  };
}

function toApprovalRecordView(record: ApprovalRecord): ApprovalRecordView {
  return {
    id: record.id,
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

function toApprovalRepositoryResult(result: {
  approval: ApprovalRecord | null;
  error: Error | null;
}): ApprovalRepositoryResult {
  return {
    approval: result.approval === null ? null : toApprovalRecordView(result.approval),
    error: result.error,
  };
}
