import { z } from 'zod';

/**
 * Configuration for the reference-discovery tool.
 *
 * Defaults are conservative so a single reference-discovery query cannot load
 * an arbitrarily large workspace into memory or return an unbounded result set.
 * No parser timeout is configured: a synchronous parser cannot be interrupted
 * merely by checking an AbortSignal or starting a timer, so such a setting
 * could not be genuinely enforced.
 */
export const ReferenceConfigSchema = z.object({
  /** Maximum length of the symbol being searched for. */
  maxSymbolLength: z.number().int().positive().default(256),
  /** Maximum number of candidate files examined in a single query. */
  maxFilesExamined: z.number().int().positive().default(1000),
  /** Maximum individual file size in bytes that may be read (pre-read stat). */
  maxFileSize: z.number().int().positive().default(1024 * 1024),
  /** Maximum total bytes read across all candidate files. */
  maxTotalBytesRead: z.number().int().positive().default(10 * 1024 * 1024),
  /** Maximum number of references returned from any single file. */
  maxReferencesPerFile: z.number().int().positive().default(100),
  /** Maximum total number of references returned across all files. */
  maxTotalReferences: z.number().int().positive().default(1000),
  /** Maximum total size of the returned result payload. */
  maxOutputSize: z.number().int().positive().default(512 * 1024),
  /** Languages for which syntax-aware classification is supported. */
  supportedSyntaxAwareLanguages: z
    .array(z.string())
    .default(['javascript', 'typescript']),
  /** Whether to fall back to lexical identifier matching when parsing is unavailable. */
  enableLexicalFallback: z.boolean().default(true),
});

export type ReferenceConfig = z.infer<typeof ReferenceConfigSchema>;

export const defaultReferenceConfig: ReferenceConfig = {
  maxSymbolLength: 256,
  maxFilesExamined: 1000,
  maxFileSize: 1024 * 1024,
  maxTotalBytesRead: 10 * 1024 * 1024,
  maxReferencesPerFile: 100,
  maxTotalReferences: 1000,
  maxOutputSize: 512 * 1024,
  supportedSyntaxAwareLanguages: ['javascript', 'typescript'],
  enableLexicalFallback: true,
};

export function validateReferenceConfig(config: unknown): ReferenceConfig {
  return ReferenceConfigSchema.parse(config);
}

export function safeValidateReferenceConfig(
  config: unknown
): { success: true; data: ReferenceConfig } | { success: false; error: z.ZodError } {
  const result = ReferenceConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
