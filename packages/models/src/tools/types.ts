import type { Logger } from '@nexipi/core';
import type { ZodTypeAny } from 'zod';
import type { ToolError } from './errors.js';
import type {
  ToolCapability,
  JsonSchemaValue,
  ToolMetadata,
  ModelToolDefinition,
} from './schemas.js';

/**
 * Category of tool capability.
 *
 * Stage E supports read-only tools only. Write, execute and external
 * capabilities are reserved for later phases and explicit user approval.
 */
export type ToolCategory = ToolCapability;

/**
 * Platform-independent execution context passed to a tool's execute function.
 *
 * No VS Code or workspace-package types are imported. The context carries
 * only the narrowly scoped capabilities needed for execution: cancellation
 * signal, optional workspace identity, optional workspace folder, and a
 * logger. No arbitrary capability bag is exposed — future platform
 * capabilities must be added through explicit, typed fields rather than an
 * unrestricted `Record<string, unknown>`.
 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly workspaceId: string | undefined;
  readonly workspaceFolder:
    | { readonly uri: string; readonly id: string }
    | undefined;
  readonly logger: Logger;
}

/**
 * Internal executable tool definition.
 *
 * Contains the Zod input schema and execution function required to register
 * and run a tool. Must NOT be exposed to model providers.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema?: ZodTypeAny;
  readonly metadata: ToolMetadata;
  execute(
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}

/**
 * Successful tool execution result.
 *
 * A successful result is never cancelled. Cancellation is always
 * represented as a failure carrying `ToolErrorCode.TOOL_CANCELLED`, so
 * contradictory states (kind === 'success' with cancelled === true) are
 * unrepresentable.
 */
export interface SuccessfulToolExecutionResult<TOutput = unknown> {
  readonly kind: 'success';
  readonly output: TOutput;
  readonly truncated: boolean;
  readonly executionMs: number;
}

/**
 * Failed tool execution result.
 *
 * Cancellation is represented here with `error.code ===
 * ToolErrorCode.TOOL_CANCELLED`. Timeout is distinct from cancellation
 * (`ToolErrorCode.TOOL_TIMEOUT`). Partial output after cancellation is not
 * serialized as success; callers that need partial results must model them
 * explicitly in the failure's `ToolError.context` if required.
 */
export interface FailedToolExecutionResult {
  readonly kind: 'failure';
  readonly error: ToolError;
  readonly truncated: boolean;
  readonly executionMs: number;
}

export type ToolExecutionResult<TOutput = unknown> =
  | SuccessfulToolExecutionResult<TOutput>
  | FailedToolExecutionResult;

export interface ToolPermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface ToolPermissionPolicy {
  readonly name: string;
  evaluate(
    definition: Readonly<ToolDefinition>,
    context: ToolExecutionContext
  ): ToolPermissionDecision | Promise<ToolPermissionDecision>;
}

/**
 * Re-exported from schemas.ts for a single source of truth on serializable
 * shapes. Kept separate from ToolDefinition: these contain no executable
 * functions or Zod objects and are safe to send to model providers.
 */
export type {
  ToolCapability,
  JsonSchemaValue,
  ToolMetadata,
  ModelToolDefinition,
};
