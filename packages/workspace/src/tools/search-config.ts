import { z } from 'zod';

/**
 * Configuration for the code-search tool.
 *
 * Defaults are conservative so a single search cannot load an arbitrarily
 * large workspace into memory or return an unbounded result set. Limits are
 * enforced during processing, not only after building a result array.
 */
export const CodeSearchConfigSchema = z.object({
  /** Maximum length of the search query (literal text or regex pattern). */
  maxQueryLength: z.number().int().positive().default(1024),
  /** Maximum number of candidate files considered in a single search. */
  maxCandidateFiles: z.number().int().positive().default(1000),
  /** Maximum individual file size in bytes that may be read (pre-read stat). */
  maxFileSize: z.number().int().positive().default(1024 * 1024),
  /** Maximum total bytes read across all candidate files. */
  maxTotalBytesRead: z.number().int().positive().default(10 * 1024 * 1024),
  /** Maximum number of matches returned from any single file. */
  maxMatchesPerFile: z.number().int().positive().default(100),
  /** Maximum total number of matches returned across all files. */
  maxTotalResults: z.number().int().positive().default(1000),
  /** Maximum number of context lines around each match. */
  maxContextLines: z.number().int().nonnegative().default(10),
  /** Maximum length of a single line searched; longer lines are truncated. */
  maxLineLength: z.number().int().positive().default(10000),
  /** Maximum total size of the returned result payload. */
  maxOutputSize: z.number().int().positive().default(512 * 1024),
  /** Whether to apply IgnoreEngine exclusions (.gitignore and safety rules). */
  respectIgnoreRules: z.boolean().default(true),
  /** Whether to reject sensitive files (credentials, keys, etc.). */
  respectSensitiveFiles: z.boolean().default(true),
  /** Whether to exclude binary files. */
  respectBinaryFiles: z.boolean().default(true),
});

export type CodeSearchConfig = z.infer<typeof CodeSearchConfigSchema>;

export const defaultCodeSearchConfig: CodeSearchConfig = {
  maxQueryLength: 1024,
  maxCandidateFiles: 1000,
  maxFileSize: 1024 * 1024,
  maxTotalBytesRead: 10 * 1024 * 1024,
  maxMatchesPerFile: 100,
  maxTotalResults: 1000,
  maxContextLines: 10,
  maxLineLength: 10000,
  maxOutputSize: 512 * 1024,
  respectIgnoreRules: true,
  respectSensitiveFiles: true,
  respectBinaryFiles: true,
};

export function validateCodeSearchConfig(config: unknown): CodeSearchConfig {
  return CodeSearchConfigSchema.parse(config);
}

export function safeValidateCodeSearchConfig(
  config: unknown
): { success: true; data: CodeSearchConfig } | { success: false; error: z.ZodError } {
  const result = CodeSearchConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
