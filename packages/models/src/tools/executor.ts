import { createNoopLogger, type Logger } from '@nexipi/core';
import {
  ToolErrorCode,
  createToolError,
  isToolError,
} from './errors.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPermissionDecision,
  ToolPermissionPolicy,
} from './types.js';
import type { ToolRegistry } from './registry.js';

/**
 * Monotonic clock reading in milliseconds.
 *
 * Uses the runtime's monotonic `performance.now()` when available and falls
 * back to `Date.now()` otherwise. Never throws.
 */
function monotonicNow(): number {
  const performance = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

/**
 * Safe default permission policy.
 *
 * Stage E exposes read-only tools only. When no ToolPermissionPolicy is
 * injected into ToolExecutor, execution must not be implicitly allowed: the
 * default policy denies every tool with an explicit reason. Callers that want
 * execution must supply a policy (for example a read-only allowlist) through
 * the executor constructor. This policy performs no interactive approval and
 * grants no write, terminal or external-tool capabilities.
 */
const DEFAULT_PERMISSION_POLICY: ToolPermissionPolicy = {
  name: 'deny-all-default',
  evaluate: (): ToolPermissionDecision => ({
    allowed: false,
    reason:
      'Tool execution is not permitted: no ToolPermissionPolicy was supplied to ToolExecutor. Stage E exposes read-only tools only; inject a policy to allow execution.',
  }),
};

/**
 * Options for ToolExecutor construction.
 */
export interface ToolExecutorOptions {
  /**
   * Permission policy consulted before every execution. Defaults to a safe
   * deny-all policy when omitted.
   */
  readonly permissionPolicy?: ToolPermissionPolicy;
  /**
   * Logger used for execution diagnostics. Only safe metadata (tool name,
   * duration, decision) is logged; raw tool arguments and output are never
   * logged. Defaults to a no-op logger.
   */
  readonly logger?: Logger;
}

/**
 * Executes a single registered tool at a time.
 *
 * The executor resolves the tool through an injected ToolRegistry, validates
 * raw input against the tool's inputSchema, consults the injected
 * ToolPermissionPolicy, invokes the tool's execute function with only the
 * validated input and the supplied ToolExecutionContext, and validates
 * successful output against the optional outputSchema.
 *
 * Every outcome is a structured ToolExecutionResult. Execution failures are
 * never converted into success results, and sensitive exception information
 * (raw messages, causes, stacks, credentials) is never serialized or logged.
 *
 * Concurrency budgets, timeouts, iteration limits and model-call loops are
 * intentionally out of scope; they belong to later substages.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly permissionPolicy: ToolPermissionPolicy;
  private readonly logger: Logger;

  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.registry = registry;
    this.permissionPolicy = options.permissionPolicy ?? DEFAULT_PERMISSION_POLICY;
    this.logger = options.logger ?? createNoopLogger();
  }

  /**
   * Execute one registered tool by name.
   *
   * Steps:
   * 1. Resolve the tool through the registry (TOOL_NOT_FOUND when missing).
   * 2. Respect an already-aborted AbortSignal before starting execution
   *    (TOOL_CANCELLED).
   * 3. Validate raw input against inputSchema (TOOL_INVALID_ARGUMENTS).
   * 4. Evaluate the permission policy (TOOL_PERMISSION_DENIED when denied;
   *    policy exceptions become TOOL_EXECUTION_FAILED). Denial prevents the
   *    tool's execute function from running.
   * 5. Invoke execute with only the validated input and the supplied context.
   * 6. Validate successful output against outputSchema when defined
   *    (TOOL_INVALID_RESULT).
   *
   * Returns a ToolExecutionResult in all cases. The result carries execution
   * duration measured with a monotonic clock.
   */
  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startMs = monotonicNow();

    let tool: ToolDefinition;
    try {
      tool = this.registry.get(name);
    } catch (error) {
      return this.failureResult(name, startMs, error);
    }

    if (context.signal.aborted) {
      return {
        kind: 'failure',
        error: createToolError(
          ToolErrorCode.TOOL_CANCELLED,
          `Tool '${name}' was cancelled before execution`,
          { toolName: name }
        ),
        truncated: false,
        executionMs: elapsed(startMs),
      };
    }

    let validatedInput: unknown;
    try {
      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) {
        return this.invalidArgumentsResult(name, startMs, parsed.error);
      }
      validatedInput = parsed.data;
    } catch (error) {
      return this.failureResult(name, startMs, error);
    }

    let decision: ToolPermissionDecision;
    try {
      decision = await this.permissionPolicy.evaluate(tool, context);
    } catch (error) {
      return this.failureResult(name, startMs, error);
    }

    if (!decision.allowed) {
      return {
        kind: 'failure',
        error: createToolError(
          ToolErrorCode.TOOL_PERMISSION_DENIED,
          `Permission denied for tool '${name}'${
            decision.reason ? `: ${decision.reason}` : ''
          }`,
          { toolName: name }
        ),
        truncated: false,
        executionMs: elapsed(startMs),
      };
    }

    let output: unknown;
    try {
      output = await tool.execute(validatedInput, context);
    } catch (error) {
      return this.executionErrorResult(name, startMs, error);
    }

    if (tool.outputSchema !== undefined) {
      const parsed = tool.outputSchema.safeParse(output);
      if (!parsed.success) {
        return {
          kind: 'failure',
          error: createToolError(ToolErrorCode.TOOL_INVALID_RESULT, `Tool '${name}' returned invalid output`, {
            toolName: name,
          }),
          truncated: false,
          executionMs: elapsed(startMs),
        };
      }
      // Return the validated (and possibly transformed/defaulted) output so
      // Zod transformations and defaults are reflected in the result.
      output = parsed.data;
    }

    const executionMs = elapsed(startMs);
    this.logger.debug(`Tool '${name}' executed`, { toolName: name, executionMs });

    return {
      kind: 'success',
      output,
      truncated: false,
      executionMs,
    };
  }

  private invalidArgumentsResult(
    name: string,
    startMs: number,
    zodError: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> }
  ): ToolExecutionResult {
    const issues = zodError.issues
      .map(issue => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return {
      kind: 'failure',
      error: createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENTS,
        `Invalid input for tool '${name}': ${issues}`,
        { toolName: name }
      ),
      truncated: false,
      executionMs: elapsed(startMs),
    };
  }

  private failureResult(name: string, startMs: number, error: unknown): ToolExecutionResult {
    if (isToolError(error)) {
      // Preserve the tool's own error code rather than replacing it.
      return {
        kind: 'failure',
        error: createToolError(error.code, error.message, {
          toolName: name,
          cause: error.cause,
          context: error.context,
          retryable: error.retryable,
        }),
        truncated: false,
        executionMs: elapsed(startMs),
      };
    }

    return {
      kind: 'failure',
      error: createToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        `Tool '${name}' failed`,
        {
          toolName: name,
          cause: error instanceof Error ? error : undefined,
        }
      ),
      truncated: false,
      executionMs: elapsed(startMs),
    };
  }

  private executionErrorResult(
    name: string,
    startMs: number,
    error: unknown
  ): ToolExecutionResult {
    if (isToolError(error)) {
      // Preserve existing ToolError codes (e.g. TOOL_TIMEOUT, TOOL_CANCELLED)
      // instead of indiscriminately reclassifying every error.
      return {
        kind: 'failure',
        error: createToolError(error.code, error.message, {
          toolName: name,
          cause: error.cause,
          context: error.context,
          retryable: error.retryable,
        }),
        truncated: false,
        executionMs: elapsed(startMs),
      };
    }

    // Raw exception messages are never surfaced in the serialized error.
    return {
      kind: 'failure',
      error: createToolError(
        ToolErrorCode.TOOL_EXECUTION_FAILED,
        `Tool '${name}' execution failed`,
        {
          toolName: name,
          cause: error instanceof Error ? error : undefined,
        }
      ),
      truncated: false,
      executionMs: elapsed(startMs),
    };
  }
}

function elapsed(startMs: number): number {
  return Math.max(0, monotonicNow() - startMs);
}
