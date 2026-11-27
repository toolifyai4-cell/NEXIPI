/**
 * Phase 10 Stage D — Editing tool definition: apply_edit.
 *
 * Model-facing request contract for applying a previously created proposal. The
 * model may supply only the minimum identifying information: `proposalId` and
 * `proposalVersion`.
 *
 * CRITICAL SECURITY BOUNDARY: A model-generated apply_edit call must never be
 * sufficient to authorize a filesystem write. Stage D does not implement an
 * authorization bypass and does not perform any filesystem write. Application
 * of an approved proposal is delegated to an injected
 * {@link EditAuthorizationBoundary}, which Stage E will back with real approval
 * verification and permission enforcement. Until a trusted boundary confirms
 * authorization, execution fails closed: no write occurs and no 'applied'
 * outcome is ever reported.
 *
 * The model must not supply approved content, an approved-content-hash
 * authorization claim, approvedBy, approvedAt, workspace authorization,
 * arbitrary file paths, arbitrary replacement content, or a fabricated approval
 * object. The input schema accepts only proposalId and proposalVersion.
 */

import { z } from 'zod';
import {
  type ToolDefinition,
  type ToolExecutionContext,
  ToolErrorCode,
  createToolError,
} from '@nexipi/models/tools';
import type { Approval, AuthorizationToApply } from '../../editing/index.js';
import {
  ProposalVersionSchema,
  ContentHashSchema,
} from '../../editing/index.js';
import { WritableFileSystemError, type WritableFileSystemProvider } from '../../editing/writable-file-system.js';
import { safeValidateFileReadConfig, type FileReadConfig } from '../config.js';

/**
 * Request handed to the trusted edit-authorization boundary.
 *
 * Only the proposal identity and version are conveyed. Everything else
 * (approval, permission, content, timing) is controlled by the trusted boundary.
 */
export interface EditAuthorizationRequest {
  readonly proposalId: string;
  readonly proposalVersion: number;
}

/**
 * Result returned by the trusted edit-authorization boundary.
 *
 * `authorized` is true only when the boundary has independently verified an
 * approval for the given proposal and version. Stage E implements this boundary.
 */
export interface EditAuthorizationResult {
  readonly authorized: boolean;
  readonly approval?: Approval;
  readonly authorizationToApply?: AuthorizationToApply;
  readonly reason?: string;
  /**
   * Present only when `authorized` is true. The exact file identity and
   * content to apply, as independently verified by the boundary from persisted
   * state. The adapter must apply exactly this content to this file and must
   * not substitute model-supplied content.
   */
  readonly apply?: {
    readonly fileUri: string;
    readonly relativePath: string;
    readonly proposedContent: string;
    readonly proposedContentHash: string;
  };
}

/**
 * Narrow injected boundary for verifying and authorizing edit application.
 *
 * Stage D does not implement approval storage, approval verification, or
 * authorized file application. This interface is the seam Stage E implements.
 * The tool must not perform a write unless this boundary confirms authorization,
 * and even then Stage D defers the actual authorized write to the injected
 * writable filesystem (wired by Stage E).
 */
export interface EditAuthorizationBoundary {
  verifyAndAuthorizeApplication(
    request: EditAuthorizationRequest
  ): Promise<EditAuthorizationResult>;
}

export interface ApplyEditAdapterDependencies {
  authorization: EditAuthorizationBoundary;
  writableFileSystem: WritableFileSystemProvider;
  config?: Partial<FileReadConfig> | undefined;
}

const ApplyEditInputSchema = z
  .object({
    proposalId: z.string().uuid('proposalId must be a valid UUID'),
    proposalVersion: z.number().int().positive().max(999),
  })
  .strict();

export type ApplyEditInput = z.infer<typeof ApplyEditInputSchema>;
export { ApplyEditInputSchema };

const ApplyEditOutputSchema = z.object({
  kind: z.literal('apply-edit-result'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  outcome: z.enum(['applied', 'failed', 'cancelled']),
  approvalVerified: z.boolean(),
  authorized: z.boolean(),
  appliedAt: z.number().int().positive().nullable(),
  finalContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  finalSize: z.number().int().nonnegative().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
  staleDetected: z.boolean(),
});

export type ApplyEditOutput = z.infer<typeof ApplyEditOutputSchema>;
export { ApplyEditOutputSchema };

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
      toolName: 'apply_edit',
    });
  }
}

