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
 * No VS Code or workspace-package types are imported. Platform capabilities
 * are injected through `environment`; the generic engine never interprets
 * those values.
 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly workspaceId: string | undefined;
  readonly workspaceFolder:
    | { readonly uri: string; readonly id: string }
    | undefined;
  readonly logger: Logger;
  /**
   * Extensible, platform-specific capability bag. The generic engine never
   * interprets these values; they are passed through to tool implementations.
   * Future platform capabilities must be explicitly injected here.
   */
  readonly environment: Readonly<Record<string, unknown>>;
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

export interface SuccessfulToolExecutionResult<TOutput = unknown> {
  readonly kind: 'success';
  readonly output: TOutput;
  readonly truncated: boolean;
  readonly cancelled: boolean;
  readonly executionMs: number;
}

export interface FailedToolExecutionResult {
  readonly kind: 'failure';
  readonly error: ToolError;
  readonly truncated: boolean;
  readonly cancelled: boolean;
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
