import * as vscode from 'vscode';
import * as path from 'path';
import { z } from 'zod';
import { defaultConfig } from '@nexipi/core';
import type { Logger, LogLevel } from '@nexipi/shared';
import type { ChatService } from '@nexipi/models';
import { createChatService } from '@nexipi/models';
import { createProviderRegistry } from '@nexipi/models';
import type { StreamEvent, Message, ConversationId, MessageId } from '@nexipi/shared';
import { PersistenceFoundation } from '@nexipi/persistence';
import type { PersistencePortService } from '@nexipi/persistence';
import {
  createPersistenceService,
  SqlJsConversationRepository,
  SqlJsMessageRepository,
  SqlJsProposalRepository,
  SqlJsApprovalRepository,
} from '@nexipi/persistence';
import { createPersistenceAdapter } from '@nexipi/models';
import { WorkspaceManager } from './workspace/workspace-manager.js';
import { VSCodeWorkspaceProvider } from './workspace/vscode-workspace-provider.js';
import { VSCodeFileSystemProvider } from './workspace/vscode-file-system-provider.js';
import { VSCodeWritableFileSystem } from './workspace/vscode-writable-file-system.js';
import {
  createToolRegistry,
  type ToolRegistry,
  ToolErrorCode,
  createToolError,
} from '@nexipi/models/tools';
import { ToolExecutor } from '@nexipi/models/tools';
import { ToolExecutionService, type ToolExecutionServiceConfig } from '@nexipi/models/tools';
import {
  createReadFileToolDefinition,
  createListDirectoryToolDefinition,
  createSearchCodeToolDefinition,
  createFindReferencesToolDefinition,
  createApplyEditToolDefinition,
  createProposeEditToolDefinition,
  ApplyEditInputSchema,
  ApplyEditOutputSchema,
  type ApplyEditInput,
  type ApplyEditOutput,
  isChildOf,
  normalizePath,
} from '@nexipi/workspace/tools';
import { createTrustedApprovalService, type TrustedApprovalService } from '@nexipi/workspace';
import type {
  ProposalRepositoryPort,
  ApprovalRepositoryPort,
  WorkspaceFolder,
  ReadFileResult,
  ListDirectoryResult,
  CodeSearchResult,
  ReferenceDiscoveryResult,
} from '@nexipi/workspace';
import { createComposedToolPermissionPolicy } from './tools/editing/composed-permission-policy.js';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from './tools/editing/persistence-repository-adapters.js';
import { TrustedEditAuthorizationBoundary } from './tools/editing/edit-authorization-boundary.js';
import { ProposalCreationRepositoryAdapter } from './tools/editing/proposal-creation-boundary.js';
import { VSCodeTrustedDecisionProvider } from './tools/editing/vscode-trusted-decision-provider.js';
import { ApprovalController } from './tools/editing/approval-controller.js';
import type { ToolDefinition, ToolExecutionContext } from '@nexipi/models/tools';

interface NexiPiContext {
  outputChannel: vscode.OutputChannel;
  statusBarItem: vscode.StatusBarItem;
  logger: Logger;
  disposables: vscode.Disposable[];
  chatService: ChatService;
  persistenceService?: PersistencePortService;
  toolRegistry: ToolRegistry;
  toolExecutionService: ToolExecutionService;
}

// Module-level variables for access in deactivate()
let gChatService: ChatService | undefined;
let gPersistenceService: PersistencePortService | undefined;
let gPersistenceAdapter: { dispose: () => void } | undefined;
let gLogger: Logger | undefined;
let gProposalRepositoryPort: ProposalRepositoryPort | undefined;
let gApprovalRepositoryPort: ApprovalRepositoryPort | undefined;
let gTrustedApprovalService: TrustedApprovalService | undefined;
let gFileSystem: VSCodeFileSystemProvider | undefined;
let gProposalRepository: SqlJsProposalRepository | undefined;
let gApprovalController: ApprovalController | undefined;

/**
 * Per-workspace editing services, bound to a single workspace identity each.
 * A disposed workspace's entry is removed so it cannot keep authorizing edits.
 */
interface WorkspaceEditingServices {
  readonly boundary: TrustedEditAuthorizationBoundary;
  readonly writableFileSystem: VSCodeWritableFileSystem;
}
const workspaceEditing = new Map<string, WorkspaceEditingServices>();
let gWorkspaceManager: WorkspaceManager | undefined;
let gToolRegistry: ToolRegistry | undefined;
let gToolExecutionService: ToolExecutionService | undefined;

// --- Multi-root workspace adapter registry ---
// Maps computed workspace ID -> adapter set for that workspace folder
interface WorkspaceAdapterSet {
  readonly folder: WorkspaceFolder;
  readonly readFile: (input: unknown, context: ToolExecutionContext) => Promise<ReadFileResult>;
  readonly listDirectory: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<ListDirectoryResult>;
  readonly searchCode: (input: unknown, context: ToolExecutionContext) => Promise<CodeSearchResult>;
  readonly findReferences: (
    input: unknown,
    context: ToolExecutionContext
  ) => Promise<ReferenceDiscoveryResult>;
  readonly computedWorkspaceId: string;
  /** Internal marker to indicate workspace is being removed */
  __closing?: boolean;
}

// Registry version token for atomicity - incremented on any registry change
let workspaceAdaptersVersion = 0;
export const workspaceAdapters = new Map<string, WorkspaceAdapterSet>();

function computeWorkspaceId(folderUri: string): string {
  const normalized = folderUri
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

function computeMultiRootWorkspaceId(folders: readonly WorkspaceFolder[]): string {
  if (folders.length === 0) return 'ws_0';
  // Sort by URI for deterministic ordering
  const sortedUris = folders.map(f => f.uri).sort();
  const combined = sortedUris.join('|');
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

function createWorkspaceAdapters(
  folder: WorkspaceFolder,
  fileSystem: VSCodeFileSystemProvider
): WorkspaceAdapterSet {
  const computedWorkspaceId = computeWorkspaceId(folder.uri);

  const readFileTool = createReadFileToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const listDirectoryTool = createListDirectoryToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const searchCodeTool = createSearchCodeToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });
  const findReferencesTool = createFindReferencesToolDefinition({
    fileSystem,
    workspaceFolder: folder,
  });

  return {
    folder,
    readFile: (input: unknown, context: ToolExecutionContext) =>
      readFileTool.execute(input, context) as Promise<ReadFileResult>,
    listDirectory: (input: unknown, context: ToolExecutionContext) =>
      listDirectoryTool.execute(input, context) as Promise<ListDirectoryResult>,
    searchCode: (input: unknown, context: ToolExecutionContext) =>
      searchCodeTool.execute(input, context) as Promise<CodeSearchResult>,
    findReferences: (input: unknown, context: ToolExecutionContext) =>
      findReferencesTool.execute(input, context) as Promise<ReferenceDiscoveryResult>,
    computedWorkspaceId,
  };
}

