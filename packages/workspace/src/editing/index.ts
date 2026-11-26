/**
 * Phase 10 Stage B — Editing domain public exports.
 */

export {
  EditDomainError,
} from './errors.js';

export {
  ProposalStatus,
  EditOperation,
  EditOperationKind,
  EditOperationReplaceLines,
  EditOperationInsertLines,
  EditOperationDeleteLines,
  EditOperationReplaceFull,
  EditProposal,
  EditPreview,
  DiffSummary,
  DiffHunk,
  EditApproval,
  ApplyResult,
  StaleFileCheckResult,
} from './contracts.js';

export {
  ProposalStatusSchema,
  EditOperationSchema,
  EditOperationKindSchema,
  MAX_EDIT_OPERATIONS,
  MAX_EDIT_CONTENT_SIZE,
  EditProposalSchema,
  EditPreviewSchema,
  DiffHunkSchema,
  DiffSummarySchema,
  EditApprovalSchema,
  ApplyResultSchema,
  ValidateEditProposalInput,
  validateEditProposal,
  safeValidateEditProposal,
  validateEditApproval,
  safeValidateEditApproval,
  validateApplyResult,
  safeValidateApplyResult,
} from './schemas.js';

export {
  sha256,
  sha256Bytes,
  isValidSha256Hash,
} from './hash.js';

export {
  applyOperations,
  splitLinesPreserveEndings,
  type ApplyOperationsResult,
} from './operations.js';

export {
  computeDiff,
  type DiffEntry,
  type ComputeDiffOptions,
  type ComputeDiffResult,
} from './diff.js';
