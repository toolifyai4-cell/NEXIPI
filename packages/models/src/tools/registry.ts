import { z } from 'zod';
import { ToolErrorCode, createToolError } from './errors.js';
import type { ToolDefinition, ModelToolDefinition, ToolMetadata } from './types.js';
import { validateModelToolDefinition, ToolMetadataSchema } from './schemas.js';

/**
 * Plain JSON Schema value used by the converter internals.
 *
 * Modeled without `any` so eslint's dataflow rules stay satisfied. The
 * `JsonSchemaValue` type exported from schemas.ts infers through
 * `z.ZodTypeAny` and collapses to `any`, so it is not used here directly.
 */
type ToolJsonSchema =
  | string
  | number
  | boolean
  | null
  | ToolJsonSchema[]
  | { [key: string]: ToolJsonSchema };

/**
 * Validates an internal executable tool definition before it is registered.
 *
 * Throws a descriptive Error for invalid definitions so callers cannot
 * register malformed tools. Validation happens before any state mutation, so
 * an invalid definition can never leave the registry partially populated.
 */
function validateToolDefinition(definition: unknown): asserts definition is ToolDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new Error('Tool definition must be a non-null object');
  }

  const d = definition as Record<string, unknown>;

  const name = d['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error("Tool definition must have a non-empty 'name'");
  }

  const description = d['description'];
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error("Tool definition must have a non-empty 'description'");
  }

  const inputSchema = d['inputSchema'];
  if (!(inputSchema instanceof z.ZodType)) {
    throw new Error("Tool definition 'inputSchema' must be a Zod schema");
  }

  const outputSchema = d['outputSchema'];
  if (outputSchema !== undefined && !(outputSchema instanceof z.ZodType)) {
    throw new Error("Tool definition 'outputSchema' must be a Zod schema when provided");
  }

  // Validates shape and throws a ZodError with a clear message on invalid metadata.
  ToolMetadataSchema.parse(d['metadata']);

  const execute = d['execute'];
  if (typeof execute !== 'function') {
    throw new Error("Tool definition 'execute' must be a function");
  }
}

/**
 * Converts a Zod schema into a plain JSON Schema value.
 *
 * The result contains only JSON-compatible values (objects, arrays, strings,
 * numbers, booleans, null), so it is safe to send to model providers.
 * Recursive schemas are guarded by a `seen` set; anything not recognised is
 * converted to an empty schema `{}` rather than thrown away or guessed at.
 * The produced value is validated by `validateModelToolDefinition` before it
 * leaves the registry.
 */
function toJsonSchema(schema: unknown, seen = new WeakSet<object>()): ToolJsonSchema {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) {
    return {};
  }
  seen.add(schema);

  const record = schema as Record<string, unknown>;
  const def = record['_def'] as Record<string, unknown> | undefined;
  const typeName = def === undefined ? undefined : def['typeName'];
  const description =
    def === undefined ? undefined : typeof def['description'] === 'string' ? def['description'] : undefined;

  const withDescription = (schema: Record<string, unknown>): ToolJsonSchema =>
    description === undefined
      ? (schema as ToolJsonSchema)
      : ({ ...schema, description } as ToolJsonSchema);

  switch (typeName) {
    case 'ZodString':
      return withDescription({ type: 'string' });
    case 'ZodNumber':
      return withDescription({ type: 'number' });
    case 'ZodInteger':
      return withDescription({ type: 'integer' });
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodNull':
      return withDescription({ type: 'null' });
    case 'ZodEnum': {
      const values = def === undefined ? undefined : def['values'];
      return withDescription({
        type: 'string',
        enum: Array.isArray(values) ? (values as unknown as ToolJsonSchema[]) : [],
      });
    }
    case 'ZodObject': {
      // Read the shape from the public schema instance. In this Zod version
      // `_def.shape` is not the plain shape object, so use `schema.shape`.
      const shape = record['shape'] as Record<string, unknown> | undefined;
      const properties: Record<string, ToolJsonSchema> = {};
      const required: string[] = [];
      if (shape) {
        for (const [key, fieldSchema] of Object.entries(shape)) {
          properties[key] = toJsonSchema(fieldSchema, seen);
          const fieldRecord = fieldSchema as Record<string, unknown>;
          const fieldDef = fieldRecord['_def'] as Record<string, unknown> | undefined;
          const fieldTypeName = fieldDef === undefined ? undefined : fieldDef['typeName'];
          if (fieldTypeName !== 'ZodOptional' && fieldTypeName !== 'ZodNullable') {
            required.push(key);
          }
        }
      }
      const result: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) {
        result['required'] = required;
      }
      return withDescription(result);
    }
    case 'ZodArray': {
      // Read the element from the public schema instance. In this Zod version
      // the array element lives under `schema.element`, not `_def.element`.
      const element = record['element'];
      return withDescription({
        type: 'array',
        items: element === undefined ? {} : toJsonSchema(element, seen),
      });
    }
    case 'ZodRecord': {
      const valueSchema = def === undefined ? undefined : def['valueSchema'];
      return withDescription({
        type: 'object',
        additionalProperties: valueSchema === undefined ? {} : toJsonSchema(valueSchema as unknown, seen),
      });
    }
    case 'ZodOptional': {
      const inner = def === undefined ? undefined : def['innerType'];
      return inner === undefined ? {} : toJsonSchema(inner, seen);
    }
    case 'ZodNullable': {
      const inner = def === undefined ? undefined : def['innerType'];
      return {
        anyOf: [inner === undefined ? {} : toJsonSchema(inner, seen), { type: 'null' }],
      };
    }
    case 'ZodDefault': {
      const inner = def === undefined ? undefined : def['innerType'];
      return inner === undefined ? {} : toJsonSchema(inner, seen);
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def === undefined ? undefined : def['options'];
      return withDescription({
        anyOf: Array.isArray(options)
          ? options.map((option) => toJsonSchema(option as unknown, seen))
          : [{}],
      });
    }
    case 'ZodLazy': {
      const getter = def === undefined ? undefined : def['getter'];
      return typeof getter === 'function' ? toJsonSchema((getter as () => unknown)(), seen) : {};
    }
    case 'ZodEffects':
    case 'ZodProcessor': {
      const inner = def === undefined ? undefined : def['schema'];
      return inner === undefined ? {} : toJsonSchema(inner, seen);
    }
    default:
      return {};
  }
}

