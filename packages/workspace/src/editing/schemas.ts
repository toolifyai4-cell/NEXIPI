import { z } from 'zod';

/**
 * Phase 10 Stage B — Runtime validation schemas for the editing domain.
 *
 * Validates every externally supplied or persisted contract. TypeScript
 * types alone are not trusted as runtime security validation.
 */

export const ProposalStatusSchema = z.enum([
  'pending-validation',
  'validated',
  'awaiting-approval',
  'approved',
  'applied',
  'rejected',
  'expired',
  'failed',
  'cancelled',
]);

export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const EditOperationKindSchema = z.enum([
  'replace-lines',
  'insert-lines',
  'delete-lines',
  'replace-full',
]);

export const EditOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace-lines'),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    newContent: z.string(),
  }),
  z.object({
    kind: z.literal('insert-lines'),
    atLine: z.number().int().positive(),
    newContent: z.string(),
  }),
  z.object({
    kind: z.literal('delete-lines'),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('replace-full'),
    newContent: z.string(),
  }),
]);

export type EditOperation = z.infer<typeof EditOperationSchema>;

export const MAX_EDIT_OPERATIONS = 50;
export const MAX_EDIT_CONTENT_SIZE = 10 * 1024 * 1024; // 10 MB

export const EditProposalSchema = z.object({
  kind: z.literal('edit-proposal'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  workspaceFolderUri: z.string().min(1, 'workspaceFolderUri is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
  relativePath: z.string().min(1, 'relativePath is required'),
  originalContentHash: z.string().regex(
    /^[a-f0-9]{64}$/,
    'originalContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
  ),
  originalSize: z.number().int().nonnegative(),
  originalMtime: z.number().int().nonnegative(),
  operations: z.array(EditOperationSchema).min(1).max(MAX_EDIT_OPERATIONS),
  proposedContentHash: z.string().regex(
    /^[a-f0-9]{64}$/,
    'proposedContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
  ),
  proposedSize: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  status: ProposalStatusSchema,
});

export type EditProposal = z.infer<typeof EditProposalSchema>;

export const DiffHunkSchema = z.object({
  originalStart: z.number().int().nonnegative(),
  originalEnd: z.number().int().nonnegative(),
  proposedStart: z.number().int().nonnegative(),
  proposedEnd: z.number().int().nonnegative(),
  contextBefore: z.array(z.string()),
  contextAfter: z.array(z.string()),
});

export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffSummarySchema = z.object({
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  linesModified: z.number().int().nonnegative(),
});

export type DiffSummary = z.infer<typeof DiffSummarySchema>;

export const EditPreviewSchema = z.object({
  kind: z.literal('edit-preview'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  fileUri: z.string().min(1, 'fileUri is required'),
  relativePath: z.string().min(1, 'relativePath is required'),
  originalContent: z.string(),
  proposedContent: z.string(),
  diffSummary: DiffSummarySchema,
  truncated: z.boolean(),
  originalTruncated: z.boolean(),
  proposedTruncated: z.boolean(),
});

export type EditPreview = z.infer<typeof EditPreviewSchema>;

export const EditApprovalSchema = z.object({
  kind: z.literal('edit-approval'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  approvedContentHash: z.string().regex(
    /^[a-f0-9]{64}$/,
    'approvedContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
  ),
  approvedAt: z.number().int().positive(),
  approvedBy: z.literal('user'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
});

export type EditApproval = z.infer<typeof EditApprovalSchema>;

export const ApplyResultSchema = z.object({
  kind: z.literal('apply-result'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  fileUri: z.string().min(1, 'fileUri is required'),
  relativePath: z.string().min(1, 'relativePath is required'),
  outcome: z.enum(['applied', 'failed', 'cancelled']),
  appliedAt: z.number().int().positive().nullable(),
  finalContentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  finalSize: z.number().int().nonnegative().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
  staleDetected: z.boolean(),
  approvalVerified: z.boolean(),
});

export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export interface ValidateEditProposalInput {
  readonly proposal: unknown;
}

export function validateEditProposal(proposal: unknown): EditProposal {
  return EditProposalSchema.parse(proposal);
}

export function safeValidateEditProposal(
  proposal: unknown
): { success: true; data: EditProposal } | { success: false; error: z.ZodError } {
  const result = EditProposalSchema.safeParse(proposal);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateEditApproval(approval: unknown): EditApproval {
  return EditApprovalSchema.parse(approval);
}

export function safeValidateEditApproval(
  approval: unknown
): { success: true; data: EditApproval } | { success: false; error: z.ZodError } {
  const result = EditApprovalSchema.safeParse(approval);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateApplyResult(result: unknown): ApplyResult {
  return ApplyResultSchema.parse(result);
}

export function safeValidateApplyResult(
  result: unknown
): { success: true; data: ApplyResult } | { success: false; error: z.ZodError } {
  const result2 = ApplyResultSchema.safeParse(result);
  if (result2.success) {
    return { success: true, data: result2.data };
  }
  return { success: false, error: result2.error };
}
