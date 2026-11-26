import { z } from 'zod';
import {
  createFileReader,
  type FileReadConfig,
  defaultFileReadConfig,
  safeValidateFileReadConfig,
  type ReadFileOptions,
  type ReadFileResult,
} from '../index.js';
import {
  type ToolDefinition,
  type ToolExecutionContext,
  ToolErrorCode,
  createToolError,
  isToolError,
} from '@nexipi/models/tools';
import type { FileSystemProvider } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';

export interface ReadFileAdapterDependencies {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<FileReadConfig>;
}

const ReadFileInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
});

const ReadFileOutputSchema = z.object({
  kind: z.literal('read'),
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  size: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  returnedLineCount: z.number().int().nonnegative(),
  firstLine: z.number().int().positive().nullable(),
  lastLine: z.number().int().positive().nullable(),
  content: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
  encoding: z.literal('utf-8'),
  cancelled: z.boolean(),
});

export function createReadFileToolDefinition(deps: ReadFileAdapterDependencies): ToolDefinition {
  const configValidation = safeValidateFileReadConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid read config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: FileReadConfig = { ...defaultFileReadConfig, ...configValidation.data };
  const reader = createFileReader({
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
    name: 'read_file',
    description:
      'Read the contents of a file from the workspace. Supports line ranges, respects workspace boundaries, ignore rules, and sensitive file protections.',
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ReadFileResult> => {
      if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
        throw createToolError(
          ToolErrorCode.TOOL_RESOURCE_LIMIT,
          'Workspace identity mismatch: tool execution context does not match adapter workspace',
          { toolName: 'read_file' }
        );
      }

      const options: ReadFileOptions = {
        uri: (input as { uri: string }).uri,
        workspaceFolder: deps.workspaceFolder,
        lineStart: (input as { lineStart?: number }).lineStart,
        lineEnd: (input as { lineEnd?: number }).lineEnd,
        signal: context.signal,
      };

      try {
        const result: ReadFileResult = await reader.readFile(options);
        return result;
      } catch (error) {
        if (isToolError(error)) {
          throw error;
        }
        throw createToolError(
          ToolErrorCode.TOOL_EXECUTION_FAILED,
          `Tool 'read_file' execution failed`,
          { toolName: 'read_file', cause: error instanceof Error ? error : undefined }
        );
      }
    },
  };
}
