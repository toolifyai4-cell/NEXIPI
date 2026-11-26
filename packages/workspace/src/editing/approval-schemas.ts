import { z } from 'zod';

/**
 * Phase 10 Stage E1 — Runtime validation schemas for the approval domain.
 *
 * Validates every externally supplied or persisted approval contract.
 * TypeScript types alone are not trusted as runtime security validation.
 * Schemas are intentionally restrictive: model-supplied or proposal-creation
 * provenance is never accepted as trusted, and timestamps/hashes/IDs are
 * strictly bounded.
 */

export const ApprovalIdSchema = z.string().uuid('approvalId must be a valid UUID');
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;

export const ProposalIdSchema = z.string().uuid('proposalId must be a valid UUID');
export type ProposalId = z.infer<typeof ProposalIdSchema>;

export const ProposalVersionSchema = z
  .number()
  .int('proposalVersion must be an integer')
  .positive('proposalVersion must be positive')
  .max(999, 'proposalVersion must not exceed 999');
export type ProposalVersion = z.infer<typeof ProposalVersionSchema>;

export const ApprovalLifecycleStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
]);
export type ApprovalLifecycleState = z.infer<typeof ApprovalLifecycleStateSchema>;

export const ApprovalDecisionSchema = z.enum(['approve', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ContentHashSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    'content hash must be a lowercase SHA-256 hex string (64 hex chars)'
  );

export const TimestampSchema = z
  .number()
  .int('timestamp must be an integer')
  .positive('timestamp must be a positive millisecond value');
export type Timestamp = z.infer<typeof TimestampSchema>;

export const ApprovalProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('trusted-boundary'),
    boundary: z.string().min(1, 'trusted boundary identifier is required'),
  }),
  z.object({ kind: z.literal('model-tool-input') }),
  z.object({ kind: z.literal('proposal-creation') }),
  z.object({
    kind: z.literal('untrusted'),
    reason: z.string().min(1, 'untrusted provenance reason is required'),
  }),
]);
export type ApprovalProvenance = z.infer<typeof ApprovalProvenanceSchema>;

export const ApprovalSchema = z
  .object({
    kind: z.literal('edit-approval'),
    approvalId: ApprovalIdSchema,
    proposalId: ProposalIdSchema,
    proposalVersion: ProposalVersionSchema,
    decision: ApprovalDecisionSchema.nullable(),
    approvedContentHash: ContentHashSchema,
    decidedAt: TimestampSchema.nullable(),
    provenance: ApprovalProvenanceSchema,
    lifecycleState: ApprovalLifecycleStateSchema,
    expiresAt: z.number().int().nonnegative().nullable(),
    workspaceId: z.string().min(1, 'workspaceId is required'),
    fileUri: z.string().min(1, 'fileUri is required'),
    createdAt: TimestampSchema,
  })
  .refine(
    data => {
      if (data.lifecycleState === 'pending') {
        return data.decision === null && data.decidedAt === null;
      }
      return data.decision !== null && data.decidedAt !== null;
    },
    'a pending approval must have no decision; a decided approval must have a decision and a timestamp'
  )
  .refine(
    data => {
      if (data.decision === 'reject') {
        return data.lifecycleState === 'rejected';
      }
      return true;
    },
    'a rejection decision must have lifecycle state rejected'
  )
  .refine(
    data => {
      if (data.decision === 'approve') {
        return ['approved', 'expired', 'revoked'].includes(data.lifecycleState);
      }
      return true;
    },
    'an approval decision must have lifecycle state approved, expired, or revoked'
  );
export type Approval = z.infer<typeof ApprovalSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  approvalId: ApprovalIdSchema,
  proposalId: ProposalIdSchema,
  proposalVersion: ProposalVersionSchema,
  decision: ApprovalDecisionSchema,
  approvedContentHash: ContentHashSchema,
  provenance: ApprovalProvenanceSchema,
  decidedAt: TimestampSchema,
  expiresAt: z.number().int().nonnegative().nullable(),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalVerificationInputSchema = z.object({
  proposalId: ProposalIdSchema,
  proposalVersion: ProposalVersionSchema,
  contentHash: ContentHashSchema,
  now: TimestampSchema,
});
export type ApprovalVerificationInput = z.infer<typeof ApprovalVerificationInputSchema>;

export const AuthorizationToApplySchema = z.object({
  approvalId: ApprovalIdSchema,
  proposalId: ProposalIdSchema,
  proposalVersion: ProposalVersionSchema,
  contentHash: ContentHashSchema,
  authorizedAt: TimestampSchema,
});
export type AuthorizationToApply = z.infer<typeof AuthorizationToApplySchema>;

export const CreatePendingApprovalInputSchema = z.object({
  approvalId: ApprovalIdSchema,
  proposalId: ProposalIdSchema,
  proposalVersion: ProposalVersionSchema,
  approvedContentHash: ContentHashSchema,
  provenance: ApprovalProvenanceSchema,
  expiresAt: z.number().int().nonnegative().nullable(),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
  createdAt: TimestampSchema,
});
export type CreatePendingApprovalInput = z.infer<typeof CreatePendingApprovalInputSchema>;

/**
 * Validates that a provenance is trusted. Only `trusted-boundary` provenance
 * counts as trusted proof of user approval.
 */
export function isTrustedProvenanceSchema(provenance: ApprovalProvenance): boolean {
  return provenance.kind === 'trusted-boundary';
}

export function validateApproval(approval: unknown): Approval {
  return ApprovalSchema.parse(approval);
}

export function safeValidateApproval(
  approval: unknown
): { success: true; data: Approval } | { success: false; error: z.ZodError } {
  const result = ApprovalSchema.safeParse(approval);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateApprovalDecisionRequest(
  request: unknown
): ApprovalDecisionRequest {
  return ApprovalDecisionRequestSchema.parse(request);
}

export function safeValidateApprovalDecisionRequest(
  request: unknown
): { success: true; data: ApprovalDecisionRequest } | { success: false; error: z.ZodError } {
  const result = ApprovalDecisionRequestSchema.safeParse(request);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateApprovalVerificationInput(
  input: unknown
): ApprovalVerificationInput {
  return ApprovalVerificationInputSchema.parse(input);
}

export function safeValidateApprovalVerificationInput(
  input: unknown
): { success: true; data: ApprovalVerificationInput } | { success: false; error: z.ZodError } {
  const result = ApprovalVerificationInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateAuthorizationToApply(
  authorization: unknown
): AuthorizationToApply {
  return AuthorizationToApplySchema.parse(authorization);
}

export function safeValidateAuthorizationToApply(
  authorization: unknown
): { success: true; data: AuthorizationToApply } | { success: false; error: z.ZodError } {
  const result = AuthorizationToApplySchema.safeParse(authorization);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateCreatePendingApprovalInput(
  input: unknown
): CreatePendingApprovalInput {
  return CreatePendingApprovalInputSchema.parse(input);
}

export function safeValidateCreatePendingApprovalInput(
  input: unknown
): { success: true; data: CreatePendingApprovalInput } | { success: false; error: z.ZodError } {
  const result = CreatePendingApprovalInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
