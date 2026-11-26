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
 *
 * Preview output is bounded so the model never receives unbounded file content.
 * Complete content hashes and sizes are preserved internally and reported; only
 * the preview representation is truncated.
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
 * Statuses that are valid immediately after a proposal is created.
 *
 * These are the only pre-approval, non-terminal statuses a newly created proposal
 * may carry. Terminal or post-approval statuses (approved, applied, rejected,
 * expired, failed, cancelled) are never valid initial creation results.
 */
export const INITIAL_PROPOSAL_STATUSES = [
  'pending-validation',
  'validated',
  'awaiting-approval',
] as const satisfies readonly ProposalStatus[];

type InitialProposalStatus = (typeof INITIAL_PROPOSAL_STATUSES)[number];

export function isInitialProposalStatus(status: ProposalStatus): status is InitialProposalStatus {
  return INITIAL_PROPOSAL_STATUSES.includes(status as InitialProposalStatus);
}

/**
 * Configuration for preview output bounds.
 *
 * Consistent with existing repository conventions: content preview mirrors
 * FileReadConfig.maxOutputSize (512 KB) and diff truncation mirrors
 * computeDiff's default maxLines (4000).
 *
 * The model-facing diff representation is `diffSummary` (line counts) plus the
 * `truncated` flag. `diffSummary` carries only small integers, so it is
 * inherently byte-bounded; `maxDiffPreviewSize` is provided as an explicit,
 * configurable byte budget for the diff representation should diff text ever be
 * included in the preview. `maxDiffLines` remains the active safeguard that
 * bounds diff computation by line count. Because individual diff lines can be
 * arbitrarily long, a line-count limit alone is not sufficient, so the content
 * that feeds the diff (`originalContent`/`proposedContent`) is additionally
 * bounded by byte limits via `maxPreviewContentSize`/`maxProposedPreviewSize`.
 */
export interface ProposeEditConfig {
  /** Maximum bytes of original content included in the model-facing preview. */
  readonly maxPreviewContentSize: number;
  /** Maximum bytes of proposed content included in the model-facing preview. */
  readonly maxProposedPreviewSize: number;
  /** Maximum total lines for diff computation/reporting. */
  readonly maxDiffLines: number;
  /**
   * Maximum bytes of the model-facing diff representation. Must be at least
   * MIN_DIFF_PREVIEW_SIZE_BYTES so a valid empty DiffSummary can be serialized.
   */
  readonly maxDiffPreviewSize: number;
}

/**
 * Minimum UTF-8 byte budget required to serialize a valid DiffSummary:
 * `{"linesAdded":0,"linesRemoved":0,"linesModified":0}`.
 */
export const MIN_DIFF_PREVIEW_SIZE_BYTES = Buffer.byteLength(
  JSON.stringify({ linesAdded: 0, linesRemoved: 0, linesModified: 0 }),
  'utf8'
);

export const defaultProposeEditConfig: ProposeEditConfig = {
  maxPreviewContentSize: 512 * 1024,
  maxProposedPreviewSize: 512 * 1024,
  maxDiffLines: 4000,
  maxDiffPreviewSize: 64 * 1024,
};

function safeValidateProposeEditConfig(
  config: unknown
): { success: true; data: ProposeEditConfig } | { success: false; error: z.ZodError } {
  const result = z
    .object({
      maxPreviewContentSize: z
        .number()
        .int()
        .positive()
        .default(defaultProposeEditConfig.maxPreviewContentSize),
      maxProposedPreviewSize: z
        .number()
        .int()
        .positive()
        .default(defaultProposeEditConfig.maxProposedPreviewSize),
      maxDiffLines: z.number().int().positive().default(defaultProposeEditConfig.maxDiffLines),
      maxDiffPreviewSize: z
        .number()
        .int()
        .positive()
        .default(defaultProposeEditConfig.maxDiffPreviewSize)
        .refine(value => value >= MIN_DIFF_PREVIEW_SIZE_BYTES, {
          message: `maxDiffPreviewSize must be at least ${MIN_DIFF_PREVIEW_SIZE_BYTES} bytes to hold a valid DiffSummary`,
        }),
    })
    .safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Truncates content to a byte budget without splitting multi-byte UTF-8
 * characters. Returns the (possibly shortened) content and whether truncation
 * occurred.
 */
function truncateContentByBytes(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength <= maxBytes) {
    return { content, truncated: false };
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const decoder = new TextDecoder();
  // Find the largest cut point at or before maxBytes that decodes cleanly.
  let cut = maxBytes;
  while (cut > 0) {
    try {
      const decoded = decoder.decode(bytes.subarray(0, cut));
      return { content: decoded, truncated: true };
    } catch {
      cut--;
    }
  }
  return { content: '', truncated: true };
}

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
  config?: Partial<ProposeEditConfig> | undefined;
}

const ProposeEditInputSchema = z
  .object({
    uri: z.string().min(1, 'uri is required'),
    operations: z.array(EditOperationSchema).min(1).max(MAX_EDIT_OPERATIONS),
  })
  .strict();

export type ProposeEditInput = z.infer<typeof ProposeEditInputSchema>;

