import { z } from 'zod';
import {
  createReferenceDiscoverer,
  type ReferenceConfig,
  defaultReferenceConfig,
  safeValidateReferenceConfig,
  type ReferenceDiscoveryOptions,
  type ReferenceDiscoveryResult,
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

export interface FindReferencesAdapterDependencies {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<ReferenceConfig>;
}

const ReferenceOccurrenceSchema = z.object({
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  lineNumber: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  matchedText: z.string(),
  classification: z.enum([
    'definition',
    'declaration',
    'usage',
    'import',
    'export',
    'call',
    'textual_match',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  language: z.enum([
    'javascript',
    'typescript',
    'python',
    'java',
    'csharp',
    'go',
    'rust',
    'cpp',
    'c',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'scala',
    'shell',
    'powershell',
    'sql',
    'html',
    'css',
    'json',
    'xml',
    'yaml',
    'markdown',
    'text',
  ]),
  symbol: z.string(),
  context: z.array(z.string()).optional(),
});

const ReferenceFileResultSchema = z.object({
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  language: z.enum([
    'javascript',
    'typescript',
    'python',
    'java',
    'csharp',
    'go',
    'rust',
    'cpp',
    'c',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'scala',
    'shell',
    'powershell',
    'sql',
    'html',
    'css',
    'json',
    'xml',
    'yaml',
    'markdown',
    'text',
  ]),
  references: z.array(ReferenceOccurrenceSchema),
  referenceCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skipped: z.boolean(),
  skipReason: z.enum([
    'binary',
    'sensitive',
    'tooLarge',
    'readError',
    'ignored',
    'unsupportedLanguage',
  ]).optional(),
});

const ReferenceDiscoveryMetadataSchema = z.object({
  filesExamined: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  totalReferences: z.number().int().nonnegative(),
  truncated: z.boolean(),
  limitReached: z.enum([
    'maxCandidateFiles',
    'maxFilesExamined',
    'maxTotalBytesRead',
    'maxReferencesPerFile',
    'maxTotalReferences',
    'maxOutputSize',
  ]).optional(),
  cancelled: z.boolean(),
  completed: z.boolean(),
});

const ReferenceDiscoveryOutputSchema = z.object({
  kind: z.literal('reference-discovery'),
  uri: z.string(),
  absolutePath: z.string(),
  relativePath: z.string(),
  symbol: z.string(),
  language: z.enum([
    'javascript',
    'typescript',
    'python',
    'java',
    'csharp',
    'go',
    'rust',
    'cpp',
    'c',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'scala',
    'shell',
    'powershell',
    'sql',
    'html',
    'css',
    'json',
    'xml',
    'yaml',
    'markdown',
    'text',
  ]).optional(),
  files: z.array(ReferenceFileResultSchema),
  metadata: ReferenceDiscoveryMetadataSchema,
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    isFatal: z.boolean(),
  })),
});

const ReferenceDiscoveryInputSchema = z.object({
  workspaceFolder: z.object({
    uri: z.string().min(1),
    id: z.string().min(1),
  }),
  symbol: z.string().min(1).max(256),
  classifications: z.array(z.enum([
    'definition',
    'declaration',
    'usage',
    'import',
    'export',
    'call',
    'textual_match',
  ])).optional(),
  languages: z.array(z.enum([
    'javascript',
    'typescript',
    'python',
    'java',
    'csharp',
    'go',
    'rust',
    'cpp',
    'c',
    'php',
    'ruby',
    'swift',
    'kotlin',
    'scala',
    'shell',
    'powershell',
    'sql',
    'html',
    'css',
    'json',
    'xml',
    'yaml',
    'markdown',
    'text',
  ])).optional(),
  includePatterns: z.array(z.string().min(1)).optional(),
  excludePatterns: z.array(z.string().min(1)).optional(),
  enableLexicalFallback: z.boolean().optional(),
});

export function createFindReferencesToolDefinition(
  deps: FindReferencesAdapterDependencies
): ToolDefinition {
  const configValidation = safeValidateReferenceConfig(deps.config ?? {});
  if (!configValidation.success) {
    throw createToolError(
      ToolErrorCode.TOOL_INVALID_ARGUMENTS,
      `Invalid reference config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
    );
  }
  const config: ReferenceConfig = { ...defaultReferenceConfig, ...configValidation.data };
  const discoverer = createReferenceDiscoverer({
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
    name: 'find_references',
    description: 'Find references to a symbol across workspace source files. Supports syntax-aware classification for JavaScript/TypeScript and lexical matching for other languages, with confidence levels, deduplication, and resource limits.',
    inputSchema: ReferenceDiscoveryInputSchema,
    outputSchema: ReferenceDiscoveryOutputSchema,
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: async (input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const executeImpl = async (): Promise<ReferenceDiscoveryResult> => {
        if (context.workspaceId && context.workspaceId !== computedWorkspaceId) {
          throw createToolError(
            ToolErrorCode.TOOL_RESOURCE_LIMIT,
            'Workspace identity mismatch: tool execution context does not match adapter workspace',
            { toolName: 'find_references' }
          );
        }

        const rawInput = input as {
          symbol: string;
          classifications?: string[];
          languages?: string[];
          includePatterns?: string[];
          excludePatterns?: string[];
          enableLexicalFallback?: boolean;
        };

        const options: ReferenceDiscoveryOptions = {
          workspaceFolder: deps.workspaceFolder,
          symbol: rawInput.symbol,
          classifications: rawInput.classifications as ReferenceDiscoveryOptions['classifications'],
          languages: rawInput.languages as ReferenceDiscoveryOptions['languages'],
          includePatterns: rawInput.includePatterns,
          excludePatterns: rawInput.excludePatterns,
          enableLexicalFallback: rawInput.enableLexicalFallback,
          signal: context.signal,
        };

        try {
          const result: ReferenceDiscoveryResult = await discoverer.find(options);
          return result;
        } catch (error) {
          if (isToolError(error)) {
            throw error;
          }
          throw createToolError(
            ToolErrorCode.TOOL_EXECUTION_FAILED,
            `Tool 'find_references' execution failed`,
            { toolName: 'find_references', cause: error instanceof Error ? error : undefined }
          );
        }
      };
      return executeImpl() as unknown as Promise<ToolExecutionResult>;
    },
  };
}