import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ToolErrorCode,
  ToolError,
  createToolError,
  isToolError,
  isToolErrorCode,
  type ToolErrorOptions,
} from '../errors.js';
import {
  ToolCapabilitySchema,
  JsonSchemaValueSchema,
  ToolMetadataSchema,
  ModelToolDefinitionSchema,
  validateModelToolDefinition,
  safeValidateModelToolDefinition,
  type ToolCapability,
  type JsonSchemaValue,
  type ToolMetadata,
  type ModelToolDefinition,
} from '../schemas.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPermissionDecision,
  ToolPermissionPolicy,
  ToolCategory,
} from '../types.js';
import { createSanitizedContext } from '@nexipi/core';

describe('ToolErrorCode', () => {
  it('should define all required error codes', () => {
    expect(ToolErrorCode.TOOL_NOT_FOUND).toBe('TOOL_NOT_FOUND');
    expect(ToolErrorCode.TOOL_INVALID_ARGUMENTS).toBe('TOOL_INVALID_ARGUMENTS');
    expect(ToolErrorCode.TOOL_PERMISSION_DENIED).toBe('TOOL_PERMISSION_DENIED');
    expect(ToolErrorCode.TOOL_EXECUTION_FAILED).toBe('TOOL_EXECUTION_FAILED');
    expect(ToolErrorCode.TOOL_TIMEOUT).toBe('TOOL_TIMEOUT');
    expect(ToolErrorCode.TOOL_CANCELLED).toBe('TOOL_CANCELLED');
    expect(ToolErrorCode.TOOL_OUTPUT_TOO_LARGE).toBe('TOOL_OUTPUT_TOO_LARGE');
    expect(ToolErrorCode.TOOL_RESOURCE_LIMIT).toBe('TOOL_RESOURCE_LIMIT');
    expect(ToolErrorCode.TOOL_INVALID_RESULT).toBe('TOOL_INVALID_RESULT');
    expect(ToolErrorCode.TOOL_PROVIDER_ERROR).toBe('TOOL_PROVIDER_ERROR');
  });
});

describe('ToolError', () => {
  describe('constructor', () => {
    it('should create error with all properties', () => {
      const cause = new Error('Original failure');
      const context = { requestId: 'req-123', apiKey: 'secret-key' };
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Tool execution failed',
        { toolName: 'read_file', cause, context, retryable: true }
      );

      expect(error.code).toBe(ToolErrorCode.TOOL_EXECUTION_FAILED);
      expect(error.message).toBe('Tool execution failed');
      expect(error.name).toBe('ToolError');
      expect(error.toolName).toBe('read_file');
      expect(error.retryable).toBe(true);
      expect(error.cause).toBe(cause);
    });

    it('should default retryable to false', () => {
      const error = new ToolError(ToolErrorCode.TOOL_NOT_FOUND, 'Not found');
      expect(error.retryable).toBe(false);
    });

    it('should default toolName to undefined when omitted', () => {
      const error = new ToolError(ToolErrorCode.TOOL_CANCELLED, 'Cancelled');
      expect(error.toolName).toBeUndefined();
    });

    it('should preserve cause and context', () => {
      const cause = new Error('Original error');
      const context = { requestId: 'req-123' };
      const error = new ToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENTS,
        'Invalid arguments',
        { cause, context }
      );

      expect(error.cause).toBe(cause);
      expect(error.context).toEqual(context);
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON with all properties', () => {
      const cause = new Error('Original');
      const error = new ToolError(
        ToolErrorCode.TOOL_TIMEOUT,
        'Timed out',
        { toolName: 'search_code', cause, retryable: false }
      );

      const json = error.toJSON();
      expect(json.name).toBe('ToolError');
      expect(json.code).toBe(ToolErrorCode.TOOL_TIMEOUT);
      expect(json.message).toBe('Timed out');
      expect(json.toolName).toBe('search_code');
      expect(json.retryable).toBe(false);
      expect(json.cause).toBe('Original');
      expect(json.stack).toBeDefined();
    });
  });

  describe('secret safety', () => {
    it('should redact sensitive context keys', () => {
      const context = createSanitizedContext({
        requestId: 'req-1',
        apiKey: 'sk-12345',
        password: 'hunter2',
        normalField: 'visible',
      });
      const error = new ToolError(
        ToolErrorCode.TOOL_PROVIDER_ERROR,
        'Provider error',
        { context }
      );

      const json = error.toJSON();
      expect(json.context?.apiKey).toBe('[REDACTED]');
      expect(json.context?.password).toBe('[REDACTED]');
      expect(json.context?.normalField).toBe('visible');
      expect(json.context?.requestId).toBe('req-1');
    });

    it('should not expose secrets in error message', () => {
      const error = new ToolError(
        ToolErrorCode.TOOL_PERMISSION_DENIED,
        'Access denied to read_file'
      );
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('apiKey');
    });
  });
});

