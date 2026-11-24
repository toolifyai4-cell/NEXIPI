import { z } from 'zod';
import {
  createCodeSearcher,
  type CodeSearchConfig,
  defaultCodeSearchConfig,
  safeValidateCodeSearchConfig,
  type CodeSearchOptions,
  type CodeSearchResult,
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

export interface SearchCodeAdapterDependencies {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<CodeSearchConfig>;
}

const SearchMatchSchema = z.object({
  lineNumber: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  matchedText: z.string(),
  context: z.array(z.object({
    lineNumber: z.number().int().positive(),
    text: z.string(),
  })).optional(),
});

const SearchFileResultSchema = z.object({
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  matches: z.array(SearchMatchSchema),
  matchCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skipped: z.boolean(),
  skipReason: z.enum(['binary', 'sensitive', 'tooLarge', 'readError', 'ignored']).optional(),
});

const CodeSearchOutputSchema = z.object({
  kind: z.literal('search'),
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  mode: z.enum(['literal', 'regex']),
  query: z.string(),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  files: z.array(SearchFileResultSchema),
  filesSearched: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  limitReached: z.enum(['maxCandidateFiles', 'maxTotalBytesRead', 'maxTotalResults', 'maxOutputSize']).optional(),
  cancelled: z.boolean(),
  completed: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    isFatal: z.boolean(),
  })),
});

const CodeSearchInputSchema = z.object({
  workspaceFolder: z.object({
    uri: z.string().min(1),
    id: z.string().min(1),
  }),
  query: z.string().min(1),
  mode: z.enum(['literal', 'regex']),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  contextLines: z.number().int().nonnegative().optional(),
  includePatterns: z.array(z.string().min(1)).optional(),
  excludePatterns: z.array(z.string().min(1)).optional(),
});

export function createSearchCodeToolDefinition(
  deps: SearchCodeAdapterDependencies
): ToolDefinition {
  const configValidation = safeValidateCodeSearchConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid search config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: CodeSearchConfig = { ...defaultCodeSearchConfig, ...configValidation.data };
  const searcher = createCodeSearcher({
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
    name: 'search_code',
    description: 'Search for text or regex patterns across workspace source files. Supports literal and safely constrained regex modes, respects workspace boundaries, ignore rules, and sensitive/binary file protections.',
    inputSchema: CodeSearchInputSchema,
    outputSchema: CodeSearchOutputSchema,
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const parsed = CodeSearchInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          kind: 'failure',
          error: createToolError(
            ToolErrorCode.TOOL_INVALID_ARGUMENTS,
            `Invalid input for tool 'search_code': ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            { toolName: 'search_code' }
          ),
          truncated: false,
          executionMs: 0,
        };
      }

      if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
        return {
          kind: 'failure',
          error: createToolError(
            ToolErrorCode.TOOL_RESOURCE_LIMIT,
            'Workspace identity mismatch: tool execution context does not match adapter workspace',
            { toolName: 'search_code' }
          ),
          truncated: false,
          executionMs: 0,
        };
      }

      const options: CodeSearchOptions = {
        workspaceFolder: deps.workspaceFolder,
        query: parsed.data.query,
        mode: parsed.data.mode,
        caseSensitive: parsed.data.caseSensitive,
        wholeWord: parsed.data.wholeWord,
        contextLines: parsed.data.contextLines,
        includePatterns: parsed.data.includePatterns,
        excludePatterns: parsed.data.excludePatterns,
        signal: context.signal,
      };

      try {
        const result: CodeSearchResult = await searcher.search(options);
        return {
          kind: 'success',
          output: result,
          truncated: result.truncated,
          executionMs: 0,
        };
      } catch (error) {
        if (isToolError(error)) {
          return {
            kind: 'failure',
            error: createToolError(error.code, error.message, {
              toolName: 'search_code',
              cause: error.cause,
              context: error.context,
              retryable: error.retryable,
            }),
            truncated: false,
            executionMs: 0,
          };
        }
        return {
          kind: 'failure',
          error: createToolError(
            ToolErrorCode.TOOL_EXECUTION_FAILED,
            `Tool 'search_code' execution failed`,
            { toolName: 'search_code', cause: error instanceof Error ? error : undefined }
          ),
          truncated: false,
          executionMs: 0,
        };
      }
    },
  };
}