export function registerWorkspaceAdapters(
  folder: WorkspaceFolder,
  fileSystem: VSCodeFileSystemProvider,
  logger: Logger
): string {
  const adapterSet = createWorkspaceAdapters(folder, fileSystem);
  const workspaceId = adapterSet.computedWorkspaceId;

  if (workspaceAdapters.has(workspaceId)) {
    logger.warn('Workspace adapter already registered, replacing', {
      workspaceId,
      folderUri: folder.uri,
    });
  }
  workspaceAdapters.set(workspaceId, adapterSet);
  workspaceAdaptersVersion++;

  // Create per-workspace editing services bound to this workspace identity.
  // The trusted approval service shares the extension's single database, and
  // the boundary is bound to this workspace so cross-workspace authorization
  // is impossible. When the workspace is unregistered, its entry is removed
  // (see unregisterWorkspaceAdapters) so a disposed workspace cannot keep
  // authorizing edits.
  if (gTrustedApprovalService !== undefined && gProposalRepositoryPort !== undefined) {
    const boundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: gTrustedApprovalService,
      proposalRepository: gProposalRepositoryPort,
      fileSystem,
      workspaceId,
    });
    const writableFileSystem = new VSCodeWritableFileSystem({
      workspaceFolder: folder,
      fileSystem,
    });
    workspaceEditing.set(workspaceId, { boundary, writableFileSystem });
  } else {
    logger.warn(
      'Editing services not initialized; workspace edits will be denied until persistence is ready',
      {
        workspaceId,
        folderUri: folder.uri,
      }
    );
  }

  logger.info('Registered workspace adapters', {
    workspaceId,
    folderUri: folder.uri,
    folderId: folder.id,
    version: workspaceAdaptersVersion,
  });
  return workspaceId;
}

export async function unregisterWorkspaceAdapters(
  folderUri: string,
  logger: Logger
): Promise<void> {
  // Find and remove by folder URI
  for (const [workspaceId, adapterSet] of workspaceAdapters.entries()) {
    if (adapterSet.folder.uri === folderUri) {
      // Mark workspace as closing to prevent new leases
      beginWorkspaceRemoval(workspaceId);

      // Wait for active leases to release (with timeout)
      try {
        await waitForLeasesToRelease(workspaceId, 10000);
        logger.info('All leases released for workspace', { workspaceId });

        // All leases released - safe to remove immediately
        workspaceAdapters.delete(workspaceId);
        workspaceEditing.delete(workspaceId);
        workspaceAdaptersVersion++;
        if (gApprovalController) {
          gApprovalController.clearPendingForWorkspace(workspaceId);
        }
        logger.info('Unregistered workspace adapters', {
          workspaceId,
          folderUri,
          version: workspaceAdaptersVersion,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('Timeout waiting for leases, scheduling deferred cleanup', {
          workspaceId,
          error: err.message,
        });

        // Timeout - schedule deferred cleanup instead of proceeding immediately
        scheduleDeferredWorkspaceCleanup(workspaceId, logger);
      }
      return;
    }
  }
  logger.warn('No workspace adapters found for folder', { folderUri });
}

export function getRegisteredWorkspaceIds(): readonly string[] {
  return Array.from(workspaceAdapters.keys());
}

export function getWorkspaceAdaptersVersion(): number {
  return workspaceAdaptersVersion;
}

export function hasWorkspaceAdapter(workspaceId: string): boolean {
  return workspaceAdapters.has(workspaceId);
}

export function getWorkspaceAdapter(workspaceId: string): WorkspaceAdapterSet | undefined {
  return workspaceAdapters.get(workspaceId);
}

// --- Resource Lease Mechanism for Workspace Operations ---
// Tracks active operations per workspace to prevent premature disposal of filesystem resources.

interface WorkspaceLease {
  readonly workspaceId: string;
  readonly acquiredAt: number;
  readonly abortSignal: AbortSignal;
}

const workspaceLeases = new Map<string, Set<WorkspaceLease>>();

function acquireLease(workspaceId: string, signal: AbortSignal): WorkspaceLease {
  const lease: WorkspaceLease = {
    workspaceId,
    acquiredAt: Date.now(),
    abortSignal: signal,
  };
  let leases = workspaceLeases.get(workspaceId);
  if (!leases) {
    leases = new Set();
    workspaceLeases.set(workspaceId, leases);
  }
  leases.add(lease);
  return lease;
}

function releaseLease(workspaceId: string, lease: WorkspaceLease): void {
  const leases = workspaceLeases.get(workspaceId);
  if (leases) {
    leases.delete(lease);
    if (leases.size === 0) {
      workspaceLeases.delete(workspaceId);
    }
  }
}

function getTotalActiveLeases(): number {
  let total = 0;
  for (const leases of workspaceLeases.values()) {
    total += leases.size;
  }
  return total;
}

function hasActiveLeases(workspaceId: string): boolean {
  const leases = workspaceLeases.get(workspaceId);
  return leases !== undefined && leases.size > 0;
}

async function waitForLeasesToRelease(
  workspaceId: string,
  timeoutMs: number,
  pollIntervalMs = 50
): Promise<void> {
  const startTime = Date.now();
  for (;;) {
    if (!hasActiveLeases(workspaceId)) return;
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for leases to release on workspace ${workspaceId}`);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

async function waitForAllLeasesToRelease(timeoutMs: number, pollIntervalMs = 50): Promise<void> {
  const startTime = Date.now();
  for (;;) {
    if (getTotalActiveLeases() === 0) return;
    if (Date.now() - startTime > timeoutMs) {
      const remaining = getTotalActiveLeases();
      throw new Error(`Timeout waiting for ${remaining} leases to release`);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

// Track deferred cleanup operations to ensure exactly-once execution
const deferredWorkspaceCleanups = new Map<
  string,
  { workspaceId: string; logger: Logger; executed: boolean }
>();

function scheduleDeferredWorkspaceCleanup(workspaceId: string, logger: Logger): void {
  // Check if cleanup is already scheduled
  const existing = deferredWorkspaceCleanups.get(workspaceId);
  if (existing && !existing.executed) {
    logger.debug('Deferred cleanup already scheduled', { workspaceId });
    return;
  }

  deferredWorkspaceCleanups.set(workspaceId, { workspaceId, logger, executed: false });

  // Start background task that waits for leases to release
  void (async () => {
    try {
      // Wait indefinitely for leases to release - no timeout on deferred cleanup
      await waitForLeasesToRelease(workspaceId, 0); // 0 timeout means wait forever

      // Leases released - execute cleanup exactly once
      const entry = deferredWorkspaceCleanups.get(workspaceId);
      if (entry && !entry.executed) {
        entry.executed = true;
        workspaceAdapters.delete(workspaceId);
        workspaceEditing.delete(workspaceId);
        workspaceAdaptersVersion++;
        if (gApprovalController) {
          gApprovalController.clearPendingForWorkspace(workspaceId);
        }
        entry.logger.info('Deferred workspace cleanup executed', {
          workspaceId,
          version: workspaceAdaptersVersion,
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Deferred workspace cleanup failed', { workspaceId, error: err.message });
    } finally {
      deferredWorkspaceCleanups.delete(workspaceId);
    }
  })();
}

function beginWorkspaceRemoval(workspaceId: string): void {
  // Mark workspace as closing - no new leases can be acquired
  // We use a special marker in the adapters map to indicate closing state
  const adapter = workspaceAdapters.get(workspaceId);
  if (adapter) {
    // Store a marker that this workspace is closing
    adapter.__closing = true;
  }
}

function isWorkspaceClosing(workspaceId: string): boolean {
  const adapter = workspaceAdapters.get(workspaceId);
  return adapter ? !!adapter.__closing : false;
}

// --- Routed tool definitions (single registration per capability) ---
const ReadFileInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  workspaceId: z.string().min(1, 'workspaceId is required'),
});

const ListDirectoryInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
});

const SearchCodeInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  filePattern: z.string().optional(),
  caseSensitive: z.boolean().optional(),
});

const FindReferencesInputSchema = z.object({
  symbol: z.string().min(1, 'symbol is required'),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  filePattern: z.string().optional(),
});

export function createRoutedReadFileTool(): ToolDefinition {
  return {
    name: 'read_file',
    description:
      'Read the contents of a file from a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: ReadFileInputSchema,
    outputSchema: z.any(), // Output schema validated by underlying adapter
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ReadFileResult> => {
      const { uri, lineStart, lineEnd, workspaceId } = input as z.infer<typeof ReadFileInputSchema>;

      if (!hasWorkspaceAdapter(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_NOT_FOUND,
          `Workspace '${workspaceId}' is not registered`,
          { toolName: 'read_file' }
        );
      }

      if (isWorkspaceClosing(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${workspaceId}' is being removed, cannot accept new operations`,
          { toolName: 'read_file' }
        );
      }

      const adapter = getWorkspaceAdapter(workspaceId)!;

      // Create folder-scoped execution context with the adapter's folder-specific identity
      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: adapter.computedWorkspaceId,
        workspaceFolder: { uri: adapter.folder.uri, id: adapter.folder.id },
      };

      // Acquire lease to protect workspace resources during operation
      const lease = acquireLease(workspaceId, context.signal);
      try {
        return await adapter.readFile(
          { uri, lineStart, lineEnd, workspaceFolder: adapter.folder, signal: context.signal },
          folderContext
        );
      } finally {
        releaseLease(workspaceId, lease);
      }
    },
  };
}

