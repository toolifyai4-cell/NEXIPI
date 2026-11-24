import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import { ToolExecutor } from '../executor.js';
import {
  ToolErrorCode,
  ToolError,
  isToolErrorCode,
} from '../errors.js';
import type { ToolDefinition, ToolExecutionContext, ToolPermissionPolicy } from '../types.js';
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
    execute: vi.fn().mockResolvedValue('file contents'),
    ...overrides,
  };
}

function makePolicy(decision: { allowed: boolean; reason?: string }): ToolPermissionPolicy {
  return {
    name: 'test-policy',
    evaluate: vi.fn().mockResolvedValue(decision),
  };
}

function makeContext(aborted = false): ToolExecutionContext {
  const controller = new AbortController();
  if (aborted) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    workspaceId: 'ws_1',
    workspaceFolder: undefined,
    logger: createNoopLogger(),
  };
}

function executeTool(executor: ToolExecutor, input: unknown, context: ToolExecutionContext) {
  return executor.execute('read_file', input, context);
}

describe('ToolExecutor', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeDefinition());
    executor = new ToolExecutor(registry, {
      permissionPolicy: makePolicy({ allowed: true }),
    });
  });

  describe('successful execution', () => {
    it('should execute a registered tool and return a success result', async () => {
      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.output).toBe('file contents');
        expect(result.truncated).toBe(false);
        expect(typeof result.executionMs).toBe('number');
        expect(result.executionMs).toBeGreaterThanOrEqual(0);
        expect('cancelled' in result).toBe(false);
      }
    });

    it('should pass only validated input and the supplied context to execute', async () => {
      const definition = registry.get('read_file');
      const executeMock = definition.execute as ReturnType<typeof vi.fn>;
      const context = makeContext();

      await executeTool(executor, { uri: 'file:///a.txt' }, context);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(executeMock).toHaveBeenCalledWith({ uri: 'file:///a.txt' }, context);
    });

    it('should pass transformed (validated) input to execute', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          inputSchema: z.preprocess((value: unknown) => String(value), z.string()),
        })
      );
      const executeMock = (registry.get('read_file').execute as unknown) as ReturnType<
        typeof vi.fn
      >;

      await executeTool(executor, 42, makeContext());

      expect(executeMock).toHaveBeenCalledWith('42', expect.anything());
    });

    it('should record execution duration', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return 'x';
          }),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.executionMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('permission policy', () => {
    it('should allow execution when the policy allows', async () => {
      const policy = makePolicy({ allowed: true });
      const allowedExecutor = new ToolExecutor(registry, { permissionPolicy: policy });

      const result = await executeTool(allowedExecutor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      expect(policy.evaluate).toHaveBeenCalledTimes(1);
    });

    it('should deny execution and prevent execute from running when the policy denies', async () => {
      const policy = makePolicy({ allowed: false, reason: 'Read tools require approval' });
      const denyingExecutor = new ToolExecutor(registry, {
        permissionPolicy: policy,
      });
      const executeMock = (registry.get('read_file').execute as unknown) as ReturnType<
        typeof vi.fn
      >;

      const result = await executeTool(denyingExecutor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_PERMISSION_DENIED)).toBe(true);
        expect(result.error.message).toContain('Read tools require approval');
      }
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('should treat a policy exception as an execution failure without running the tool', async () => {
      const policy = {
        name: 'failing-policy',
        evaluate: vi.fn().mockRejectedValue(new Error('policy boom with sk-policy-secret')),
      };
      const failingExecutor = new ToolExecutor(registry, { permissionPolicy: policy });
      const executeMock = (registry.get('read_file').execute as unknown) as ReturnType<
        typeof vi.fn
      >;

      const result = await executeTool(failingExecutor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_EXECUTION_FAILED)).toBe(true);
      }
      expect(executeMock).not.toHaveBeenCalled();
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain('sk-policy-secret');
    });

    it('should deny all execution by default when no policy is supplied', async () => {
      const noPolicyExecutor = new ToolExecutor(registry);

      const result = await executeTool(noPolicyExecutor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_PERMISSION_DENIED)).toBe(true);
      }
    });
  });

  describe('input validation', () => {
    it('should return TOOL_INVALID_ARGUMENTS for invalid input without executing', async () => {
      const executeMock = (registry.get('read_file').execute as unknown) as ReturnType<
        typeof vi.fn
      >;

      const result = await executeTool(executor, { uri: 123 }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_INVALID_ARGUMENTS)).toBe(true);
        expect(result.error.message).toContain('read_file');
      }
      expect(executeMock).not.toHaveBeenCalled();
    });

    it('should not leak raw arguments into the invalid-arguments error', async () => {
      const result = await executeTool(executor, { uri: 123, secret: 'sk-arg-secret' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain('sk-arg-secret');
        expect(serialized).not.toContain('secret');
      }
    });
  });

  describe('cancellation', () => {
    it('should respect an already-aborted signal and not execute', async () => {
      const executeMock = (registry.get('read_file').execute as unknown) as ReturnType<
        typeof vi.fn
      >;

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext(true));

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_CANCELLED)).toBe(true);
      }
      expect(executeMock).not.toHaveBeenCalled();
    });
  });

  describe('execution errors', () => {
    it('should convert a thrown normal Error into a TOOL_EXECUTION_FAILED failure', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockRejectedValue(new Error('execution boom with sk-exec-secret')),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_EXECUTION_FAILED)).toBe(true);
        expect(result.kind).not.toBe('success');
      }
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain('sk-exec-secret');
      expect(serialized).not.toContain('execution boom');
    });

    it('should preserve an existing ToolError code', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          execute: vi.fn().mockRejectedValue(
            new ToolError(ToolErrorCode.TOOL_TIMEOUT, 'tool timeout with sk-timeout-secret', {
              toolName: 'read_file',
            })
          ),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_TIMEOUT)).toBe(true);
      }
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain('sk-timeout-secret');
    });

    it('should distinguish timeout from cancellation as failure codes', async () => {
      const codes: ToolErrorCode[] = [];
      for (const code of [ToolErrorCode.TOOL_TIMEOUT, ToolErrorCode.TOOL_CANCELLED]) {
        registry.unregister('read_file');
        registry.register(
          makeDefinition({
            execute: vi.fn().mockRejectedValue(new ToolError(code, 'tool error', { toolName: 'read_file' })),
          })
        );
        const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());
        if (result.kind === 'failure') {
          codes.push(result.error.code);
        }
      }
      expect(codes).toEqual([ToolErrorCode.TOOL_TIMEOUT, ToolErrorCode.TOOL_CANCELLED]);
    });
  });

  describe('output validation', () => {
    it('should succeed when output matches an optional outputSchema', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          outputSchema: z.object({ lines: z.array(z.string()) }),
          execute: vi.fn().mockResolvedValue({ lines: ['a', 'b'] }),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.output).toEqual({ lines: ['a', 'b'] });
      }
    });

    it('should return TOOL_INVALID_RESULT when output validation fails', async () => {
      registry.unregister('read_file');
      const executeMock = vi.fn().mockResolvedValue({ lines: 'not-an-array' });
      registry.register(
        makeDefinition({
          outputSchema: z.object({ lines: z.array(z.string()) }),
          execute: executeMock as unknown as ToolDefinition['execute'],
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(isToolErrorCode(result.error, ToolErrorCode.TOOL_INVALID_RESULT)).toBe(true);
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain('not-an-array');
      }
    });

    it('should return transformed output when outputSchema transforms', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          outputSchema: z.string().transform((value) => value.toUpperCase()),
          execute: vi.fn().mockResolvedValue('hello'),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.output).toBe('HELLO');
      }
    });

    it('should return defaulted output when outputSchema applies a default', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          outputSchema: z.object({ count: z.number().default(7) }),
          execute: vi.fn().mockResolvedValue({}),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
      if (result.kind === 'success') {
        expect(result.output).toEqual({ count: 7 });
      }
    });

    it('should succeed without an outputSchema for any output', async () => {
      registry.unregister('read_file');
      registry.register(
        makeDefinition({
          outputSchema: undefined,
          execute: vi.fn().mockResolvedValue('anything goes'),
        })
      );

      const result = await executeTool(executor, { uri: 'file:///a.txt' }, makeContext());

      expect(result.kind).toBe('success');
    });
  });

  describe('logging security', () => {
    it('should not log raw arguments or output by default', async () => {
      const logMock = vi.fn();
      const loggedExecutor = new ToolExecutor(registry, {
        logger: { debug: logMock, info: logMock, warn: logMock, error: logMock } as unknown as ReturnType<
          typeof createNoopLogger
        >,
      });

      await executeTool(
        loggedExecutor,
        { uri: 'file:///a.txt', apiKey: 'sk-input-secret' },
        makeContext()
      );

      const serialized = JSON.stringify(logMock.mock.calls);
      expect(serialized).not.toContain('sk-input-secret');
      expect(serialized).not.toContain('file contents');
    });
  });
});
