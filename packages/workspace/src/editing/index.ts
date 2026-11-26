/**
 * Phase 10 Stage B — Editing domain public exports.
 */

export { EditDomainError } from './errors.js';

export {
  WritableFileSystemError,
  type WritableFileSystemErrorCode,
  type WritableFileSystemProvider,
  validateWorkspaceBoundary,
  generateTempFileName,
  classifyFilesystemError,
} from './writable-file-system.js';

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

export { sha256, sha256Bytes, isValidSha256Hash } from './hash.js';

export {
  applyOperations,
  splitLinesPreserveEndings,
  type ApplyOperationsResult,
} from './operations.js';

export {
  ApprovalId,
  ProposalVersion,
  ApprovalLifecycleState,
  ApprovalDecision,
  ApprovalProvenance,
  Approval,
  ApprovalDecisionRequest,
  ApprovalVerificationInput,
  ApprovalVerificationResult,
  AuthorizationToApply,
  ApprovalCreationRequest,
  ApprovalCreationResult,
  ApprovalCreationBoundary,
  isTrustedProvenance,
  isTerminalState,
  isApplicationAuthorizedState,
  isPendingState,
  CreatePendingApprovalInput,
  createPendingApproval,
} from './approval-contracts.js';

export { ApprovalDomainError, ApprovalErrorCode, createApprovalError } from './approval-errors.js';

export {
  ApprovalIdSchema,
  ProposalIdSchema,
  ProposalVersionSchema,
  ApprovalLifecycleStateSchema,
  ApprovalDecisionSchema,
  ContentHashSchema,
  TimestampSchema,
  ApprovalProvenanceSchema,
  ApprovalSchema,
  ApprovalDecisionRequestSchema,
  ApprovalVerificationInputSchema,
  AuthorizationToApplySchema,
  CreatePendingApprovalInputSchema,
  validateApproval,
  safeValidateApproval,
  validateApprovalDecisionRequest,
  safeValidateApprovalDecisionRequest,
  validateApprovalVerificationInput,
  safeValidateApprovalVerificationInput,
  validateAuthorizationToApply,
  safeValidateAuthorizationToApply,
  validateCreatePendingApprovalInput,
  safeValidateCreatePendingApprovalInput,
} from './approval-schemas.js';

export {
  applyTransition,
  decideApproval,
  revokeApproval,
  markExpired,
  verifyApprovalForApplication,
  createAuthorizationToApply,
} from './approval-lifecycle.js';

export {
  TrustedApprovalService,
  createTrustedApprovalService,
  defaultNow,
  defaultCreateApprovalId,
  TrustedDecisionProvider,
  TrustedUserDecisionRequest,
  TrustedUserDecision,
  FailingTrustedDecisionProvider,
  ProposalView,
  ProposalRepositoryPort,
  ApprovalRecordView,
  CreateApprovalView,
  ApprovalRepositoryResult,
  ApprovalRepositoryListResult,
  ApprovalRepositoryPort,
  isTrustedBoundaryError,
} from './trusted-approval-service.js';

export {
  computeDiff,
  type DiffEntry,
  type ComputeDiffOptions,
  type ComputeDiffResult,
} from './diff.js';