export function createRoutedListDirectoryTool(): ToolDefinition {
  return {
    name: 'list_directory',
    description:
      'List the contents of a directory in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: ListDirectoryInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext
    ): Promise<ListDirectoryResult> => {
      const { uri, workspaceId } = input as z.infer<typeof ListDirectoryInputSchema>;

      if (!hasWorkspaceAdapter(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_NOT_FOUND,
          `Workspace '${workspaceId}' is not registered`,
          { toolName: 'list_directory' }
        );
      }

      if (isWorkspaceClosing(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${workspaceId}' is being removed, cannot accept new operations`,
          { toolName: 'list_directory' }
        );
      }

      const adapter = getWorkspaceAdapter(workspaceId)!;

      // Create folder-scoped execution context with the adapter's folder-specific identity
      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: adapter.computedWorkspaceId,
        workspaceFolder: { uri: adapter.folder.uri, id: adapter.folder.id },
      };

      // Acquire lease to protect workspace resources during operation
      const lease = acquireLease(workspaceId, context.signal);
      try {
        return await adapter.listDirectory(
          { uri, workspaceFolder: adapter.folder, signal: context.signal },
          folderContext
        );
      } finally {
        releaseLease(workspaceId, lease);
      }
    },
  };
}

export function createRoutedSearchCodeTool(): ToolDefinition {
  return {
    name: 'search_code',
    description:
      'Search for code patterns in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: SearchCodeInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<CodeSearchResult> => {
      const { pattern, workspaceId, filePattern, caseSensitive } = input as z.infer<
        typeof SearchCodeInputSchema
      >;

      if (!hasWorkspaceAdapter(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_NOT_FOUND,
          `Workspace '${workspaceId}' is not registered`,
          { toolName: 'search_code' }
        );
      }

      if (isWorkspaceClosing(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${workspaceId}' is being removed, cannot accept new operations`,
          { toolName: 'search_code' }
        );
      }

      const adapter = getWorkspaceAdapter(workspaceId)!;

      // Create folder-scoped execution context with the adapter's folder-specific identity
      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: adapter.computedWorkspaceId,
        workspaceFolder: { uri: adapter.folder.uri, id: adapter.folder.id },
      };

      // Acquire lease to protect workspace resources during operation
      const lease = acquireLease(workspaceId, context.signal);
      try {
        return await adapter.searchCode(
          {
            query: pattern,
            mode: 'literal',
            workspaceFolder: adapter.folder,
            includePatterns: filePattern ? [filePattern] : undefined,
            caseSensitive,
            signal: context.signal,
          },
          folderContext
        );
      } finally {
        releaseLease(workspaceId, lease);
      }
    },
  };
}

export function createRoutedFindReferencesTool(): ToolDefinition {
  return {
    name: 'find_references',
    description:
      'Find references to a symbol in a workspace folder. Requires workspaceId to select the target folder.',
    inputSchema: FindReferencesInputSchema,
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext
    ): Promise<ReferenceDiscoveryResult> => {
      const { symbol, workspaceId, filePattern } = input as z.infer<
        typeof FindReferencesInputSchema
      >;

      if (!hasWorkspaceAdapter(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_NOT_FOUND,
          `Workspace '${workspaceId}' is not registered`,
          { toolName: 'find_references' }
        );
      }

      if (isWorkspaceClosing(workspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${workspaceId}' is being removed, cannot accept new operations`,
          { toolName: 'find_references' }
        );
      }

      const adapter = getWorkspaceAdapter(workspaceId)!;

      // Create folder-scoped execution context with the adapter's folder-specific identity
      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: adapter.computedWorkspaceId,
        workspaceFolder: { uri: adapter.folder.uri, id: adapter.folder.id },
      };

      // Acquire lease to protect workspace resources during operation
      const lease = acquireLease(workspaceId, context.signal);
      try {
        return await adapter.findReferences(
          {
            symbol,
            workspaceFolder: adapter.folder,
            includePatterns: filePattern ? [filePattern] : undefined,
            signal: context.signal,
          },
          folderContext
        );
      } finally {
        releaseLease(workspaceId, lease);
      }
    },
  };
}

