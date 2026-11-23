import { z } from 'zod';

/** Maximum symbol length, aligned with defaultReferenceConfig.maxSymbolLength. */
const MAX_SYMBOL_LENGTH = 256;

const ReferenceClassificationSchema = z.enum([
  'definition',
  'declaration',
  'usage',
  'import',
  'export',
  'call',
  'textual_match',
]);

const ReferenceLanguageSchema = z.enum([
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
]);

export const ReferenceDiscoveryInputSchema = z.object({
  /** Non-empty symbol, bounded to a reasonable maximum length. */
  symbol: z.string().min(1, 'symbol is required').max(MAX_SYMBOL_LENGTH, 'symbol is too long'),
  /** Optional classification filters; invalid classifications are rejected. */
  classifications: z.array(ReferenceClassificationSchema).optional(),
  /** Optional language filters; invalid languages are rejected. */
  languages: z.array(ReferenceLanguageSchema).optional(),
  /** Include patterns, each non-empty. */
  includePatterns: z.array(z.string().min(1)).optional(),
  /** Exclude patterns, each non-empty. */
  excludePatterns: z.array(z.string().min(1)).optional(),
  /** Bounded numeric limits. */
  maxFilesExamined: z.number().int().positive().optional(),
  maxTotalBytesRead: z.number().int().positive().optional(),
  maxReferencesPerFile: z.number().int().positive().optional(),
  maxTotalReferences: z.number().int().positive().optional(),
  maxOutputSize: z.number().int().positive().optional(),
  enableLexicalFallback: z.boolean().optional(),
});

export type ReferenceDiscoveryInput = z.infer<typeof ReferenceDiscoveryInputSchema>;

export function validateReferenceDiscoveryInput(input: unknown): ReferenceDiscoveryInput {
  return ReferenceDiscoveryInputSchema.parse(input);
}

export function safeValidateReferenceDiscoveryInput(
  input: unknown
): { success: true; data: ReferenceDiscoveryInput } | { success: false; error: z.ZodError } {
  const result = ReferenceDiscoveryInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
