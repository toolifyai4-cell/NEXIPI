import { z } from 'zod';

export const ReadFileInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export const ListDirectoryInputSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  maxEntries: z.number().int().positive().optional(),
  filterByType: z.enum(['file', 'directory', 'all']).optional(),
  includePatterns: z.array(z.string().min(1)).optional(),
});

export type ListDirectoryInput = z.infer<typeof ListDirectoryInputSchema>;

export function validateReadFileInput(input: unknown): ReadFileInput {
  return ReadFileInputSchema.parse(input);
}

export function safeValidateReadFileInput(
  input: unknown
): { success: true; data: ReadFileInput } | { success: false; error: z.ZodError } {
  const result = ReadFileInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function validateListDirectoryInput(input: unknown): ListDirectoryInput {
  return ListDirectoryInputSchema.parse(input);
}

export function safeValidateListDirectoryInput(
  input: unknown
): { success: true; data: ListDirectoryInput } | { success: false; error: z.ZodError } {
  const result = ListDirectoryInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