function applyEditFail(
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

export function createRoutedApplyEditTool(): ToolDefinition {
  return {
    name: 'apply_edit',
    description:
      'Apply a previously created edit proposal. The model may supply only the proposal identity and version. Execution fails closed until the trusted authorization boundary verifies an approval for the exact proposal version and content hash from persisted state. When authorized, the verified content is written to the verified file path immediately before the write succeeds. A model-generated call is never sufficient to authorize a filesystem write.',
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

      if (context.signal?.aborted) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
          toolName: 'apply_edit',
        });
      }

      if (gProposalRepositoryPort === undefined) {
        return applyEditFail(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          'Editing services are not initialized',
          false,
          false
        );
      }

      // Load the exact persisted proposal to determine its workspace identity
      // from trusted persisted state, not from untrusted model input.
      const proposalResult = await gProposalRepositoryPort.getProposal(proposalId, proposalVersion);
      if (proposalResult.error !== null) {
        return applyEditFail(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `Unable to read proposal: ${proposalResult.error.message}`,
          false,
          false
        );
      }
      const proposal = proposalResult.proposal;
      if (proposal === null) {
        return applyEditFail(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_NOT_FOUND,
          `Proposal '${proposalId}' version ${proposalVersion} not found`,
          false,
          false
        );
      }

      const editing = workspaceEditing.get(proposal.workspaceId);
      if (editing === undefined) {
        return applyEditFail(
          proposalId,
          proposalVersion,
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${proposal.workspaceId}' is not registered or has been disposed`,
          false,
          false
        );
      }

      const adapter = getWorkspaceAdapter(proposal.workspaceId);
      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: proposal.workspaceId,
        workspaceFolder: adapter ? { uri: adapter.folder.uri, id: adapter.folder.id } : undefined,
      };

      // Delegate to the workspace-scoped apply adapter, which re-verifies the
      // proposal belongs to this boundary's workspace and performs the write
      // immediately after authorization using exactly the verified content.
      const tool = createApplyEditToolDefinition({
        authorization: editing.boundary,
        writableFileSystem: editing.writableFileSystem,
      });
      return tool.execute(input, folderContext) as Promise<ApplyEditOutput>;
    },
  };
}

export function createRoutedProposeEditTool(): ToolDefinition {
  // Local structural mirrors of Stage D types (ProposeEditInput / ProposeEditOutput
  // are not re-exported from @nexipi/workspace/tools).
  interface ProposeEditInputLike {
    readonly uri: string;
    readonly operations: unknown[];
  }
  interface ProposeEditOutputLike {
    readonly proposalId: string;
    readonly proposalVersion: number;
    readonly status: string;
    readonly relativePath: string;
    readonly fileUri: string;
    readonly workspaceId: string;
    readonly originalContentHash: string;
    readonly originalSize: number;
    readonly originalMtime: number;
    readonly proposedContentHash: string;
    readonly proposedSize: number;
    readonly preview: unknown;
    readonly approvalRequired: boolean;
    readonly createdAt: number;
    readonly expiresAt: number;
  }

  return {
    name: 'propose_edit',
    description:
      'Create a persisted edit proposal awaiting trusted user approval. The model supplies only the target file URI and edit operations. The proposal identity, content hash, workspace, and lifecycle are derived from trusted persisted state; the model cannot fabricate approval. The proposal is not applied: explicit user approval through the trusted approval UI is required before apply_edit can succeed.',
    inputSchema: z.object({
      uri: z.string().min(1, 'uri is required'),
      operations: z.array(z.any()).min(1, 'at least one operation is required'),
    }),
    outputSchema: z.any(),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: false,
      version: '1.0.0',
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext
    ): Promise<ProposeEditOutputLike> => {
      const { uri } = input as ProposeEditInputLike;

      if (context.signal?.aborted) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', {
          toolName: 'propose_edit',
        });
      }

      if (!gFileSystem || !gProposalRepository || !gApprovalController) {
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          'Editing services are not initialized',
          { toolName: 'propose_edit' }
        );
      }

      // Resolve the workspace folder that contains the target file from the
      // trusted adapter registry. The model supplies only a URI; workspace
      // identity is derived here, never from untrusted input.
      const workspaceFolder = findWorkspaceFolderForUri(uri);
      if (workspaceFolder === undefined) {
        throw createToolError(
          ToolErrorCode.TOOL_NOT_FOUND,
          `No workspace folder contains '${uri}'`,
          { toolName: 'propose_edit' }
        );
      }

      if (isWorkspaceClosing(workspaceFolder.computedWorkspaceId)) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          `Workspace '${workspaceFolder.computedWorkspaceId}' is being disposed`,
          { toolName: 'propose_edit' }
        );
      }

      const folderContext: ToolExecutionContext = {
        ...context,
        workspaceId: workspaceFolder.computedWorkspaceId,
        workspaceFolder: {
          uri: workspaceFolder.folder.uri,
          id: workspaceFolder.folder.id,
        },
      };

      const proposalCreation = new ProposalCreationRepositoryAdapter({
        repository: gProposalRepository,
        fileSystem: gFileSystem,
      });

      const tool = createProposeEditToolDefinition({
        fileSystem: gFileSystem,
        workspaceFolder: workspaceFolder.folder,
        proposalCreation,
      });

      const output = (await tool.execute(input, folderContext)) as ProposeEditOutputLike;

      // Present the persisted proposal to the webview for review. The preview
      // and proposal identity come from the tool output (persisted state), not
      // from model-supplied data.
      void gApprovalController.onProposalCreated({
        proposalId: output.proposalId,
        proposalVersion: output.proposalVersion,
        fileUri: output.fileUri,
        relativePath: output.relativePath,
        workspaceId: output.workspaceId,
        workspaceName: workspaceFolder.folder.name,
        proposedContentHash: output.proposedContentHash,
        proposedSize: output.proposedSize,
        createdAt: output.createdAt,
        expiresAt: output.expiresAt,
        preview: output.preview,
      });

      return output;
    },
  };
}

function findWorkspaceFolderForUri(uri: string): WorkspaceAdapterSet | undefined {
  const target = normalizePath(uri);
  for (const adapterSet of workspaceAdapters.values()) {
    const root = normalizePath(adapterSet.folder.uri);
    if (isChildOf(root, target)) {
      return adapterSet;
    }
  }
  return undefined;
}

