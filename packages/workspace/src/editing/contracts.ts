/**
 * Phase 10 Stage B — Editing domain contracts.
 *
 * Pure, platform-independent type definitions for edit proposals, operations,
 * approvals, previews, and apply results. No filesystem access, no VS Code
 * imports, no model-facing tools.
 */

export type ProposalStatus =
  | 'pending-validation'
  | 'validated'
  | 'awaiting-approval'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'failed'
  | 'cancelled';

export type EditOperationKind =
  | 'replace-lines'
  | 'insert-lines'
  | 'delete-lines'
  | 'replace-full';

export interface EditOperationReplaceLines {
  readonly kind: 'replace-lines';
  readonly startLine: number;
  readonly endLine: number;
  readonly newContent: string;
}

export interface EditOperationInsertLines {
  readonly kind: 'insert-lines';
  readonly atLine: number;
  readonly newContent: string;
}

export interface EditOperationDeleteLines {
  readonly kind: 'delete-lines';
  readonly startLine: number;
  readonly endLine: number;
}

export interface EditOperationReplaceFull {
  readonly kind: 'replace-full';
  readonly newContent: string;
}

export type EditOperation =
  | EditOperationReplaceLines
  | EditOperationInsertLines
  | EditOperationDeleteLines
  | EditOperationReplaceFull;

export interface EditProposal {
  readonly kind: 'edit-proposal';
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly workspaceId: string;
  readonly workspaceFolderUri: string;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly originalContentHash: string;
  readonly originalSize: number;
  readonly originalMtime: number;
  readonly operations: readonly EditOperation[];
  readonly proposedContentHash: string;
  readonly proposedSize: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ProposalStatus;
}

export interface EditPreview {
  readonly proposalId: string;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly diffSummary: DiffSummary;
  readonly truncated: boolean;
  readonly originalTruncated: boolean;
  readonly proposedTruncated: boolean;
}

export interface DiffSummary {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly linesModified: number;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly proposedStart: number;
  readonly proposedEnd: number;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
}

export interface EditApproval {
  readonly kind: 'edit-approval';
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly approvedContentHash: string;
  readonly approvedAt: number;
  readonly approvedBy: 'user';
  readonly workspaceId: string;
  readonly fileUri: string;
}

export interface ApplyResult {
  readonly kind: 'apply-result';
  readonly proposalId: string;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly outcome: 'applied' | 'failed' | 'cancelled';
  readonly appliedAt: number | null;
  readonly finalContentHash: string | null;
  readonly finalSize: number | null;
  readonly error: { code: string; message: string } | null;
  readonly staleDetected: boolean;
  readonly approvalVerified: boolean;
}

export interface ApplyOperationsResult {
  readonly content: string;
  readonly contentHash: string;
  readonly size: number;
}

export interface StaleFileCheckResult {
  readonly stale: boolean;
  readonly reason:
    | 'hash-mismatch'
    | 'size-mismatch'
    | 'mtime-mismatch'
    | 'file-missing'
    | 'file-recreated'
    | 'concurrent-proposal'
    | null;
  readonly actualHash: string | null;
  readonly actualSize: number | null;
  readonly actualMtime: number | null;
}
