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
import type { WorkspaceFolder } from '../../types.js';
import type { EditApproval } from '../../editing/contracts.js';
import { safeValidateFileReadConfig, type FileReadConfig } from '../config.js';
import { computeWorkspaceId } from '../classification.js';

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
  readonly approval?: EditApproval;
  readonly reason?: string;
}

/**
 * Narrow injected boundary for verifying and authorizing edit application.
 *
 * Stage D does not implement approval storage, approval verification, or
 * authorized file application. This interface is the seam Stage E will implement.
 * The tool must not perform a write unless this boundary confirms authorization,
 * and even then Stage D defers the actual write to Stage E.
 */
export interface EditAuthorizationBoundary {
  verifyAndAuthorizeApplication(
    request: EditAuthorizationRequest
  ): Promise<EditAuthorizationResult>;
}

export interface ApplyEditAdapterDependencies {
  workspaceFolder: WorkspaceFolder;
  authorization: EditAuthorizationBoundary;
  config?: Partial<FileReadConfig> | undefined;
}

const ApplyEditInputSchema = z
  .object({
    proposalId: z.string().uuid('proposalId must be a valid UUID'),
    proposalVersion: z.number().int().positive().max(999),
  })
  .strict();

export type ApplyEditInput = z.infer<typeof ApplyEditInputSchema>;

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
  // Config is retained for future Stage E integration; Stage D performs no file I/O.

  const computedWorkspaceId = computeWorkspaceId(deps.workspaceFolder.uri);

  return {
    name: 'apply_edit',
    description:
      'Request application of a previously created edit proposal. The model may supply only the proposal identity and version. A model-generated call is never sufficient to authorize a filesystem write: execution fails closed until Stage E supplies trusted approval verification and permission enforcement. No file is written by this tool in Stage D.',
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
      if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          'Workspace identity mismatch: tool execution context does not match adapter workspace',
          { toolName: 'apply_edit' }
        );
      }

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
      // sole authorization evidence.
      if (!authorization.authorized || !authorization.approval) {
        return failResult(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_PERMISSION_DENIED,
          authorization.reason ?? 'Proposal is not approved or authorization is unavailable.',
          false,
          false
        );
      }

      // Even when the trusted boundary reports authorization, Stage D does not
      // perform the filesystem write. Actual authorized application belongs to
      // Stage E. Fail closed: report failure with a clear message rather than
      // fabricating an applied result or final file hash.
      return failResult(
        proposalId,
        proposalVersion,
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Authorized edit application is deferred to Stage E; no filesystem write was performed.',
        true,
        true
      );
    },
  };
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