function registerRoutedTools(toolRegistry: ToolRegistry, logger: Logger): void {
  const tools = [
    createRoutedReadFileTool(),
    createRoutedListDirectoryTool(),
    createRoutedSearchCodeTool(),
    createRoutedFindReferencesTool(),
    createRoutedApplyEditTool(),
    createRoutedProposeEditTool(),
  ];

  for (const tool of tools) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
      logger.info('Registered routed tool', { toolName: tool.name });
    } else {
      logger.debug('Routed tool already registered', { toolName: tool.name });
    }
  }
}

function createLogger(outputChannel: vscode.OutputChannel, level: LogLevel): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (messageLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (levels[messageLevel] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      outputChannel.appendLine(
        `[${timestamp}] [${messageLevel.toUpperCase()}] ${message}${metaStr}`
      );
    }
  };

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  };
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'nexipi.showOutput';
  item.tooltip = 'Click to open NexiPi output channel';
  item.text = '$(plug) NexiPi: Initializing...';
  item.show();
  return item;
}

function updateStatusBar(
  statusBarItem: vscode.StatusBarItem,
  status: 'initializing' | 'active' | 'error',
  message?: string
): void {
  const icons = { initializing: '$(loading~spin)', active: '$(plug)', error: '$(error)' };
  const texts = {
    initializing: 'NexiPi: Initializing...',
    active: 'NexiPi: Active',
    error: 'NexiPi: Error',
  };
  statusBarItem.text = `${icons[status]} ${texts[status]}${message ? ` - ${message}` : ''}`;
}

class NexiPiSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nexipi.sidebar';
  private _view: vscode.WebviewView | undefined;
  private readonly _extensionUri: vscode.Uri;
  private readonly _logger: Logger;
  private readonly _chatService: ChatService;
  private _isDisposed = false;

  constructor(extensionUri: vscode.Uri, logger: Logger, chatService: ChatService) {
    this._extensionUri = extensionUri;
    this._logger = logger;
    this._chatService = chatService;
    this._setupChatServiceListeners();
  }

  /** Check if the webview is disposed */
  isDisposed(): boolean {
    return this._isDisposed;
  }

  private _setupChatServiceListeners(): void {
    this._chatService.on('stream:event', ({ event, timestamp: _timestamp }) => {
      this._sendStreamEvent(event);
    });

    this._chatService.on('message:created', ({ message, timestamp: _timestamp }) => {
      this._sendMessageCreated(message);
    });

    this._chatService.on('message:updated', ({ message, timestamp: _timestamp }) => {
      this._sendMessageUpdated(message);
    });

    this._chatService.on('conversation:created', ({ conversation, timestamp: _timestamp }) => {
      this._logger.debug('Conversation created', { conversationId: conversation.id });
    });

    this._chatService.on(
      'chat:error',
      ({ error, conversationId, messageId, timestamp: _timestamp }) => {
        this._logger.error('Chat error', { conversationId, messageId, error: error.message });
      }
    );
  }

  private _sendStreamEvent(event: StreamEvent): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping stream event - webview disposed or not available', {
        eventType: event.type,
      });
      return;
    }
    void this._view.webview.postMessage({
      type: 'streamEvent',
      payload: { event },
    });
  }

  private _sendMessageCreated(message: Message): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping messageCreated - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage({
      type: 'messageCreated',
      payload: { message },
    });
  }

  private _sendMessageUpdated(message: Message): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping messageUpdated - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage({
      type: 'messageUpdated',
      payload: { message },
    });
  }

  private _sendInitialState(): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping initial state - webview disposed or not available');
      return;
    }
    const modelConfigured = false;

    void this._view.webview.postMessage({
      type: 'state',
      payload: {
        messages: [],
        currentInput: '',
        viewMode: 'welcome',
        isLoading: false,
        modelConfigured,
        conversationId: null,
      },
    });
    this._logger.debug('Sent initial state to webview', { modelConfigured });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    this._isDisposed = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => this._onMessage(message), undefined, []);

    // Handle webview disposal
    webviewView.onDidDispose(() => {
      this._logger.info('Webview disposed');
      this._isDisposed = true;
      this._view = undefined;
      // Cancel any active streams for this webview
      // Note: We don't dispose the chat service here as it's shared
    });

    this._logger.info('Sidebar webview resolved');
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.js'))
      .toString();
    const styleUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.css'))
      .toString();

    this._logger.debug('Webview resource URIs', { scriptUri, styleUri });

    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" nonce="${nonce}">
  <title>NexiPi</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private _onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }

    const msg = message as { type: string; payload?: unknown };

    void (async () => {
      switch (msg.type) {
        case 'ready':
          this._logger.debug('Webview ready');
          this._sendInitialState();
          // (Re)send any pending proposals so a reloaded webview can resume
          // review of proposals created while the webview was hidden.
          if (gApprovalController) {
            for (const proposal of gApprovalController.getPendingProposals()) {
              void this._view?.webview.postMessage({
                type: 'proposalCreated',
                payload: proposal,
              });
            }
          }
          break;
        case 'sendMessage': {
          this._logger.info('Message from webview', { payload: msg.payload });
          const payload = msg.payload as { content: string; conversationId?: string } | undefined;
          if (!payload?.content) {
            this._logger.warn('sendMessage: missing content');
            return;
          }

          let conversationId = payload.conversationId;
          if (!conversationId) {
            const conversation = this._chatService.createConversation();
            conversationId = conversation.id;
          }

          try {
            await this._chatService.sendMessage(conversationId as ConversationId, payload.content);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._logger.error('Failed to send message', { error: err.message });
            void this._view?.webview.postMessage({
              type: 'error',
              payload: { message: err.message },
            });
          }
          break;
        }
        case 'newChat': {
          this._logger.info('New chat requested from webview');
          const conversation = this._chatService.createConversation();
          if (!this._isDisposed && this._view) {
            void this._view.webview.postMessage({
              type: 'state',
              payload: {
                messages: [],
                currentInput: '',
                viewMode: 'welcome',
                isLoading: false,
                modelConfigured: false,
                conversationId: conversation.id,
              },
            });
          }
          break;
        }
        case 'promptSelected': {
          this._logger.debug('Prompt selected from webview', { payload: msg.payload });
          break;
        }
        case 'openSettings': {
          this._logger.info('Open settings requested from webview', { payload: msg.payload });
          try {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:nexipi.nexipi'
            );
            this._logger.info('Settings opened successfully');
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this._logger.error('Failed to open settings', { error: err.message });
          }
          if (!this._isDisposed && this._view) {
            void this._view.webview.postMessage({
              type: 'settingsOpened',
              payload: { timestamp: new Date().toISOString() },
            });
          }
          break;
        }
        case 'cancelMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('cancelMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Cancel message requested', { messageId: payload.messageId });
          this._chatService.cancelMessage(payload.messageId as MessageId);
          break;
        }
        case 'retryMessage': {
          const payload = msg.payload as { messageId: string; conversationId: string } | undefined;
          if (!payload?.messageId || !payload?.conversationId) {
            this._logger.warn('retryMessage: missing messageId or conversationId');
            return;
          }
          this._logger.info('Retry message requested', { messageId: payload.messageId });
          void this._chatService.retryMessage(
            payload.conversationId as ConversationId,
            payload.messageId as MessageId
          );
          break;
        }
        case 'approvalAction': {
          const payload = msg.payload as
            | {
                proposalId?: string;
                proposalVersion?: number;
                decision?: string;
                workspaceId?: string;
                fileUri?: string;
              }
            | undefined;
          if (
            !payload?.proposalId ||
            payload.proposalVersion === undefined ||
            !payload.decision ||
            !payload.workspaceId ||
            !payload.fileUri
          ) {
            this._logger.warn('approvalAction: missing required fields');
            return;
          }
          this._logger.info('Approval action requested from webview', {
            proposalId: payload.proposalId,
            decision: payload.decision,
          });
          if (gApprovalController) {
            await gApprovalController.handleApprovalAction({
              proposalId: payload.proposalId,
              proposalVersion: payload.proposalVersion,
              decision: payload.decision as 'approve' | 'reject' | 'dismiss',
              workspaceId: payload.workspaceId,
              fileUri: payload.fileUri,
            });
          } else {
            void this._view?.webview.postMessage({
              type: 'approvalDecision',
              payload: {
                proposalId: payload.proposalId,
                proposalVersion: payload.proposalVersion,
                decision: null,
                status: 'failed',
                reason: 'Approval controller unavailable',
              },
            });
          }
          break;
        }
        default:
          this._logger.warn('Unknown message type from webview', { type: msg.type });
      }
    })();
  }

  public postMessage(message: unknown): void {
    if (this._isDisposed || !this._view) {
      this._logger.debug('Dropping postMessage - webview disposed or not available');
      return;
    }
    void this._view.webview.postMessage(message);
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  nexipiContext: NexiPiContext,
  config: vscode.WorkspaceConfiguration,
  _sidebarProvider: NexiPiSidebarProvider
): vscode.Disposable[] {
  const { outputChannel, statusBarItem, logger } = nexipiContext;
  const disposables: vscode.Disposable[] = [];

  const startDisposable = vscode.commands.registerCommand('nexipi.start', async () => {
    logger.info('Command executed: nexipi.start');
    updateStatusBar(statusBarItem, 'initializing');

    try {
      const enabled = config.get<boolean>('nexipi.enabled', true);
      if (!enabled) {
        logger.warn('NexiPi is disabled via configuration');
        void vscode.window.showWarningMessage(
          'NexiPi is disabled. Enable it in settings to start.'
        );
        updateStatusBar(statusBarItem, 'error', 'Disabled');
        return;
      }

      logger.info('Starting NexiPi...');
      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('NexiPi started successfully');
      updateStatusBar(statusBarItem, 'active');
      void vscode.window.showInformationMessage('NexiPi started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to start NexiPi', { error: err.message });
      updateStatusBar(statusBarItem, 'error', err.message);
      void vscode.window.showErrorMessage(`Failed to start NexiPi: ${err.message}`);
    }
  });

  const showOutputDisposable = vscode.commands.registerCommand('nexipi.showOutput', () => {
    logger.info('Command executed: nexipi.showOutput');
    outputChannel.show();
  });

  const showInformationDisposable = vscode.commands.registerCommand(
    'nexipi.showInformation',
    () => {
      logger.info('Command executed: nexipi.showInformation');
      const info = [
        `NexiPi v${defaultConfig.version}`,
        'Extensible AI coding agent for VS Code',
        '',
        'Commands:',
        '  nexipi.start - Initialize and start NexiPi',
        '  nexipi.showOutput - Show the output channel',
        '  nexipi.showInformation - Show this information',
        '  nexipi.focusSidebar - Focus the NexiPi sidebar',
      ].join('\n');
      void vscode.window.showInformationMessage(info, { modal: true });
    }
  );

  const focusSidebarDisposable = vscode.commands.registerCommand('nexipi.focusSidebar', () => {
    logger.info('Command executed: nexipi.focusSidebar');
    void vscode.commands.executeCommand('workbench.view.extension.nexipi');
  });

  disposables.push(
    startDisposable,
    showOutputDisposable,
    showInformationDisposable,
    focusSidebarDisposable
  );
  return disposables;
}

