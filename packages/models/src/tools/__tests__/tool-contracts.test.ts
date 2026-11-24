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
    it('should serialize only safe diagnostic fields', () => {
      const cause = new Error('Original failure with secret sk-12345');
      const context = { requestId: 'req-123', normalField: 'visible' };
      const error = new ToolError(
        ToolErrorCode.TOOL_TIMEOUT,
        'Timed out with key sk-abcde',
        { toolName: 'search_code', cause, context, retryable: false }
      );

      const json = error.toJSON();
      expect(json.name).toBe('ToolError');
      expect(json.code).toBe(ToolErrorCode.TOOL_TIMEOUT);
      expect(json.toolName).toBe('search_code');
      expect(json.retryable).toBe(false);

      // Unsafe fields must not be serialized
      expect(json.message).toBeUndefined();
      expect(json.cause).toBeUndefined();
      expect(json.stack).toBeUndefined();
      expect(json.context).toBeUndefined();
      expect(json).not.toHaveProperty('context');
    });

    it('should not serialize raw cause object', () => {
      const inner = new Error('Inner failure with token tok-98765');
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Outer failure',
        { toolName: 'read_file', cause: inner }
      );

      const json = error.toJSON();
      expect(json.cause).toBeUndefined();
      expect(json).not.toHaveProperty('cause');
    });

    it('should not serialize chained ToolError cause', () => {
      const innerToolError = new ToolError(
        ToolErrorCode.TOOL_TIMEOUT,
        'Inner tool timeout with secret sk-xyz',
        { toolName: 'search_code' }
      );
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Outer failure',
        { toolName: 'read_file', cause: innerToolError }
      );

      const json = error.toJSON();
      expect(json.cause).toBeUndefined();
      expect(json.code).toBe(ToolErrorCode.TOOL_EXECUTION_FAILED);
    });

    it('should not serialize context, even when it contains sensitive keys', () => {
      const context = {
        requestId: 'req-1',
        apiKey: 'sk-12345',
        password: 'hunter2',
        authorization: 'Bearer token',
        accessToken: 'at-abc',
        normalField: 'visible',
      };
      const error = new ToolError(
        ToolErrorCode.TOOL_PROVIDER_ERROR,
        'Provider error',
        { context }
      );

      const json = error.toJSON();
      expect(json.context).toBeUndefined();
      expect(json).not.toHaveProperty('context');
    });

    it('should not leak secret values stored under non-sensitive context keys', () => {
      const context = {
        detail: 'API key: sk-secret-value',
        operation: 'failed',
        description: 'Bearer secret-token',
        diagnostic: 'authorization: secret-value',
      };
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Execution failed',
        { toolName: 'read_file', context }
      );

      const json = error.toJSON();
      expect(json.context).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('sk-secret-value');
      expect(serialized).not.toContain('secret-token');
      expect(serialized).not.toContain('secret-value');
      expect(serialized).not.toContain('API key');
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('authorization');
    });

    it('should not leak nested secret values in context', () => {
      const context = {
        nested: { diagnostic: 'authorization: secret-value', extra: 'sk-hidden' },
        safe: { visible: 'ok' },
      };
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Execution failed',
        { toolName: 'read_file', context }
      );

      const json = error.toJSON();
      expect(json.context).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('secret-value');
      expect(serialized).not.toContain('sk-hidden');
      expect(serialized).not.toContain('authorization');
    });

    it('should preserve context internally on the error instance', () => {
      const context = {
        detail: 'API key: sk-secret-value',
        requestId: 'req-123',
      };
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Execution failed',
        { toolName: 'read_file', context }
      );

      // Context is preserved internally on the instance
      expect(error.context).toEqual(context);
      expect(error.context?.detail).toBe('API key: sk-secret-value');
      expect(error.context?.requestId).toBe('req-123');

      // But never serialized
      const json = error.toJSON();
      expect(json.context).toBeUndefined();
    });

    it('should not expose secrets embedded in the top-level error message in serialized output', () => {
      const error = new ToolError(
        ToolErrorCode.TOOL_PROVIDER_ERROR,
        'Failed to authenticate with apiKey sk-live-1234567890abcdef',
        { toolName: 'read_file' }
      );

      const json = error.toJSON();
      expect(json.message).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('sk-live-1234567890abcdef');
      expect(serialized).not.toContain('apiKey');
    });

    it('should not expose secrets embedded in nested cause message in serialized output', () => {
      const cause = new Error('Connection failed with token ghp_1234567890abcdef');
      const error = new ToolError(
        ToolErrorCode.TOOL_PROVIDER_ERROR,
        'Provider request failed',
        { toolName: 'search_code', cause }
      );

      const json = error.toJSON();
      expect(json.cause).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('ghp_1234567890abcdef');
    });

    it('should not expose authorization values embedded in error message in serialized output', () => {
      const error = new ToolError(
        ToolErrorCode.TOOL_PERMISSION_DENIED,
        'Access denied: Authorization: Basic dXNlcjpwYXNz',
        { toolName: 'read_file' }
      );

      const json = error.toJSON();
      expect(json.message).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('dXNlcjpwYXNz');
      expect(serialized).not.toContain('Authorization');
    });

    it('should not expose stack trace in serialized output', () => {
      const error = new ToolError(ToolErrorCode.TOOL_NOT_FOUND, 'Not found');
      const json = error.toJSON();
      expect(json.stack).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('at ');
      expect(serialized).not.toContain('Error:');
    });

    it('should not expose sensitive fields in nested cause objects in serialized output', () => {
      const cause = new Error('Nested failure');
      (cause as Record<string, unknown>).secretField = 'sk-secret-value';
      (cause as Record<string, unknown>).api_key = 'ak-hidden';
      const error = new ToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        'Outer failure',
        { toolName: 'read_file', cause }
      );

      const json = error.toJSON();
      expect(json.cause).toBeUndefined();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('sk-secret-value');
      expect(serialized).not.toContain('ak-hidden');
      expect(serialized).not.toContain('secretField');
    });

    it('should keep safe diagnostic information accessible on the error instance', () => {
      const cause = new Error('Original failure');
      const context = { requestId: 'req-123' };
      const error = new ToolError(
        ToolErrorCode.TOOL_TIMEOUT,
        'Timed out',
        { toolName: 'search_code', cause, context, retryable: true }
      );

      // Instance retains full diagnostic info internally
      expect(error.message).toBe('Timed out');
      expect(error.cause).toBe(cause);
      expect(error.context).toEqual(context);
      expect(error.toolName).toBe('search_code');
      expect(error.retryable).toBe(true);
      expect(error.stack).toBeDefined();
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
    };

    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.workspaceId).toBe('ws_123');
    expect(context.workspaceFolder?.uri).toBe('file:///workspace');
  });

  it('should allow undefined workspace', () => {
    const context: ToolExecutionContext = {
      signal: new AbortController().signal,
      workspaceId: undefined,
      workspaceFolder: undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };
    expect(context.workspaceId).toBeUndefined();
    expect(context.workspaceFolder).toBeUndefined();
  });

  it('should not expose an unrestricted environment capability bag', () => {
    const context: ToolExecutionContext = {
      signal: new AbortController().signal,
      workspaceId: undefined,
      workspaceFolder: undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };
    expect('environment' in context).toBe(false);
  });
});

