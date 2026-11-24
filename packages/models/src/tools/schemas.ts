import { z, type ZodTypeAny } from 'zod';

export const ToolCapabilitySchema = z.enum(['read', 'write', 'execute', 'external']);

export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * JSON-compatible schema value for provider-facing tool parameters.
 *
 * Structurally excludes functions and class instances (including Zod schema
 * objects), so it is a guarantee that a ModelToolDefinition carries no
 * executable logic. Also excludes non-finite numbers (Infinity, NaN, -Infinity).
 * Cyclic references are rejected to prevent unbounded recursion during validation.
 *
 * Validation bounds (conservative limits for model tool arguments):
 * - MAX_DEPTH: 1000 - maximum nesting depth
 * - MAX_NODES: 10000 - maximum total objects/arrays visited
 */
const MAX_DEPTH = 1000;
const MAX_NODES = 10000;

interface TraversalState {
  visiting: WeakSet<object>;
  visited: WeakSet<object>;
  nodeCount: number;
  maxDepthExceeded: boolean;
}

function checkCyclesAndBounds(value: unknown): { hasCycle: boolean; depthExceeded: boolean; nodeLimitExceeded: boolean } {
  const state: TraversalState = {
    visiting: new WeakSet<object>(),
    visited: new WeakSet<object>(),
    nodeCount: 0,
    maxDepthExceeded: false,
  };

  // Iterative DFS using explicit stack to avoid call stack overflow
  // Stack entries: [value, depth, iteratorState]
  // iteratorState: { type: 'object', keys: string[], index: number } | { type: 'array', index: number } | null
  type StackEntry = [unknown, number, { type: 'array'; index: number; length: number } | { type: 'object'; keys: string[]; index: number; length: number } | null];
  const stack: StackEntry[] = [[value, 0, null]];

  while (stack.length > 0) {
    const entry = stack[stack.length - 1];
    if (!entry) break;
    const [v, depth, iteratorState] = entry;

    // Check depth limit
    if (depth > MAX_DEPTH) {
      state.maxDepthExceeded = true;
      return { hasCycle: false, depthExceeded: true, nodeLimitExceeded: false };
    }

    // Check node limit
    if (state.nodeCount > MAX_NODES) {
      return { hasCycle: false, depthExceeded: false, nodeLimitExceeded: true };
    }

    if (v === null || typeof v !== 'object') {
      stack.pop();
      continue;
    }

    // First time visiting this node
    if (!iteratorState) {
      // Check for cycle
      if (state.visiting.has(v)) {
        return { hasCycle: true, depthExceeded: false, nodeLimitExceeded: false };
      }
      if (state.visited.has(v)) {
        stack.pop();
        continue;
      }

      state.visiting.add(v);
      state.nodeCount++;

      // Initialize iterator state
      if (Array.isArray(v)) {
        entry[2] = { type: 'array', index: 0, length: v.length };
      } else {
        const keys = Object.keys(v);
        entry[2] = { type: 'object', keys, index: 0, length: keys.length };
      }
      continue;
    }

    // Continue iteration
    if (iteratorState.type === 'array') {
      const arrState = iteratorState as { type: 'array'; index: number; length: number };
      if (arrState.index >= arrState.length) {
        // Done with this array
        state.visiting.delete(v);
        state.visited.add(v);
        stack.pop();
        continue;
      }
      const arr = v as unknown[];
      const child = arr[arrState.index];
      arrState.index++;
      stack.push([child, depth + 1, null]);
    } else {
      // object
      const objState = iteratorState as { type: 'object'; keys: string[]; index: number; length: number };
      if (objState.index >= objState.length) {
        // Done with this object
        state.visiting.delete(v);
        state.visited.add(v);
        stack.pop();
        continue;
      }
      const key = objState.keys[objState.index]!;
      objState.index++;
      const obj = v as Record<string, unknown>;
      const child = obj[key];
      stack.push([child, depth + 1, null]);
    }
  }

  return { hasCycle: false, depthExceeded: false, nodeLimitExceeded: false };
}

function validateJsonSchemaValue(value: unknown): string | null {
  const { hasCycle, depthExceeded, nodeLimitExceeded } = checkCyclesAndBounds(value);
  if (hasCycle) {
    return 'Cyclic references are not allowed in JSON schema values';
  }
  if (depthExceeded) {
    return `JSON schema value exceeds maximum nesting depth of ${MAX_DEPTH}`;
  }
  if (nodeLimitExceeded) {
    return `JSON schema value exceeds maximum node count of ${MAX_NODES}`;
  }
  return null;
}

const JsonSchemaValueSchemaInternal: ZodTypeAny = z
  .unknown()
  .refine(
    (v: unknown) => validateJsonSchemaValue(v) === null,
    (v) => ({ message: validateJsonSchemaValue(v) ?? 'Invalid JSON schema value' })
  )
  .pipe(
    z.lazy(() =>
      z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(JsonSchemaValueSchemaInternal),
        z.record(JsonSchemaValueSchemaInternal),
      ])
    )
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
