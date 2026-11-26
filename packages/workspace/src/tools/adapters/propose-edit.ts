/**
 * Phase 10 Stage D — Editing tool definition: propose_edit.
 *
 * Model-facing tool that proposes a controlled edit to a workspace file without
 * modifying that file. All proposal identity, metadata, timestamps, and lifecycle
 * values are derived by trusted application code or the injected proposal-creation
 * boundary. The model supplies only the target file URI and the edit operations.
 *
 * No filesystem write is performed by this tool. Proposal creation is delegated to
 * an injected {@link ProposalCreationBoundary}, which Stage E will back with a
 * real ProposalStore. Until then the boundary must be supplied by the caller; a
 * missing or failing boundary fails closed (no proposal is reported as created).
 */

import { z } from 'zod';
import {
  type ToolDefinition,
  type ToolExecutionContext,
  ToolErrorCode,
  createToolError,
} from '@nexipi/models/tools';
import type { FileSystemProvider } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import {
  type EditOperation,
  EditOperationSchema,
  MAX_EDIT_OPERATIONS,
  type ProposalStatus,
  ProposalStatusSchema,
  EditPreviewSchema,
  applyOperations,
  computeDiff,
  sha256,
  type ApplyOperationsResult,
} from '../../editing/index.js';
import {
  defaultFileReadConfig,
  safeValidateFileReadConfig,
  type FileReadConfig,
} from '../config.js';
import {
  isBinaryContent,
  isBinaryExtension,
  isSensitiveFileName,
  splitNameExtension,
  normalizePath,
  isChildOf,
  relativePath,
  computeWorkspaceId,
} from '../classification.js';
import { validateSymlinkFreePath } from '../path-security.js';

/**
 * Request handed to the trusted proposal-creation boundary.
 *
 * Every field is derived by the tool or supplied by the trusted boundary — never
 * by the model. Stage E implements this boundary against a ProposalStore.
 */
export interface ProposalCreationRequest {
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
}

/**
 * Result returned by the trusted proposal-creation boundary.
 *
 * The boundary confirms proposal identity, version, status, and timing. The tool
 * does not invent these values.
 */
