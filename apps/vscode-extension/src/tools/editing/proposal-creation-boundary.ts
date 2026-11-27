/**
 * Phase 10 Stage F — Proposal creation repository adapter.
 *
 * Adapts {@link SqlJsProposalRepository} to the {@link ProposalCreationBoundary}
 * seam consumed by {@link createProposeEditToolDefinition}. Every identity,
 * timestamp, version, and lifecycle value is derived here by trusted application
 * code; the model supplies only the target file URI and edit operations.
 *
 * Stage D's {@link ProposalCreationRequest} carries the edit operations and the
 * original content hash but not the complete proposed content. Because
 * {@link apply_edit} must write exactly the stored proposed content, this
 * adapter re-reads the target file and re-applies the operations here (in trusted
 * application code) to obtain and persist the complete proposed content. This is
 * the proposal-creation seam Stage E was designed to fill.
 *
 * A newly created proposal is persisted with status `awaiting-approval` and a
 * bounded expiry. It is NOT approved: a separate trusted user decision
 * (established through {@link TrustedDecisionProvider}) is required before the
 * proposal can be applied.
 *
 * Reuses the extension's existing sql.js database instance and read-only
 * filesystem provider; no second database is created.
 */

import type { FileSystemProvider } from '@nexipi/workspace';
import type {
  ProposalCreationBoundary,
  ProposalCreationRequest,
  ProposalCreationResult,
} from '@nexipi/workspace/tools';
import { SqlJsProposalRepository } from '@nexipi/persistence';
import { applyOperations, sha256 } from '@nexipi/workspace';
import { randomUUID } from 'node:crypto';

// Time-to-live for a newly created proposal awaiting approval. After this
// elapses the proposal can no longer be approved or applied.
const DEFAULT_PROPOSAL_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ProposalCreationRepositoryAdapterDependencies {
  /** Reuse the extension's existing proposal repository (same sql.js database). */
  repository: SqlJsProposalRepository;
  /** Read-only filesystem provider used to obtain the complete proposed content. */
  fileSystem: FileSystemProvider;
  proposalTtlMs?: number;
}

/**
 * Creates persisted edit proposals awaiting trusted user approval.
 */
export class ProposalCreationRepositoryAdapter implements ProposalCreationBoundary {
  private readonly repository: SqlJsProposalRepository;
  private readonly fileSystem: FileSystemProvider;
  private readonly proposalTtlMs: number;

  constructor(deps: ProposalCreationRepositoryAdapterDependencies) {
    this.repository = deps.repository;
    this.fileSystem = deps.fileSystem;
    this.proposalTtlMs = deps.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  }

  async createProposal(request: ProposalCreationRequest): Promise<ProposalCreationResult> {
    const now = Date.now();
    const proposalId = randomUUID();
    const proposalVersion = 1;
    const status = 'awaiting-approval';
    const createdAt = now;
    const expiresAt = now + this.proposalTtlMs;

    // Re-read the target file in trusted code to obtain the complete proposed
    // content. Stage D's creation request does not carry proposedContent, but the
    // persistence schema (and apply_edit) require it to be stored.
    let originalContent: string;
    try {
      originalContent = await this.fileSystem.readFile(request.fileUri);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to read target file '${request.fileUri}': ${err.message}`);
    }

    // Re-verify the original content hash against the trusted request value. A
    // mismatch means the file changed between the tool's read and this storage
    // step; fail closed rather than persisting a proposal for stale content.
    const actualHash = sha256(originalContent);
    if (actualHash !== request.originalContentHash) {
      throw new Error(
        `Original content hash mismatch for '${request.fileUri}': file may have changed since proposal creation`
      );
    }

    let proposedContent: string;
    try {
      const result = applyOperations(originalContent, request.operations as never[]);
      proposedContent = result.content;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to compute proposed edit for '${request.fileUri}': ${err.message}`);
    }

    const proposedContentHash = sha256(proposedContent);
    const proposedSize = Buffer.byteLength(proposedContent, 'utf8');

    const result = await this.repository.createProposal({
      id: proposalId,
      proposalVersion,
      workspaceId: request.workspaceId,
      workspaceFolderUri: request.workspaceFolderUri,
      fileUri: request.fileUri,
      relativePath: request.relativePath,
      originalContentHash: request.originalContentHash,
      originalSize: request.originalSize,
      originalMtime: request.originalMtime,
      operations: request.operations,
      proposedContent,
      proposedContentHash,
      proposedSize,
      status,
      createdAt,
      expiresAt,
    });

    if (result.error !== null || result.proposal === null) {
      throw new Error(`Failed to persist proposal: ${result.error?.message ?? 'unknown error'}`);
    }

    return {
      proposalId: result.proposal.id,
      proposalVersion: result.proposal.proposalVersion,
      status: result.proposal.status,
      createdAt: result.proposal.createdAt,
      expiresAt: result.proposal.expiresAt,
    };
  }
}
