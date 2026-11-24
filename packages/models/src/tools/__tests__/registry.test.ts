import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, createToolRegistry } from '../registry.js';
import { ToolExecutor } from '../executor.js';
import {
  ToolErrorCode,
  ToolError,
  isToolErrorCode,
} from '../errors.js';
import { validateModelToolDefinition, type ModelToolDefinition } from '../schemas.js';
import type { ToolDefinition, ToolExecutionContext } from '../types.js';
import { createNoopLogger } from '@nexipi/core';

function makeDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a file from the workspace',
    inputSchema: z.object({ uri: z.string() }),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    },
    execute: vi.fn().mockResolvedValue({
      kind: 'success',
      output: 'contents',
      truncated: false,
      executionMs: 0,
    }),
    ...overrides,
  };
}

function makeContext(): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceId: 'ws_1',
    workspaceFolder: undefined,
    logger: createNoopLogger(),
  };
}

describe('ToolRegistry', () => {
  describe('createToolRegistry', () => {
    it('should create an empty registry', () => {
      const registry = createToolRegistry();
      expect(registry.list()).toHaveLength(0);
      expect(registry.has('anything')).toBe(false);
    });
  });

  describe('register', () => {
    it('should register a valid tool definition', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      expect(() => registry.register(definition)).not.toThrow();
      expect(registry.has('read_file')).toBe(true);
      expect(registry.get('read_file')).toEqual(definition);
      // The caller's original object is not the stored reference.
      expect(registry.get('read_file')).not.toBe(definition);
    });

    it('should reject duplicate registrations', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      expect(() => registry.register(makeDefinition({ name: 'read_file' }))).toThrow(
        /already registered/
      );
      expect(() => registry.register(definition)).toThrow(/already registered/);
      // The original registration is intact.
      expect(registry.get('read_file')).toEqual(definition);
    });

    it('should reject invalid tool definitions', () => {
      const registry = new ToolRegistry();

      expect(() => registry.register(null as unknown as ToolDefinition)).toThrow();
      expect(() => registry.register({} as unknown as ToolDefinition)).toThrow();
      expect(() =>
        registry.register(makeDefinition({ name: '' }))
      ).toThrow(/non-empty 'name'/);
      expect(() =>
        registry.register(makeDefinition({ description: '' }))
      ).toThrow(/non-empty 'description'/);
      expect(() =>
        registry.register(makeDefinition({ inputSchema: {} as unknown as typeof z.ZodTypeAny }))
      ).toThrow(/inputSchema/);
      expect(() =>
        registry.register(makeDefinition({ outputSchema: {} as unknown as typeof z.ZodTypeAny }))
      ).toThrow(/outputSchema/);
      expect(() =>
        registry.register(
          makeDefinition({ metadata: { capabilities: ['delete'] as const, readOnly: true, destructive: false, requiresWorkspace: false, idempotent: false, version: '1.0.0' } })
        )
      ).toThrow();
      expect(() =>
        registry.register(makeDefinition({ execute: undefined as unknown as never }))
      ).toThrow(/execute/);
    });
  });

  describe('unregister', () => {
    it('should remove a registered tool', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());
      expect(registry.unregister('read_file')).toBe(true);
      expect(registry.has('read_file')).toBe(false);
      expect(() => registry.get('read_file')).toThrow();
    });

    it('should return false when unregistering an unknown tool', () => {
      const registry = new ToolRegistry();
      expect(registry.unregister('missing')).toBe(false);
      expect(registry.unregister('missing')).toBe(false);
    });

    it('should allow re-registration after unregistration', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());
      registry.unregister('read_file');
      expect(() => registry.register(makeDefinition())).not.toThrow();
      expect(registry.list()).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('should return an existing tool', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);
      expect(registry.get('read_file')).toEqual(definition);
      expect(registry.get('read_file')).not.toBe(definition);
    });

    it('should throw TOOL_NOT_FOUND for a missing tool', () => {
      const registry = new ToolRegistry();
      try {
        registry.get('missing_tool');
        throw new Error('expected to throw');
      } catch (error) {
        expect(isToolErrorCode(error, ToolErrorCode.TOOL_NOT_FOUND)).toBe(true);
        expect(error).toBeInstanceOf(ToolError);
        if (error instanceof ToolError) {
          expect(error.toolName).toBe('missing_tool');
        }
      }
    });
  });

  describe('has', () => {
    it('should report existence accurately', () => {
      const registry = new ToolRegistry();
      expect(registry.has('read_file')).toBe(false);
      registry.register(makeDefinition());
      expect(registry.has('read_file')).toBe(true);
      registry.unregister('read_file');
      expect(registry.has('read_file')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return an empty list for an empty registry', () => {
      expect(new ToolRegistry().list()).toEqual([]);
    });

    it('should preserve deterministic registration order', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition({ name: 'b_tool' }));
      registry.register(makeDefinition({ name: 'a_tool' }));
      registry.register(makeDefinition({ name: 'c_tool' }));

      expect(registry.list().map(tool => tool.name)).toEqual(['b_tool', 'a_tool', 'c_tool']);

      registry.unregister('a_tool');
      registry.register(makeDefinition({ name: 'd_tool' }));

      expect(registry.list().map(tool => tool.name)).toEqual(['b_tool', 'c_tool', 'd_tool']);
    });

    it('should return a copy so external mutation cannot change registry state', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());
      const list = registry.list();
      list.push(makeDefinition({ name: 'intruder' }));
      expect(registry.list()).toHaveLength(1);
      expect(registry.has('intruder')).toBe(false);
    });
  });

  describe('immutability', () => {
    it('should leave the caller-owned definition unfrozen after registration', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      expect(Object.isFrozen(definition)).toBe(false);
      expect(() => {
        (definition as Record<string, unknown>).name = 'mutated';
      }).not.toThrow();
      expect(definition.name).toBe('mutated');
    });

    it('should leave the caller-owned metadata unfrozen after registration', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      expect(Object.isFrozen(definition.metadata)).toBe(false);
      expect(() => {
        (definition.metadata as Record<string, unknown>).readOnly = false;
      }).not.toThrow();
      expect(definition.metadata.readOnly).toBe(false);
    });

    it('should leave the caller-owned capabilities array unfrozen after registration', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      expect(Object.isFrozen(definition.metadata.capabilities)).toBe(false);
      expect(() => {
        definition.metadata.capabilities.push('write');
      }).not.toThrow();
      expect(definition.metadata.capabilities).toEqual(['read', 'write']);
    });

    it('should not reflect caller definition mutations in the stored definition', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      (definition as Record<string, unknown>).name = 'mutated';
      definition.description = 'mutated description';

      const stored = registry.get('read_file');
      expect(stored.name).toBe('read_file');
      expect(stored.description).toBe('Read a file from the workspace');
    });

    it('should not reflect caller metadata mutations in the stored definition', () => {
      const registry = new ToolRegistry();
      const definition = makeDefinition();
      registry.register(definition);

      (definition.metadata as Record<string, unknown>).readOnly = false;
      definition.metadata.capabilities.push('write');

      const stored = registry.get('read_file');
      expect(stored.metadata.readOnly).toBe(true);
      expect(stored.metadata.capabilities).toEqual(['read']);
    });

    it('should return a frozen definition from get()', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());

      const tool = registry.get('read_file');
      expect(Object.isFrozen(tool)).toBe(true);
      expect(() => {
        (tool as Record<string, unknown>).description = 'mutated';
      }).toThrow();
      expect(registry.get('read_file').description).toBe('Read a file from the workspace');
    });

    it('should return frozen metadata from get()', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());

      const tool = registry.get('read_file');
      expect(Object.isFrozen(tool.metadata)).toBe(true);
      expect(Object.isFrozen(tool.metadata.capabilities)).toBe(true);
      expect(() => {
        (tool.metadata as Record<string, unknown>).readOnly = false;
      }).toThrow();
    });

    it('should return frozen elements from list()', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());

      const tool = registry.list()[0];
      expect(Object.isFrozen(tool)).toBe(true);
      expect(() => {
        (tool as Record<string, unknown>).execute = undefined;
      }).toThrow();
      expect(registry.list()[0].execute).toBeDefined();
    });

    it('should return a shallow array copy from list() that cannot add entries to the registry', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());

      const list = registry.list();
      list.push(makeDefinition({ name: 'intruder' }));
      expect(registry.list()).toHaveLength(1);
      expect(registry.has('intruder')).toBe(false);
    });

    it('should execute using the registry-owned authoritative definition', async () => {
      const registry = new ToolRegistry();
      const executeMock = vi.fn().mockResolvedValue({
        kind: 'success',
        output: 'authoritative',
        truncated: false,
        executionMs: 0,
      });
      registry.register(makeDefinition({ execute: executeMock }));

      const executor = new ToolExecutor(registry, {
        permissionPolicy: {
          name: 'allow',
          evaluate: async () => ({ allowed: true }),
        },
      });

      await executor.execute('read_file', { uri: 'file:///a.txt' }, makeContext());

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledWith({ uri: 'file:///a.txt' }, expect.anything());
    });
  });

  describe('listDescriptions schema conversion', () => {
    it('should mark required versus optional object properties', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeDefinition({
          inputSchema: z.object({
            required: z.string(),
            optional: z.string().optional(),
          }),
        })
      );

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({
        type: 'object',
        properties: {
          required: { type: 'string' },
          optional: { type: 'string' },
        },
        required: ['required'],
      });
    });

    it('should convert nested objects', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeDefinition({
          inputSchema: z.object({
            config: z.object({ host: z.string(), port: z.number() }),
          }),
        })
      );

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: { host: { type: 'string' }, port: { type: 'number' } },
            required: ['host', 'port'],
          },
        },
        required: ['config'],
      });
    });

    it('should convert arrays with item schemas', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition({ inputSchema: z.array(z.string()) }));

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('should convert enums', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition({ inputSchema: z.enum(['read', 'write']) }));

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({
        type: 'string',
        enum: ['read', 'write'],
      });
    });

    it('should include Zod descriptions', () => {
      const registry = new ToolRegistry();
      registry.register(
        makeDefinition({
          inputSchema: z.string().describe('The file uri to read'),
        })
      );

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({
        type: 'string',
        description: 'The file uri to read',
      });
    });

    it('should represent unsupported Zod constructs as an empty schema', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition({ inputSchema: z.function({ args: [], returns: z.void() }) }));

      const [description] = registry.listDescriptions();
      expect(description.parameters).toEqual({});
    });
  });

  describe('listDescriptions', () => {
    it('should produce provider-facing descriptions for all registered tools', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition({ name: 'read_file', description: 'Read a file' }));
      registry.register(makeDefinition({ name: 'search_code', description: 'Search code' }));

      const descriptions = registry.listDescriptions();
      expect(descriptions).toHaveLength(2);
      expect(descriptions.map(d => d.name)).toEqual(['read_file', 'search_code']);
      expect(descriptions.map(d => d.description)).toEqual(['Read a file', 'Search code']);

      // Every description must validate against the Substage 1 schema.
      for (const description of descriptions) {
        const validated = validateModelToolDefinition(description);
        expect(validated.name).toBe(description.name);
      }
    });

    it('should return an empty list when the registry is empty', () => {
      expect(new ToolRegistry().listDescriptions()).toEqual([]);
    });

    it('should expose only name, description and parameters', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());
      const [description] = registry.listDescriptions();
      expect(description).toEqual({
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: expect.any(Object),
      });
      expect('execute' in description).toBe(false);
      expect('inputSchema' in description).toBe(false);
      expect('metadata' in description).toBe(false);
    });

    it('should never expose Zod schema objects through model-facing definitions', () => {
      const registry = new ToolRegistry();
      registry.register(makeDefinition());
      const [description] = registry.listDescriptions() as unknown as ModelToolDefinition[];

      expect(description.parameters).not.toBeInstanceOf(z.ZodType);
      const serialized = JSON.stringify(description);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(description);
    });
  });
});