export interface ProposalCreationResult {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Narrow injected boundary for creating a proposal.
 *
 * Stage D does not implement a ProposalStore (persistent or in-memory). This
 * interface is the seam Stage E will implement. The tool must not pretend a
 * proposal has been persisted when this boundary has not confirmed it.
 */
export interface ProposalCreationBoundary {
  createProposal(request: ProposalCreationRequest): Promise<ProposalCreationResult>;
}

export interface ProposeEditAdapterDependencies {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  proposalCreation: ProposalCreationBoundary;
  config?: Partial<FileReadConfig> | undefined;
}

const ProposeEditInputSchema = z
  .object({
    uri: z.string().min(1, 'uri is required'),
    operations: z.array(EditOperationSchema).min(1).max(MAX_EDIT_OPERATIONS),
  })
  .strict();

export type ProposeEditInput = z.infer<typeof ProposeEditInputSchema>;

const ProposeEditOutputSchema = z.object({
  kind: z.literal('propose-edit-result'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  status: ProposalStatusSchema,
  relativePath: z.string().min(1, 'relativePath is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  originalContentHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      'originalContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
    ),
  originalSize: z.number().int().nonnegative(),
  originalMtime: z.number().int().nonnegative(),
  proposedContentHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      'proposedContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
    ),
  proposedSize: z.number().int().nonnegative(),
  preview: EditPreviewSchema,
  approvalRequired: z.boolean(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

export type ProposeEditOutput = z.infer<typeof ProposeEditOutputSchema>;

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
      toolName: 'propose_edit',
    });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

export function createProposeEditToolDefinition(
  deps: ProposeEditAdapterDependencies
): ToolDefinition {
  const configValidation = safeValidateFileReadConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid propose edit config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: FileReadConfig = { ...defaultFileReadConfig, ...configValidation.data };

  const computedWorkspaceId = computeWorkspaceId(deps.workspaceFolder.uri);

  return {
    name: 'propose_edit',
    description:
      'Propose a controlled edit to a workspace file without modifying it. Reads the target file, validates the edit operations, and returns a structured proposal preview. The model cannot supply proposal identity, timestamps, approval status, or file metadata; those are derived by trusted code. No filesystem write is performed.',
    inputSchema: ProposeEditInputSchema,
    outputSchema: ProposeEditOutputSchema,
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: false,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ProposeEditOutput> => {
      if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          'Workspace identity mismatch: tool execution context does not match adapter workspace',
          { toolName: 'propose_edit' }
        );
      }

      const { uri, operations } = input as ProposeEditInput;

      checkCancelled(context.signal);

      const absPath = normalizePath(uri);
      const root = normalizePath(deps.workspaceFolder.uri);

      // Workspace boundary enforcement: reject paths outside the workspace.
      if (!isChildOf(root, absPath)) {
        throw createToolError(
          ToolErrorCode.TOOL_INVALID_ARGUMENTS,
          'Path is outside the workspace root',
          { toolName: 'propose_edit' }
        );
      }

      checkCancelled(context.signal);

      // Validate every component from the workspace root to the target without
      // following symlinks, and confirm the target is a file.
      let linkStat: { readonly type: string };
      try {
        linkStat = await validateSymlinkFreePath(deps.fileSystem, root, absPath, context.signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
            toolName: 'propose_edit',
          });
        }
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `Unable to resolve path safely: ${error instanceof Error ? error.message : String(error)}`,
          { toolName: 'propose_edit', cause: error instanceof Error ? error : undefined }
        );
      }
      if (linkStat.type !== 'file') {
        throw createToolError(ToolErrorCode.TOOL_INVALID_ARGUMENTS, 'Path is not a file', {
          toolName: 'propose_edit',
        });
      }

      let stat: { readonly size: number; readonly mtime: number };
      try {
        const fsStat = await deps.fileSystem.stat(absPath);
        stat = { size: fsStat.size, mtime: fsStat.mtime };
      } catch (error) {
        if (isAbortError(error)) {
          throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
            toolName: 'propose_edit',
          });
        }
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `File not found: ${error instanceof Error ? error.message : String(error)}`,
          { toolName: 'propose_edit', cause: error instanceof Error ? error : undefined }
        );
      }

      // Pre-read content size limit enforced from stat metadata.
      if (stat.size > config.maxFileSize) {
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `File size ${stat.size} bytes exceeds the maximum of ${config.maxFileSize} bytes`,
          { toolName: 'propose_edit' }
        );
      }

      const rel = relativePath(root, absPath);
      if (rel === undefined) {
        throw createToolError(
          ToolErrorCode.TOOL_INVALID_ARGUMENTS,
          'Path escapes workspace root boundary',
          { toolName: 'propose_edit' }
        );
      }

      // Sensitive-file protection (filename-based, before content is read).
      if (config.respectSensitiveFiles) {
        const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
        const { extension } = splitNameExtension(baseName);
        if (isSensitiveFileName(baseName, extension)) {
          throw createToolError(
            ToolErrorCode.TOOL_EXECUTION_FAILED,
            'Sensitive file access is not allowed',
            { toolName: 'propose_edit' }
          );
        }
      }

      // Read the original file through the read-only filesystem abstraction.
      let originalContent: string;
      try {
        originalContent = await deps.fileSystem.readFile(absPath);
      } catch (error) {
        if (isAbortError(error)) {
          throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Read cancelled', {
            toolName: 'propose_edit',
          });
        }
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          { toolName: 'propose_edit', cause: error instanceof Error ? error : undefined }
        );
      }

      checkCancelled(context.signal);

      // Binary-content protection after reading.
      if (config.enableBinaryDetection) {
        const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
        const { extension } = splitNameExtension(baseName);
        if (isBinaryExtension(extension) || isBinaryContent(originalContent)) {
          throw createToolError(
            ToolErrorCode.TOOL_EXECUTION_FAILED,
            'Binary file content is not allowed',
            { toolName: 'propose_edit' }
          );
        }
      }

      const fileUri = `file://${absPath}`;

      // Trusted metadata is derived here, never accepted from the model.
      const originalContentHash = sha256(originalContent);
      const originalSize = Buffer.byteLength(originalContent, 'utf8');

      // Validate edit operations using Stage B pure editing functions. This also
      // computes the proposed content, its hash, and its size.
      let proposedResult: ApplyOperationsResult;
      try {
        proposedResult = applyOperations(originalContent, operations);
      } catch (error) {
        if (error instanceof Error && error.name === 'EditDomainError') {
          throw createToolError(ToolErrorCode.TOOL_INVALID_ARGUMENTS, error.message, {
            toolName: 'propose_edit',
            cause: error,
          });
        }
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          'Failed to compute proposed edit',
          { toolName: 'propose_edit', cause: error instanceof Error ? error : undefined }
        );
      }

      // Produce a structured preview and diff summary.
      const diff = computeDiff(originalContent, proposedResult.content);
      const preview: z.infer<typeof EditPreviewSchema> = {
        kind: 'edit-preview',
        proposalId: '', // filled in once the boundary confirms the proposal identity
        fileUri,
        relativePath: rel,
        originalContent: originalContent,
        proposedContent: proposedResult.content,
        diffSummary: diff.summary,
        truncated: diff.truncated,
        originalTruncated: diff.truncated,
        proposedTruncated: diff.truncated,
      };

      // Delegate proposal creation to the trusted injected boundary. The boundary
      // confirms proposal identity, version, status, and timing. The tool does not
      // invent these values and does not persist anything itself.
      let creation: ProposalCreationResult;
      try {
        creation = await deps.proposalCreation.createProposal({
          workspaceId: computedWorkspaceId,
          workspaceFolderUri: deps.workspaceFolder.uri,
          fileUri,
          relativePath: rel,
          originalContentHash,
          originalSize,
          originalMtime: stat.mtime,
          operations,
          proposedContentHash: proposedResult.contentHash,
          proposedSize: proposedResult.size,
        });
      } catch (error) {
        // Fail closed: a proposal that the trusted boundary has not confirmed must
        // not be reported as created.
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          'Proposal creation failed: the trusted proposal-creation boundary did not confirm the proposal',
          { toolName: 'propose_edit', cause: error instanceof Error ? error : undefined }
        );
      }

      const output: ProposeEditOutput = {
        kind: 'propose-edit-result',
        proposalId: creation.proposalId,
        proposalVersion: creation.proposalVersion,
        status: creation.status,
        relativePath: rel,
        fileUri,
        workspaceId: computedWorkspaceId,
        originalContentHash,
        originalSize,
        originalMtime: stat.mtime,
        proposedContentHash: proposedResult.contentHash,
        proposedSize: proposedResult.size,
        preview: { ...preview, proposalId: creation.proposalId },
        approvalRequired: creation.status !== 'approved',
        createdAt: creation.createdAt,
        expiresAt: creation.expiresAt,
      };

      const parsed = ProposeEditOutputSchema.safeParse(output);
      if (!parsed.success) {
        throw createToolError(
          ToolErrorCode.TOOL_INVALID_RESULT,
          `Tool 'propose_edit' returned invalid output`,
          { toolName: 'propose_edit' }
        );
      }
      return parsed.data;
    },
  };
}
