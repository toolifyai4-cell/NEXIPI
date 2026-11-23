import { z } from 'zod';

export const CodeSearchInputSchema = z.object({
  query: z.string().min(1, 'query is required'),
  mode: z.enum(['literal', 'regex']),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  contextLines: z.number().int().nonnegative().optional(),
  includePatterns: z.array(z.string().min(1)).optional(),
  excludePatterns: z.array(z.string().min(1)).optional(),
});

export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>;

export function validateCodeSearchInput(input: unknown): CodeSearchInput {
  return CodeSearchInputSchema.parse(input);
}

export function safeValidateCodeSearchInput(
  input: unknown
): { success: true; data: CodeSearchInput } | { success: false; error: z.ZodError } {
  const result = CodeSearchInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
