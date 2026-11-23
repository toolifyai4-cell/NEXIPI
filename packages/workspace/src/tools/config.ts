import { z } from 'zod';

/**
 * Configuration for the file-reading tool.
 *
 * Defaults are conservative so a single read cannot load an arbitrarily large
 * file into memory or return an unbounded string.
 */
export const FileReadConfigSchema = z.object({
  /** Maximum file size in bytes that may be read (pre-read stat check). */
  maxFileSize: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  /** Maximum number of bytes of content returned to the caller. */
  maxOutputSize: z
    .number()
    .int()
    .positive()
    .default(512 * 1024),
  /** Maximum number of lines the file may contain before reading is rejected. */
  maxLineCount: z.number().int().positive().default(10000),
  /** Whether to inspect content for binary indicators after reading. */
  enableBinaryDetection: z.boolean().default(true),
  /** Whether to apply IgnoreEngine exclusions before reading. */
  respectIgnoreRules: z.boolean().default(true),
  /** Whether to reject sensitive files (credentials, keys, etc.). */
  respectSensitiveFiles: z.boolean().default(true),
  /** Whether symbolic links may be followed when reading. Defaults to false. */
  followSymlinks: z.boolean().default(false),
});

export type FileReadConfig = z.infer<typeof FileReadConfigSchema>;

export const defaultFileReadConfig: FileReadConfig = {
  maxFileSize: 1024 * 1024,
  maxOutputSize: 512 * 1024,
  maxLineCount: 10000,
  enableBinaryDetection: true,
  respectIgnoreRules: true,
  respectSensitiveFiles: true,
  followSymlinks: false,
};

export function validateFileReadConfig(config: unknown): FileReadConfig {
  return FileReadConfigSchema.parse(config);
}

export function safeValidateFileReadConfig(
  config: unknown
): { success: true; data: FileReadConfig } | { success: false; error: z.ZodError } {
  const result = FileReadConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Configuration for the directory-listing tool.
 */
export const DirectoryListConfigSchema = z.object({
  /** Maximum recursion depth. 0 means list only the target directory's entries. */
  maxDepth: z.number().int().nonnegative().default(1),
  /** Maximum total number of entries returned. */
  maxEntries: z.number().int().positive().default(10000),
  /** Whether to recurse into subdirectories. */
  recursive: z.boolean().default(false),
  /** Whether to include hidden files/directories (leading dot). */
  includeHidden: z.boolean().default(false),
  /** Whether to follow symbolic links. Defaults to false. */
  followSymlinks: z.boolean().default(false),
  /** Whether to apply IgnoreEngine exclusions. */
  respectIgnoreRules: z.boolean().default(true),
  /** Whether to exclude sensitive files from results. */
  respectSensitiveFiles: z.boolean().default(true),
});

export type DirectoryListConfig = z.infer<typeof DirectoryListConfigSchema>;

export const defaultDirectoryListConfig: DirectoryListConfig = {
  maxDepth: 1,
  maxEntries: 10000,
  recursive: false,
  includeHidden: false,
  followSymlinks: false,
  respectIgnoreRules: true,
  respectSensitiveFiles: true,
};

export function validateDirectoryListConfig(config: unknown): DirectoryListConfig {
  return DirectoryListConfigSchema.parse(config);
}

export function safeValidateDirectoryListConfig(
  config: unknown
): { success: true; data: DirectoryListConfig } | { success: false; error: z.ZodError } {
  const result = DirectoryListConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