/**
 * Creates a registry-owned frozen copy of a tool definition.
 *
 * Registration must not mutate or freeze caller-owned objects. Instead the
 * registry builds its own authoritative copy:
 *  - a new top-level `ToolDefinition` object
 *  - a separate `metadata` object (copy of all fields)
 *  - a separate `capabilities` array when present
 *
 * Zod schema instances and the `execute` function remain shared references
 * (immutable-by-convention); they are not cloned or frozen.
 *
 * The returned copy is shallowly frozen so callers cannot mutate the
 * registry's authoritative state through references returned by `get()`
 * or `list()`. The original definition, its metadata, and its capabilities
 * array supplied by the caller remain untouched and mutable.
 *
 * @returns a new frozen `ToolDefinition` owned by the registry; the caller's
 * object is not modified.
 */
function cloneAndFreezeDefinition(definition: ToolDefinition): ToolDefinition {
  const metadata = definition.metadata;
  const metadataCopy: ToolMetadata = {
    capabilities: Array.isArray(metadata.capabilities) ? [...metadata.capabilities] : metadata.capabilities,
    readOnly: metadata.readOnly,
    destructive: metadata.destructive,
    requiresWorkspace: metadata.requiresWorkspace,
    idempotent: metadata.idempotent,
    version: metadata.version,
  };

  if (!Object.isFrozen(metadataCopy.capabilities)) {
    Object.freeze(metadataCopy.capabilities);
  }
  if (!Object.isFrozen(metadataCopy)) {
    Object.freeze(metadataCopy);
  }

  const copy: ToolDefinition = {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema !== undefined
      ? { outputSchema: definition.outputSchema }
      : {}),
    metadata: metadataCopy,
    // eslint-disable-next-line @typescript-eslint/unbound-method
    execute: definition.execute,
  };

  if (!Object.isFrozen(copy)) {
    Object.freeze(copy);
  }

  return copy;
}

/**
 * Registry for internal executable ToolDefinition objects.
 *
 * The registry owns the canonical set of tools that may be executed. It stores
 * internal executable definitions (including Zod schemas, execute functions
 * and permission metadata) and never exposes them directly to model providers.
 *
 * Registration creates a registry-owned frozen copy of the supplied
 * definition (new top-level object, separate metadata object, separate
 * capabilities array). The caller's original definition, metadata, and
 * capabilities array are never mutated or frozen. Zod schema instances and
 * the `execute` function remain shared references treated as
 * immutable-by-convention.
 *
 * `get()` returns the frozen registry-owned reference; `list()` returns a
 * shallow copy of frozen references. Zod schemas and the execute function
 * remain shared references owned by the tool author.
 *
 * Listing order is deterministic: it follows registration (insertion) order.
 *
 * No persistence or global singleton state is introduced. Instances are created
 * with `new ToolRegistry()` or `createToolRegistry()` and passed explicitly to
 * consumers such as ToolExecutor.
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a tool definition.
   *
   * The definition is validated before any mutation. Duplicate names are
   * rejected with a descriptive Error; there is no implicit replacement.
   *
   * @throws Error when the definition is invalid or a tool with the same name
   * is already registered.
   */
  register(definition: ToolDefinition): void {
    validateToolDefinition(definition);
    const copy = cloneAndFreezeDefinition(definition);

    if (this.tools.has(copy.name)) {
      throw new Error(`Tool with name '${copy.name}' is already registered`);
    }

    this.tools.set(copy.name, copy);
  }

  /**
   * Unregister a tool by name.
   *
   * Returns true when a tool was removed, false when no tool with that name
   * was registered. Calling unregister on an unknown name is a no-op and
   * returns false.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Retrieve a registered tool by name.
   *
   * @throws ToolError with code TOOL_NOT_FOUND when no tool is registered
   * under the given name.
   */
  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw createToolError(ToolErrorCode.TOOL_NOT_FOUND, `Tool '${name}' is not registered`, {
        toolName: name,
      });
    }
    return tool;
  }

  /**
   * Check whether a tool with the given name is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered tools in deterministic registration order.
   *
   * Returns a shallow copy of the internal collection; mutating the returned
   * array does not affect the registry.
   */
  list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Produce provider-facing ModelToolDefinition descriptions from registered
   * tools.
   *
   * Each description contains only `name`, `description` and JSON Schema
   * `parameters`. Zod schema objects, execute functions, permission policies
   * and internal metadata are never included. Every produced description is
   * validated against the Substage 1 ModelToolDefinitionSchema before being
   * returned.
   *
   * Returns a shallow copy; the order matches registration order.
   */
  listDescriptions(): readonly ModelToolDefinition[] {
    return Array.from(this.tools.values()).map((definition) => {
      const description = {
        name: definition.name,
        description: definition.description,
        parameters: toJsonSchema(definition.inputSchema as unknown),
      };
      return validateModelToolDefinition(description);
    });
  }
}

/**
 * Create a new ToolRegistry instance.
 *
 * Preferred over direct construction for symmetry with other registry
 * factories in the codebase. No global singleton is created.
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