/**
 * Bounded preview schema used for model-facing output. Enforces preview content
 * size limits so oversized content cannot be returned to the model.
 *
 * The diff representation (diffSummary plus truncation flags) is bounded at
 * runtime: diffSummary carries small integers bounded by maxDiffLines, and if
 * the serialized diff representation ever exceeds maxDiffPreviewSize, the
 * counts are zeroed out and diffTruncated is set. This schema enforces the
 * structural constraints; byte-level diff bounding is enforced at runtime.
 */
const BoundedEditPreviewSchema = EditPreviewSchema.extend({
  originalContent: z.string().max(defaultProposeEditConfig.maxPreviewContentSize),
  proposedContent: z.string().max(defaultProposeEditConfig.maxProposedPreviewSize),
  diffTruncated: z.boolean(),
});

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
  preview: BoundedEditPreviewSchema,
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
  const fileConfigValidation = safeValidateFileReadConfig(deps.config ?? {});
  if (!fileConfigValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid propose edit config: ${fileConfigValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const fileConfig: FileReadConfig = { ...defaultFileReadConfig, ...fileConfigValidation.data };

  const previewConfigValidation = safeValidateProposeEditConfig(deps.config ?? {});
  if (!previewConfigValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid propose edit preview config: ${previewConfigValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: ProposeEditConfig = {
    ...defaultProposeEditConfig,
    ...previewConfigValidation.data,
  };

  const computedWorkspaceId = computeWorkspaceId(deps.workspaceFolder.uri);

  return {
    name: 'propose_edit',
    description:
      'Propose a controlled edit to a workspace file without modifying it. Reads the target file, validates the edit operations, and returns a structured, size-bounded proposal preview. Preview content is truncated to a configurable byte budget; complete content hashes and sizes are always preserved. The model cannot supply proposal identity, timestamps, approval status, or file metadata; those are derived by trusted code. A newly created proposal always requires a separate user approval action (approvalRequired is always true). No filesystem write is performed.',
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
      if (stat.size > fileConfig.maxFileSize) {
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `File size ${stat.size} bytes exceeds the maximum of ${fileConfig.maxFileSize} bytes`,
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
      if (fileConfig.respectSensitiveFiles) {
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
      if (fileConfig.enableBinaryDetection) {
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
      // computes the complete proposed content, its hash, and its size. The
      // complete proposed content is preserved internally; only the preview is
      // truncated for the model-facing output.
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

      // Build the bounded model-facing preview. Truncation applies only to the
      // preview representation; the complete content, hashes, and sizes remain
      // intact for the trusted boundary and output.
      const originalPreview = truncateContentByBytes(originalContent, config.maxPreviewContentSize);
      const proposedPreview = truncateContentByBytes(
        proposedResult.content,
        config.maxProposedPreviewSize
      );
      const diff = computeDiff(originalContent, proposedResult.content, {
        maxLines: config.maxDiffLines,
      });
      // The model-facing diff representation is diffSummary (line counts) plus
      // truncation flags. diffSummary carries small integers bounded by
      // maxDiffLines, so it is inherently byte-bounded; maxDiffPreviewSize is an
      // explicit defense-in-depth budget. If the serialized diff representation
      // ever exceeds it, replace the counts with zeros and mark diffTruncated
      // rather than returning oversized data.
      const diffSummaryCandidate: {
        readonly linesAdded: number;
        readonly linesRemoved: number;
        readonly linesModified: number;
      } = {
        linesAdded: diff.summary.linesAdded,
        linesRemoved: diff.summary.linesRemoved,
        linesModified: diff.summary.linesModified,
      };
      const diffSummarySerialized = JSON.stringify(diffSummaryCandidate);
      const diffSummaryBytes = Buffer.byteLength(diffSummarySerialized, 'utf8');
      const diffExceedsByteBudget = diffSummaryBytes > config.maxDiffPreviewSize;
      const diffTruncated = diff.truncated || diffExceedsByteBudget;
      const diffSummary: {
        readonly linesAdded: number;
        readonly linesRemoved: number;
        readonly linesModified: number;
      } = diffExceedsByteBudget
        ? { linesAdded: 0, linesRemoved: 0, linesModified: 0 }
        : diffSummaryCandidate;
      const preview: z.infer<typeof BoundedEditPreviewSchema> = {
        kind: 'edit-preview',
        proposalId: '', // filled in once the boundary confirms the proposal identity
        fileUri,
        relativePath: rel,
        originalContent: originalPreview.content,
        proposedContent: proposedPreview.content,
        diffSummary,
        truncated: originalPreview.truncated || proposedPreview.truncated || diffTruncated,
        originalTruncated: originalPreview.truncated,
        proposedTruncated: proposedPreview.truncated,
        diffTruncated,
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

      // Enforce lifecycle separation: a newly created proposal may only carry a
      // pre-approval initial status. Terminal/post-approval statuses from the
      // boundary indicate a boundary violation and are rejected, not converted.
      if (!isInitialProposalStatus(creation.status)) {
        throw createToolError(
          ToolErrorCode.TOOL_INVALID_RESULT,
          `Proposal creation returned invalid initial status '${creation.status}'; a newly created proposal must be pending-validation, validated, or awaiting-approval`,
          { toolName: 'propose_edit' }
        );
      }

      // A successful proposal always requires a separate trusted user approval
      // action. Proposal creation is never equivalent to approval.
      const approvalRequired = true;

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
        approvalRequired,
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
