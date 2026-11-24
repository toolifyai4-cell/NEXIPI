import { z, type ZodTypeAny } from 'zod';

export const ToolCapabilitySchema = z.enum(['read', 'write', 'execute', 'external']);

export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * JSON-compatible schema value for provider-facing tool parameters.
 *
 * Structurally excludes functions and class instances (including Zod schema
 * objects), so it is a guarantee that a ModelToolDefinition carries no
 * executable logic.
 */
const JsonSchemaValueSchemaInternal: ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchemaValueSchemaInternal),
    z.record(JsonSchemaValueSchemaInternal),
  ])
);

export const JsonSchemaValueSchema: ZodTypeAny = JsonSchemaValueSchemaInternal;
export type JsonSchemaValue = z.infer<typeof JsonSchemaValueSchema>;

export const ToolMetadataSchema = z.object({
  capabilities: z.array(ToolCapabilitySchema),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  requiresWorkspace: z.boolean(),
  idempotent: z.boolean(),
  version: z.string().min(1),
});

export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

export const ModelToolDefinitionSchema = z.object({
  name: z.string().min(1, 'Tool name is required'),
  description: z.string().min(1, 'Tool description is required'),
  parameters: JsonSchemaValueSchema,
});

export type ModelToolDefinition = z.infer<typeof ModelToolDefinitionSchema>;

export function validateModelToolDefinition(input: unknown): ModelToolDefinition {
  return ModelToolDefinitionSchema.parse(input);
}

export function safeValidateModelToolDefinition(
  input: unknown
): { success: true; data: ModelToolDefinition } | { success: false; error: z.ZodError } {
  const result = ModelToolDefinitionSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