async function initializePersistence(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<PersistencePortService> {
  // Use globalStorageUri for application-wide data persistence
  const storagePath = context.globalStorageUri.fsPath;
  const dbPath = path.join(storagePath, 'nexipi.db');

  logger.info('Initializing persistence', { storagePath, dbPath });

  // Ensure storage directory exists
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(storagePath));
  } catch {
    // Directory may already exist
  }

  // Create locateFile function to resolve WASM file location
  const extensionPath = context.extensionPath;
  const locateFile = (file: string): string => {
    if (file === 'sql-wasm.wasm') {
      // In development, the WASM file is copied to dist/
      // In packaged extension, it's also in dist/
      return vscode.Uri.joinPath(vscode.Uri.file(extensionPath), 'dist', file).fsPath;
    }
    return file;
  };

  const foundationService = new PersistenceFoundation({
    dbPath,
    locateFile,
  });

  await foundationService.init();

  const conversationRepo = new SqlJsConversationRepository(foundationService.getRawDatabase());
  const messageRepo = new SqlJsMessageRepository(foundationService.getRawDatabase());

  const persistenceService = createPersistenceService(
    conversationRepo,
    messageRepo,
    foundationService
  );

  await persistenceService.initialize();

  logger.info('Persistence initialized successfully');
  return persistenceService;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('nexipi');
  const logLevel = config.get<LogLevel>('nexipi.logLevel', 'info');

  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  const logger = createLogger(outputChannel, logLevel);
  const statusBarItem = createStatusBarItem();

  logger.info(`Extension activating v${defaultConfig.version}`);
  outputChannel.appendLine(
    `[${new Date().toISOString()}] [INFO] NexiPi extension activating v${defaultConfig.version}`
  );

  // Track resources for cleanup on activation failure
  const createdResources: Array<{ name: string; dispose: () => Promise<void> | void }> = [];
  function trackResource(name: string, dispose: () => Promise<void> | void) {
    createdResources.push({ name, dispose });
  }
  async function cleanupOnFailure(error: Error) {
    logger.error('Activation failed, cleaning up resources', {
      error: error.message,
      resources: createdResources.map(r => r.name).join(', '),
    });
    // Clean up in reverse order
    for (let i = createdResources.length - 1; i >= 0; i--) {
      const resource = createdResources[i];
      try {
        await resource.dispose();
        logger.debug('Cleaned up resource', { name: resource.name });
      } catch (cleanupError) {
        const err = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        logger.warn('Failed to cleanup resource', { name: resource.name, error: err.message });
      }
    }
    createdResources.length = 0;
  }

  // --- Workspace intelligence (Phase 08 Stage F) ---
  const workspaceProvider = new VSCodeWorkspaceProvider();
  const fileSystem = new VSCodeFileSystemProvider();
  gFileSystem = fileSystem;
  const workspaceManager = new WorkspaceManager(workspaceProvider, fileSystem, { logger });
  gWorkspaceManager = workspaceManager;
  trackResource('workspaceManager', () => workspaceManager.dispose());

  workspaceManager.onStatusChange(status => {
    if (status.disposed) {
      updateStatusBar(statusBarItem, 'error', 'Workspace disposed');
      return;
    }
    const progress = status.progress;
    const detail = progress
      ? `${progress.stage} (${progress.filesDiscovered} files)`
      : `idle (${status.orchestrator.activeScanCount} active)`;
    updateStatusBar(statusBarItem, 'active', `Workspace: ${detail}`);
  });

  // Initialize workspace manager and wait for initial scan to complete
  // before registering tools, to ensure workspace identity is stable.
  try {
    await workspaceManager.initialize();
    logger.info('Workspace manager initialized');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize workspace manager', { error: err.message });
    updateStatusBar(statusBarItem, 'error', 'Workspace init failed');
    await cleanupOnFailure(err);
    throw err;
  }

  // --- Tool infrastructure (Phase 09 Substage 7) ---
  // Create tool registry, executor with read-only permission policy, and execution service.
  const toolRegistry = createToolRegistry();
  gToolRegistry = toolRegistry;
  trackResource('toolRegistry', () => {
    /* ToolRegistry has no dispose */
  });

  const permissionPolicy = createComposedToolPermissionPolicy(logger);
  const toolExecutor = new ToolExecutor(toolRegistry, { permissionPolicy, logger });

  const toolExecutionServiceConfig: ToolExecutionServiceConfig = {
    maxIterationsPerTurn: 10,
    maxCallsPerBatch: 5,
    maxCallsPerTurn: 25,
    maxConcurrentExecutions: 5,
    maxExecutionTimePerToolMs: 30_000,
    maxTotalExecutionTimePerTurnMs: 120_000,
    maxQueuedCalls: 100,
  };
  const toolExecutionService = new ToolExecutionService(toolExecutor, {
    config: toolExecutionServiceConfig,
    logger,
  });
  gToolExecutionService = toolExecutionService;
  trackResource('toolExecutionService', () => toolExecutionService.dispose());

  // Register the four routed tools (single registration per capability)
  registerRoutedTools(toolRegistry, logger);

  // Register workspace adapters for each current workspace folder.
  const folders = await workspaceProvider.getWorkspaceFolders();
  for (const folder of folders) {
    registerWorkspaceAdapters(folder, fileSystem, logger);
  }

  // Subscribe to workspace folder changes to register/unregister adapters dynamically.
  const folderChangeSubscription = workspaceProvider.onWorkspaceFoldersChange(event => {
    // Unregister adapters for removed folders.
    for (const folder of event.removed) {
      void unregisterWorkspaceAdapters(folder.uri, logger);
    }

    // Register adapters for added folders.
    for (const folder of event.added) {
      registerWorkspaceAdapters(folder, fileSystem, logger);
    }

    // Changed folders (rename) are handled as remove + add by VS Code, but we log for clarity.
    if (event.changed.length > 0) {
      logger.info('Workspace folders changed (rename detected)', {
        changed: event.changed.map(f => f.uri),
      });
    }
  });
  // Track subscription for disposal
  const folderChangeDisposable = { dispose: () => folderChangeSubscription.unsubscribe() };
  trackResource('folderChangeSubscription', () => folderChangeDisposable.dispose());

  // Compute stable multi-root workspace ID for persistence
  const workspaceId = computeMultiRootWorkspaceId(folders);
  logger.info('Multi-root workspace ID for persistence', {
    workspaceId,
    folderCount: folders.length,
  });

  // Initialize persistence
  let persistenceService: PersistencePortService;
  try {
    persistenceService = await initializePersistence(context, logger);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to initialize persistence', { error: err.message });
    updateStatusBar(statusBarItem, 'error', 'Persistence init failed');
    void vscode.window.showErrorMessage(`Failed to initialize NexiPi persistence: ${err.message}`);
    await cleanupOnFailure(err);
    throw err;
  }
  trackResource('persistenceService', () => persistenceService.save());

  // Create editing repository adapters and the trusted approval service,
  // reusing the existing persistence database instance. No second database or
  // persistence service is created. Stage F will replace the failing provider.
  const rawDatabase = persistenceService.getRawDatabase();
  const proposalRepository = new SqlJsProposalRepository(rawDatabase);
  const approvalRepository = new SqlJsApprovalRepository(rawDatabase);
  gProposalRepository = proposalRepository;
  gProposalRepositoryPort = new ProposalRepositoryAdapter(proposalRepository);
  gApprovalRepositoryPort = new ApprovalRepositoryAdapter(approvalRepository);
  gTrustedApprovalService = createTrustedApprovalService({
    proposals: gProposalRepositoryPort,
    approvals: gApprovalRepositoryPort,
    trustedDecisionProvider: new VSCodeTrustedDecisionProvider(),
  });

  // Create persistence adapter
  const persistenceAdapter = createPersistenceAdapter({
    persistencePort: persistenceService,
    workspaceId,
  });

  await persistenceAdapter.initialize();
  trackResource('persistenceAdapter', () => persistenceAdapter.dispose());

  const providerRegistry = createProviderRegistry();
  const chatService = createChatService({
    providerRegistry,
    logger,
    persistenceAdapter,
    workspaceId,
    toolRegistry,
    toolExecutionService,
  });

  // Initialize chat service (loads conversations from persistence)
  await chatService.initialize();
  trackResource('chatService', () => chatService.dispose());

  // Store for deactivate()
  gChatService = chatService;
  gPersistenceService = persistenceService;
  gPersistenceAdapter = persistenceAdapter;
  gLogger = logger;

  const sidebarProvider = new NexiPiSidebarProvider(context.extensionUri, logger, chatService);

  // Stage F: bind the approval controller to the sidebar webview so pending
  // proposals and decisions can be posted to the UI.
  gApprovalController = new ApprovalController({
    trustedApprovalService: gTrustedApprovalService,
    proposals: gProposalRepositoryPort,
    approvals: gApprovalRepositoryPort,
    postMessage: sidebarProvider.postMessage.bind(sidebarProvider),
    logger,
  });

  const nexipiContext: NexiPiContext = {
    outputChannel,
    statusBarItem,
    logger,
    disposables: [],
    chatService,
    persistenceService,
    toolRegistry,
    toolExecutionService,
  };

  const sidebarDisposable = vscode.window.registerWebviewViewProvider(
    NexiPiSidebarProvider.viewType,
    sidebarProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  const commandDisposables = registerCommands(context, nexipiContext, config, sidebarProvider);
  nexipiContext.disposables.push(...commandDisposables);

  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('nexipi')) {
      const newConfig = vscode.workspace.getConfiguration('nexipi');
      const newLogLevel = newConfig.get<LogLevel>('nexipi.logLevel', 'info');
      logger.info('Configuration changed', { logLevel: newLogLevel });
    }
  });
  nexipiContext.disposables.push(configChangeDisposable);

  nexipiContext.disposables.push(
    outputChannel,
    statusBarItem,
    sidebarDisposable,
    folderChangeDisposable,
    ...commandDisposables
  );

  context.subscriptions.push(...nexipiContext.disposables);

  // NOTE: Persistence adapter disposal is handled ONLY in async deactivate()
  // to avoid double-disposal and ensure correct shutdown ordering.

  // Clear the tracking array since activation succeeded
  createdResources.length = 0;

  gLogger.info('Extension activated successfully');
  updateStatusBar(statusBarItem, 'active');
}

