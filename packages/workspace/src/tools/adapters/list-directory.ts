import { z } from 'zod';
import {
  createDirectoryLister,
  type DirectoryListConfig,
  defaultDirectoryListConfig,
  safeValidateDirectoryListConfig,
  type ListDirectoryOptions,
  type ListDirectoryResult,
} from '../index.js';
import {
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  ToolErrorCode,
  createToolError,
  isToolError,
} from '@nexipi/models/tools';
import type { FileSystemProvider } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';

export interface ListDirectoryAdapterDependencies {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<DirectoryListConfig>;
}

const ListDirectoryInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  maxEntries: z.number().int().positive().optional(),
  filterByType: z.enum(['file', 'directory', 'all']).optional(),
  includePatterns: z.array(z.string().min(1)).optional(),
});

const DirectoryListingEntrySchema = z.object({
  relativePath: z.string(),
  name: z.string(),
  type: z.enum(['file', 'directory', 'symbolicLink']),
  size: z.number().int().nonnegative().nullable(),
  mtime: z.number().nullable(),
  language: z.string().nullable(),
  category: z.string(),
  isBinary: z.boolean(),
  isSensitive: z.boolean(),
  isIgnored: z.boolean(),
});

const ListDirectoryOutputSchema = z.object({
  kind: z.literal('list'),
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  entries: z.array(DirectoryListingEntrySchema),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  cancelled: z.boolean(),
  completed: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    isFatal: z.boolean(),
  })),
});

export function createListDirectoryToolDefinition(
  deps: ListDirectoryAdapterDependencies
): ToolDefinition {
  const configValidation = safeValidateDirectoryListConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid list config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: DirectoryListConfig = { ...defaultDirectoryListConfig, ...configValidation.data };
  const lister = createDirectoryLister({
    fileSystem: deps.fileSystem,
    workspaceFolder: deps.workspaceFolder,
    config,
  });

  const workspaceId = deps.workspaceFolder.uri
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < workspaceId.length; i++) {
    const char = workspaceId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const computedWorkspaceId = `ws_${Math.abs(hash).toString(36)}`;

  return {
    name: 'list_directory',
    description: 'List the contents of a directory in the workspace. Supports recursive traversal, depth limits, entry filters, and respects workspace boundaries, ignore rules, and sensitive file protections.',
    inputSchema: ListDirectoryInputSchema,
    outputSchema: ListDirectoryOutputSchema,
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const executeImpl = async (): Promise<ListDirectoryResult> => {
        if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
          throw createToolError(
            ToolErrorCode.TOOL_RESOURCE_LIMIT,
            'Workspace identity mismatch: tool execution context does not match adapter workspace',
            { toolName: 'list_directory' }
          );
        }

        const options: ListDirectoryOptions = {
          uri: (input as { uri: string }).uri,
          workspaceFolder: deps.workspaceFolder,
          recursive: (input as { recursive?: boolean }).recursive,
          maxDepth: (input as { maxDepth?: number }).maxDepth,
          maxEntries: (input as { maxEntries?: number }).maxEntries,
          filterByType: (input as { filterByType?: 'file' | 'directory' | 'all' }).filterByType,
          includePatterns: (input as { includePatterns?: string[] }).includePatterns,
          signal: context.signal,
        };

        try {
          const result: ListDirectoryResult = await lister.listDirectory(options);
          return result;
        } catch (error) {
          if (isToolError(error)) {
            throw error;
          }
          throw createToolError(
            ToolErrorCode.TOOL_EXECUTION_FAILED,
            `Tool 'list_directory' execution failed`,
            { toolName: 'list_directory', cause: error instanceof Error ? error : undefined }
          );
        }
      };
      return executeImpl() as unknown as Promise<ToolExecutionResult>;
    },
  };
}