describe('createToolError', () => {
  it('should create ToolError instance', () => {
    const error = createToolError(ToolErrorCode.TOOL_NOT_FOUND, 'Unknown tool');
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe(ToolErrorCode.TOOL_NOT_FOUND);
  });
});

describe('isToolError', () => {
  it('should return true for ToolError', () => {
    expect(isToolError(new ToolError(ToolErrorCode.TOOL_CANCELLED, 'Cancelled'))).toBe(true);
  });

  it('should return false for EngineError', () => {
    const { createEngineError, EngineErrorCode } = require('@nexipi/core');
    expect(isToolError(createEngineError(EngineErrorCode.INTERNAL_ERROR, 'Internal'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isToolError(new Error('test'))).toBe(false);
    expect(isToolError('string')).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError(undefined)).toBe(false);
    expect(isToolError({})).toBe(false);
  });
});

describe('isToolErrorCode', () => {
  it('should return true when code matches', () => {
    const error = new ToolError(ToolErrorCode.TOOL_TIMEOUT, 'Timed out');
    expect(isToolErrorCode(error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);
  });

  it('should return false when code does not match', () => {
    const error = new ToolError(ToolErrorCode.TOOL_TIMEOUT, 'Timed out');
    expect(isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED)).toBe(false);
  });

  it('should return false for non-ToolError', () => {
    expect(isToolErrorCode(new Error('x'), ToolErrorCode.TOOL_NOT_FOUND)).toBe(false);
  });
});

describe('ToolCapabilitySchema', () => {
  it('should accept all capabilities', () => {
    for (const cap of ['read', 'write', 'execute', 'external'] as const) {
      expect(ToolCapabilitySchema.safeParse(cap).success).toBe(true);
    }
  });

  it('should reject invalid capability', () => {
    expect(ToolCapabilitySchema.safeParse('delete').success).toBe(false);
  });
});

describe('ToolMetadataSchema', () => {
  it('should validate valid metadata', () => {
    const metadata: ToolMetadata = {
      capabilities: ['read'],
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '1.0.0',
    };
    expect(ToolMetadataSchema.safeParse(metadata).success).toBe(true);
  });

  it('should require version', () => {
    const result = ToolMetadataSchema.safeParse({
      capabilities: ['read'],
      readOnly: true,
      destructive: false,
      requiresWorkspace: true,
      idempotent: true,
      version: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('ModelToolDefinition', () => {
  it('should validate a valid provider-facing tool definition', () => {
    const definition: ModelToolDefinition = {
      name: 'read_file',
      description: 'Read a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string' },
        },
        required: ['uri'],
        additionalProperties: false,
      },
    };
    const result = ModelToolDefinitionSchema.safeParse(definition);
    expect(result.success).toBe(true);
  });

  it('should require name and description', () => {
    expect(
      ModelToolDefinitionSchema.safeParse({
        description: 'desc',
        parameters: {},
      }).success
    ).toBe(false);

    expect(
      ModelToolDefinitionSchema.safeParse({
        name: 'x',
        parameters: {},
      }).success
    ).toBe(false);
  });

  it('should reject function values in parameters', () => {
    const result = ModelToolDefinitionSchema.safeParse({
      name: 'x',
      description: 'd',
      parameters: { fn: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('should accept nested JSON values', () => {
    const result = ModelToolDefinitionSchema.safeParse({
      name: 'x',
      description: 'd',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('validateModelToolDefinition / safeValidateModelToolDefinition', () => {
  it('should validate via validateModelToolDefinition', () => {
    const definition = validateModelToolDefinition({
      name: 'list_directory',
      description: 'List a directory',
      parameters: { type: 'object' },
    });
    expect(definition.name).toBe('list_directory');
  });

  it('should return failure shape via safeValidateModelToolDefinition', () => {
    const result = safeValidateModelToolDefinition({ name: '', description: 'd', parameters: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
    }
  });

  it('should return success shape via safeValidateModelToolDefinition', () => {
    const result = safeValidateModelToolDefinition({
      name: 'search_code',
      description: 'Search code',
      parameters: { type: 'object' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('search_code');
    }
  });
});

describe('ModelToolDefinition serializability and separation', () => {
  it('should contain no execute function', () => {
    const definition: ModelToolDefinition = {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { uri: { type: 'string' } } },
    };
    expect('execute' in definition).toBe(false);
    expect('inputSchema' in definition).toBe(false);
    expect('metadata' in definition).toBe(false);
  });

  it('should be JSON-serializable', () => {
    const definition: ModelToolDefinition = {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { uri: { type: 'string' } } },
    };
    const serialized = JSON.stringify(definition);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(definition);
  });

  it('should keep ToolDefinition separate with executable members', () => {
    const executable: ToolDefinition = {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: z.object({ uri: z.string() }),
      metadata: {
        capabilities: ['read'] as const,
        readOnly: true,
        destructive: false,
        requiresWorkspace: true,
        idempotent: true,
        version: '1.0.0',
      },
      execute: async (): Promise<ToolExecutionResult> => ({
        kind: 'success',
        output: undefined,
        truncated: false,
        cancelled: false,
        executionMs: 0,
      }),
    };
    expect(typeof executable.execute).toBe('function');
    expect(executable.inputSchema).toBeDefined();
    expect(executable.metadata.readOnly).toBe(true);
  });
});

describe('JsonSchemaValue', () => {
  it('should exclude functions at runtime', () => {
    expect(JsonSchemaValueSchema.safeParse(() => {}).success).toBe(false);
  });

  it('should accept primitive JSON values', () => {
    expect(JsonSchemaValueSchema.safeParse('hello').success).toBe(true);
    expect(JsonSchemaValueSchema.safeParse(42).success).toBe(true);
    expect(JsonSchemaValueSchema.safeParse(true).success).toBe(true);
    expect(JsonSchemaValueSchema.safeParse(null).success).toBe(true);
  });

  it('should accept arrays and records', () => {
    expect(JsonSchemaValueSchema.safeParse([1, 'two', null]).success).toBe(true);
    expect(JsonSchemaValueSchema.safeParse({ a: 1, b: { c: 'x' } }).success).toBe(true);
  });
});

describe('ToolExecutionContext', () => {
  it('should be constructible as a platform-independent object literal', () => {
    const context: ToolExecutionContext = {
      signal: new AbortController().signal,
      workspaceId: 'ws_123',
      workspaceFolder: { uri: 'file:///workspace', id: 'ws_123' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      environment: {},
    };

    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.workspaceId).toBe('ws_123');
    expect(context.workspaceFolder?.uri).toBe('file:///workspace');
    expect(context.environment).toEqual({});
  });

  it('should allow undefined workspace', () => {
    const context: ToolExecutionContext = {
      signal: new AbortController().signal,
      workspaceId: undefined,
      workspaceFolder: undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      environment: {},
    };
    expect(context.workspaceId).toBeUndefined();
    expect(context.workspaceFolder).toBeUndefined();
  });
});

describe('ToolExecutionResult', () => {
  it('should represent a successful result', () => {
    const result: ToolExecutionResult<string> = {
      kind: 'success',
      output: 'file contents',
      truncated: false,
      cancelled: false,
      executionMs: 42,
    };
    expect(result.kind).toBe('success');
    expect(result.output).toBe('file contents');
    expect(result.truncated).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.executionMs).toBe(42);
  });

  it('should represent a failed result with ToolError', () => {
    const error = new ToolError(ToolErrorCode.TOOL_NOT_FOUND, 'Tool not found');
    const result: ToolExecutionResult = {
      kind: 'failure',
      error,
      truncated: false,
      cancelled: false,
      executionMs: 10,
    };
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.error).toBe(error);
      expect(result.error.code).toBe(ToolErrorCode.TOOL_NOT_FOUND);
    }
  });

  it('should not silently convert exceptions into successful results', () => {
    const result: ToolExecutionResult = {
      kind: 'failure',
      error: createToolError(ToolErrorCode.TOOL_EXECUTION_FAILED, 'boom'),
      truncated: false,
      cancelled: false,
      executionMs: 5,
    };
    expect(result.kind).toBe('failure');
  });
});

describe('ToolPermissionPolicy', () => {
  it('should define the minimal policy interface', () => {
    const policy: ToolPermissionPolicy = {
      name: 'read-only-allowlist',
      evaluate: () => ({ allowed: true }),
    };
    expect(policy.name).toBe('read-only-allowlist');
    expect(typeof policy.evaluate).toBe('function');
  });

  it('should define a decision with optional denial reason', () => {
    const allowed: ToolPermissionDecision = { allowed: true };
    const denied: ToolPermissionDecision = {
      allowed: false,
      reason: 'Write tools require explicit approval',
    };
    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('Write tools require explicit approval');
  });
});

describe('ToolCategory', () => {
  it('should include read-only category for Stage E', () => {
    const category: ToolCategory = 'read';
    expect(category).toBe('read');
  });

  it('should reserve write/execute/external for later phases', () => {
    const categories: ToolCategory[] = ['read', 'write', 'execute', 'external'];
    expect(categories).toHaveLength(4);
  });
});