// Track if deactivate has been called to ensure idempotency
let isDeactivated = false;

// Track deferred global cleanup for exactly-once execution
let deferredGlobalCleanup: { executed: boolean; logger: Logger } | null = null;

export async function deactivate(): Promise<void> {
  if (isDeactivated) {
    gLogger?.info('deactivate() called again, skipping (idempotent)');
    return;
  }
  isDeactivated = true;

  const logger = gLogger;
  const chatService = gChatService;
  const persistenceService = gPersistenceService;
  const toolExecutionService = gToolExecutionService;
  const approvalController = gApprovalController;

  if (!logger || !chatService || !persistenceService) {
    logger?.warn('deactivate() called but services not initialized');
    return;
  }

  logger.info('Starting async deactivation sequence');

  // Initialize deferred cleanup tracker
  deferredGlobalCleanup = { executed: false, logger };

  // 1. Stop accepting new work and cancel active ChatService requests/streams.
  //    This initiates cancellation which propagates to ToolExecutionService turns.
  try {
    await chatService.dispose();
    logger.info('ChatService disposed successfully');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose ChatService', { error: err.message });
  }

  // 2. Drain ToolExecutionService - await active executions with timeout.
  //    This ensures tools receive AbortSignal and have time to settle cooperatively.
  try {
    const drainResult = await toolExecutionService?.drain({ timeoutMs: 5000 });
    if (drainResult?.settled) {
      logger.info('ToolExecutionService drained successfully', {
        elapsedMs: drainResult.elapsedMs,
      });
    } else {
      logger.warn('ToolExecutionService drain timeout, active executions may still be running', {
        activeExecutions: drainResult?.activeExecutions,
        queuedCalls: drainResult?.queuedCalls,
        elapsedMs: drainResult?.elapsedMs,
      });
    }
    // Dispose the service after drain (releases turns, clears queue)
    toolExecutionService?.dispose();
    logger.info('ToolExecutionService disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to drain/dispose ToolExecutionService', { error: err.message });
  }

  // Stage F: dispose the approval controller so pending proposals are cleared
  // and no approval action can be acted on after deactivation.
  approvalController?.dispose();

  // 3. Wait for any remaining underlying execution promises to settle.
  //    This provides a safety net for uncooperative tools that ignore cancellation.
  try {
    await toolExecutionService?.waitForUnderlyings(2000);
    logger.info('ToolExecutionService underlying promises settled');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('ToolExecutionService underlying wait completed with timeout', {
      error: err.message,
    });
  }

  // 4. Wait for all workspace leases to release before disposing workspace manager.
  //    This ensures no active operation is using the filesystem when it's disposed.
  try {
    await waitForAllLeasesToRelease(10000);
    logger.info('All workspace leases released');

    // All leases released - safe to dispose workspace manager now
    disposeWorkspaceManagerAndCleanup(logger);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('Timeout waiting for leases, scheduling deferred global cleanup', {
      error: err.message,
    });

    // Timeout - schedule deferred global cleanup instead of proceeding
    scheduleDeferredGlobalCleanup(logger);
  }

  logger.info('Async deactivation sequence initiated (cleanup may continue in background)');
}