export function createApplyEditToolDefinition(deps: ApplyEditAdapterDependencies): ToolDefinition {
  const configValidation = safeValidateFileReadConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid apply edit config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }

  return {
    name: 'apply_edit',
    description:
      'Request application of a previously created edit proposal. The model may supply only the proposal identity and version. A model-generated call is never sufficient to authorize a filesystem write: execution fails closed until the trusted authorization boundary verifies an approval for the exact proposal version and content hash. When authorized, the verified content is written to the verified file path immediately before the write succeeds.',
    inputSchema: ApplyEditInputSchema,
    outputSchema: ApplyEditOutputSchema,
    metadata: {
      capabilities: ['write'] as const,
      readOnly: false,
      destructive: true,
      requiresWorkspace: true,
      idempotent: false,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ApplyEditOutput> => {
      const { proposalId, proposalVersion } = input as ApplyEditInput;

      checkCancelled(context.signal);

      // Consult the trusted authorization boundary. Model-supplied fake approval
      // fields are impossible here: the input schema admits only proposalId and
      // proposalVersion (strict mode rejects everything else). The boundary, not
      // the model, decides whether application is authorized.
      let authorization: EditAuthorizationResult;
      try {
        authorization = await deps.authorization.verifyAndAuthorizeApplication({
          proposalId,
          proposalVersion,
        });
      } catch (error) {
        // Boundary failure or missing boundary: fail closed. No write occurs.
        return failResult(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          'Edit authorization boundary is unavailable or failed; application denied.',
          false,
          false
        );
      }

      // Model-supplied replacement content and fabricated approval objects are
      // rejected at the schema boundary; the boundary's approval (if any) is the
      // sole authorization evidence. The boundary must also return the exact
      // content and file identity to apply.
      if (
        !authorization.authorized ||
        !authorization.approval ||
        !authorization.apply
      ) {
        return failResult(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_PERMISSION_DENIED,
          authorization.reason ?? 'Proposal is not approved or authorization is unavailable.',
          false,
          false
        );
      }

      // Authorization was established immediately before the write, using the
      // exact proposal version and content that will be applied. Apply exactly
      // the verified content to the verified file identity; never substitute
      // model-supplied content.
      const { fileUri, proposedContent, proposedContentHash } = authorization.apply;

      checkCancelled(context.signal);

      const contentBytes = Buffer.from(proposedContent, 'utf8');
      let writeError: { code: string; message: string } | null = null;
      let outcome: ApplyEditOutput['outcome'] = 'applied';
      try {
        await deps.writableFileSystem.writeFile(fileUri, contentBytes, context.signal);
      } catch (error) {
        const cancelled = isWriteCancelled(error);
        outcome = cancelled ? 'cancelled' : 'failed';
        writeError = {
          code: cancelled ? ToolErrorCode.TOOL_CANCELLED : ToolErrorCode.TOOL_EXECUTION_FAILED,
          message: cancelled
            ? 'Edit application was cancelled before the write completed.'
            : `Failed to write approved content: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (outcome !== 'applied') {
        return {
          kind: 'apply-edit-result',
          proposalId,
          proposalVersion,
          outcome,
          approvalVerified: true,
          authorized: true,
          appliedAt: null,
          finalContentHash: null,
          finalSize: null,
          error: writeError,
          staleDetected: false,
        };
      }

      return {
        kind: 'apply-edit-result',
        proposalId,
        proposalVersion,
        outcome: 'applied',
        approvalVerified: true,
        authorized: true,
        appliedAt: Date.now(),
        finalContentHash: proposedContentHash,
        finalSize: Buffer.byteLength(proposedContent, 'utf8'),
        error: null,
        staleDetected: false,
      };
    },
  };
}

function isWriteCancelled(error: unknown): boolean {
  if (error instanceof WritableFileSystemError) {
    return error.code === 'WRITE_CANCELLED';
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    return error.name === 'AbortError' || code === 'ABORT_ERR' || code === 'WRITE_CANCELLED';
  }
  return false;
}

function failResult(
  proposalId: string,
  proposalVersion: number,
  code: ToolErrorCode,
  message: string,
  approvalVerified: boolean,
  authorized: boolean
): ApplyEditOutput {
  return {
    kind: 'apply-edit-result',
    proposalId,
    proposalVersion,
    outcome: 'failed',
    approvalVerified,
    authorized,
    appliedAt: null,
    finalContentHash: null,
    finalSize: null,
    error: { code, message },
    staleDetected: false,
  };
}