describe('ToolExecutionResult', () => {
  it('should represent a successful result without cancelled property', () => {
    const result: ToolExecutionResult<string> = {
      kind: 'success',
      output: 'file contents',
      truncated: false,
      executionMs: 42,
    };
    expect(result.kind).toBe('success');
    expect(result.output).toBe('file contents');
    expect(result.truncated).toBe(false);
    expect(result.executionMs).toBe(42);
    expect(('cancelled' in result)).toBe(false);
  });

  it('should not allow a successful result to be marked cancelled', () => {
    const result: SuccessfulToolExecutionResult = {
      kind: 'success',
      output: 'file contents',
      truncated: false,
      executionMs: 10,
    };
    expect(result.kind).toBe('success');
    expect('cancelled' in result).toBe(false);
  });

  it('should represent cancellation as a failure with TOOL_CANCELLED error code', () => {
    const error = new ToolError(ToolErrorCode.TOOL_CANCELLED, 'Tool was cancelled');
    const result: ToolExecutionResult = {
      kind: 'failure',
      error,
      truncated: false,
      executionMs: 5,
    };
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.error.code).toBe(ToolErrorCode.TOOL_CANCELLED);
      expect(result.error.message).toBe('Tool was cancelled');
    }
  });

  it('should distinguish timeout from cancellation', () => {
    const timeoutResult: ToolExecutionResult = {
      kind: 'failure',
      error: new ToolError(ToolErrorCode.TOOL_TIMEOUT, 'Tool timed out'),
      truncated: false,
      executionMs: 30000,
    };
    const cancelledResult: ToolExecutionResult = {
      kind: 'failure',
      error: new ToolError(ToolErrorCode.TOOL_CANCELLED, 'Tool was cancelled'),
      truncated: false,
      executionMs: 5,
    };
    expect(timeoutResult.kind).toBe('failure');
    if (timeoutResult.kind === 'failure') {
      expect(timeoutResult.error.code).toBe(ToolErrorCode.TOOL_TIMEOUT);
    }
    expect(cancelledResult.kind).toBe('failure');
    if (cancelledResult.kind === 'failure') {
      expect(cancelledResult.error.code).toBe(ToolErrorCode.TOOL_CANCELLED);
    }
  });

  it('should represent a failed result with ToolError', () => {
    const error = new ToolError(ToolErrorCode.TOOL_NOT_FOUND, 'Tool not found');
    const result: ToolExecutionResult = {
      kind: 'failure',
      error,
      truncated: false,
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