function disposeWorkspaceManagerAndCleanup(logger: Logger): void {
  // 5. Dispose workspace management and stop workspace activity.
  //    Now safe because all leases have been released.
  try {
    gWorkspaceManager?.dispose();
    logger.info('Workspace manager disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose workspace manager', { error: err.message });
  }

  // 6. Clear tool registry references and workspace adapters.
  workspaceAdapters.clear();
  workspaceLeases.clear();
  if (gToolRegistry) {
    logger.debug('ToolRegistry references cleared');
  }
  gToolRegistry = undefined;
  gToolExecutionService = undefined;

  // 7. Save the database to disk, then dispose persistence adapter.
  try {
    gPersistenceService?.save();
    logger.info('Database saved successfully on deactivation');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to save database on deactivation', { error: err.message });
    throw err;
  }

  // 8. Dispose persistence adapter (closes foundation service)
  try {
    gPersistenceAdapter?.dispose();
    logger.info('Persistence adapter disposed');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to dispose persistence adapter', { error: err.message });
  }

  logger.info('Async deactivation sequence completed');
}

function scheduleDeferredGlobalCleanup(logger: Logger): void {
  if (deferredGlobalCleanup?.executed) {
    return;
  }

  // Start background task that waits for leases to release
  void (async () => {
    try {
      // Wait indefinitely for leases to release - no timeout on deferred cleanup
      await waitForAllLeasesToRelease(0); // 0 timeout means wait forever

      // Leases released - execute cleanup exactly once
      if (deferredGlobalCleanup && !deferredGlobalCleanup.executed) {
        deferredGlobalCleanup.executed = true;
        disposeWorkspaceManagerAndCleanup(logger);
        logger.info('Deferred global cleanup executed');
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Deferred global cleanup failed', { error: err.message });
    }
  })();
}
