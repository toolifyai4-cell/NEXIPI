/**
 * Phase 11 Stage B — Runtime validation schemas for the terminal execution
 * domain.
 *
 * Validates every externally supplied or persisted terminal execution
 * contract. TypeScript types alone are not trusted as runtime validation.
 *
 * All patterns are static and hardcoded. No model-supplied JavaScript
 * regular expressions or dynamically evaluated code are used for validation.
 *
 * Environment secret values are never validated or stored here; only
 * environment configuration references and variable names are validated.
 *
 * The canonical domain types are defined in contracts.ts; this module owns
 * the Zod schemas and validation functions and imports those types rather
 * than redeclaring them, avoiding ambiguous exports.
 */

import { z } from 'zod';
import type {
  ApprovalBinding,
  TerminalCommand,
  TerminalExecutionLimits,
  TerminalExecutionRequest,
  TerminalExecutionResult,
  TerminalLifecycleState,
} from './contracts.js';
import { DEFAULT_TERMINAL_EXECUTION_LIMITS } from './contracts.js';

// --- Static validation limits. These mirror DEFAULT_TERMINAL_EXECUTION_LIMITS
// and are enforced by the schemas. Adjusting them requires updating both. ---

const MAX_EXECUTABLE_LENGTH = 256;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_ARGUMENTS_COUNT = 128;
const MAX_WORKING_DIRECTORY_LENGTH = 4096;
const MAX_COMMAND_LINE_LENGTH = 8192;
const MAX_OUTPUT_SIZE_BYTES = 1024 * 1024;

// Static, hardcoded pattern for environment variable names. Not derived from
// model input. Permits POSIX-style names: alpha/underscore start, then
// alphanumeric/underscore. Rejects shell metacharacters and empty names.
const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const TerminalIdSchema = z
  .string()
  .min(1, 'terminalId must be a non-empty string')
  .max(256, 'terminalId must not exceed 256 characters');

export const EnvironmentConfigIdSchema = z
  .string()
  .min(1, 'environmentConfigId must be a non-empty string')
  .max(256, 'environmentConfigId must not exceed 256 characters');

export const EnvironmentVariableNameSchema = z
  .string()
  .min(1, 'environment variable name must be non-empty')
  .max(256, 'environment variable name must not exceed 256 characters')
  .regex(
    ENV_VARIABLE_NAME_PATTERN,
    'environment variable name must start with a letter or underscore and contain only letters, digits, and underscores'
  );

export const EnvironmentConfigReferenceSchema = z.object({
  kind: z.literal('environment-config-reference'),
  id: EnvironmentConfigIdSchema,
  name: z.string().min(1).max(256).optional(),
});

export const TerminalLifecycleStateSchema = z.enum([
  'proposed',
  'validating',
  'awaiting-approval',
  'approved',
  'running',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'timed-out',
  'disposed',
]);

export const TerminalCommandSchema = z
  .object({
    kind: z.literal('terminal-command'),
    commandId: z.string().min(1, 'commandId is required').max(256, 'commandId too long'),
    executable: z
      .string()
      .min(1, 'executable is required')
      .max(MAX_EXECUTABLE_LENGTH, `executable must not exceed ${MAX_EXECUTABLE_LENGTH} characters`),
    arguments: z
      .array(
        z
          .string()
          .max(MAX_ARGUMENT_LENGTH, `argument must not exceed ${MAX_ARGUMENT_LENGTH} characters`)
      )
      .max(MAX_ARGUMENTS_COUNT, `too many arguments (maximum ${MAX_ARGUMENTS_COUNT})`),
    workingDirectory: z
      .string()
      .min(1, 'workingDirectory is required')
      .max(
        MAX_WORKING_DIRECTORY_LENGTH,
        `workingDirectory must not exceed ${MAX_WORKING_DIRECTORY_LENGTH} characters`
      ),
    workspaceId: z
      .string()
      .min(1, 'workspaceId is required')
      .max(256, 'workspaceId must not exceed 256 characters'),
    environmentConfig: EnvironmentConfigReferenceSchema.optional(),
    proposedAt: z
      .number()
      .int()
      .nonnegative('proposedAt must be a non-negative millisecond timestamp'),
  })
  .refine(data => {
    const total =
      data.executable.length +
      data.arguments.reduce((sum, arg) => sum + arg.length, 0) +
      data.arguments.length;
    return total <= MAX_COMMAND_LINE_LENGTH;
  }, `command line length must not exceed ${MAX_COMMAND_LINE_LENGTH} characters`);

export const CancellationRequestSchema = z.object({
  kind: z.literal('cancellation-request'),
  requestId: z.string().min(1, 'requestId is required').max(256, 'requestId too long'),
  reason: z.enum(['user', 'shutdown', 'timeout']),
  requestedAt: z
    .number()
    .int()
    .nonnegative('requestedAt must be a non-negative millisecond timestamp'),
});

export const TimeoutInfoSchema = z.object({
  kind: z.literal('timeout-info'),
  maxExecutionMs: z.number().int().positive('maxExecutionMs must be a positive millisecond value'),
  deadlineAt: z
    .number()
    .int()
    .nonnegative('deadlineAt must be a non-negative millisecond timestamp'),
  expired: z.boolean(),
});

export const ApprovalBindingSchema = z.object({
  kind: z.literal('terminal-approval-binding'),
  bindingId: z.string().min(1, 'bindingId is required').max(256, 'bindingId too long'),
  executable: z
    .string()
    .min(1, 'executable is required')
    .max(MAX_EXECUTABLE_LENGTH, `executable must not exceed ${MAX_EXECUTABLE_LENGTH} characters`),
  arguments: z
    .array(
      z
        .string()
        .max(MAX_ARGUMENT_LENGTH, `argument must not exceed ${MAX_ARGUMENT_LENGTH} characters`)
    )
    .max(MAX_ARGUMENTS_COUNT, `too many arguments (maximum ${MAX_ARGUMENTS_COUNT})`),
  workingDirectory: z
    .string()
    .min(1, 'workingDirectory is required')
    .max(
      MAX_WORKING_DIRECTORY_LENGTH,
      `workingDirectory must not exceed ${MAX_WORKING_DIRECTORY_LENGTH} characters`
    ),
  workspaceId: z
    .string()
    .min(1, 'workspaceId is required')
    .max(256, 'workspaceId must not exceed 256 characters'),
  environmentConfigId: EnvironmentConfigIdSchema.optional(),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'contentHash must be a lowercase SHA-256 hex string (64 hex chars)'),
  createdAt: z.number().int().positive('createdAt must be a positive millisecond timestamp'),
});

export const TerminalExecutionRequestSchema = z.object({
  kind: z.literal('terminal-execution-request'),
  requestId: z.string().min(1, 'requestId is required').max(256, 'requestId too long'),
  command: TerminalCommandSchema,
  approvalBinding: ApprovalBindingSchema.optional(),
});

export const TerminalExecutionResultSchema = z.object({
  kind: z.literal('terminal-execution-result'),
  requestId: z.string().min(1, 'requestId is required').max(256, 'requestId too long'),
  terminalId: TerminalIdSchema,
  state: TerminalLifecycleStateSchema,
  exitCode: z.number().int().nonnegative().nullable(),
  exitSignal: z.string().max(64).nullable(),
  stdout: z
    .string()
    .max(MAX_OUTPUT_SIZE_BYTES, `stdout must not exceed ${MAX_OUTPUT_SIZE_BYTES} bytes`),
  stderr: z
    .string()
    .max(MAX_OUTPUT_SIZE_BYTES, `stderr must not exceed ${MAX_OUTPUT_SIZE_BYTES} bytes`),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  outputSizeBytes: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
  executionMs: z.number().int().nonnegative().nullable(),
  cancelled: z.boolean(),
  timedOut: z.boolean(),
  error: z.object({ code: z.string().min(1), message: z.string() }).nullable(),
});

export const TerminalExecutionLimitsSchema = z.object({
  maxExecutableLength: z.number().int().positive(),
  maxArgumentLength: z.number().int().positive(),
  maxArgumentsCount: z.number().int().positive(),
  maxWorkingDirectoryLength: z.number().int().positive(),
  maxCommandLineLength: z.number().int().positive(),
  maxOutputSizeBytes: z.number().int().positive(),
  maxExecutionMs: z.number().int().positive(),
});

export const DEFAULT_TERMINAL_EXECUTION_LIMITS_VALIDATED: TerminalExecutionLimits =
  TerminalExecutionLimitsSchema.parse(DEFAULT_TERMINAL_EXECUTION_LIMITS);

/**
 * Validates a TerminalCommand at runtime. Throws ZodError on invalid input.
 */
export function validateTerminalCommand(input: unknown): TerminalCommand {
  return TerminalCommandSchema.parse(input);
}

/**
 * Safely validates a TerminalCommand without throwing.
 */
export function safeValidateTerminalCommand(
  input: unknown
): { success: true; data: TerminalCommand } | { success: false; error: z.ZodError } {
  const result = TerminalCommandSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates a TerminalExecutionRequest at runtime. Throws ZodError on invalid input.
 */
export function validateTerminalExecutionRequest(input: unknown): TerminalExecutionRequest {
  return TerminalExecutionRequestSchema.parse(input);
}

/**
 * Safely validates a TerminalExecutionRequest without throwing.
 */
export function safeValidateTerminalExecutionRequest(
  input: unknown
): { success: true; data: TerminalExecutionRequest } | { success: false; error: z.ZodError } {
  const result = TerminalExecutionRequestSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates a TerminalExecutionResult at runtime. Throws ZodError on invalid input.
 */
export function validateTerminalExecutionResult(input: unknown): TerminalExecutionResult {
  return TerminalExecutionResultSchema.parse(input);
}

/**
 * Safely validates a TerminalExecutionResult without throwing.
 */
export function safeValidateTerminalExecutionResult(
  input: unknown
): { success: true; data: TerminalExecutionResult } | { success: false; error: z.ZodError } {
  const result = TerminalExecutionResultSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates an ApprovalBinding at runtime. Throws ZodError on invalid input.
 */
export function validateApprovalBinding(input: unknown): ApprovalBinding {
  return ApprovalBindingSchema.parse(input);
}

/**
 * Safely validates an ApprovalBinding without throwing.
 */
export function safeValidateApprovalBinding(
  input: unknown
): { success: true; data: ApprovalBinding } | { success: false; error: z.ZodError } {
  const result = ApprovalBindingSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validates TerminalExecutionLimits at runtime. Throws ZodError on invalid input.
 */
export function validateTerminalExecutionLimits(input: unknown): TerminalExecutionLimits {
  return TerminalExecutionLimitsSchema.parse(input);
}

/**
 * Checks whether a lifecycle state is terminal.
 */
export function isTerminalStateSchema(state: TerminalLifecycleState): boolean {
  return ['completed', 'failed', 'rejected', 'cancelled', 'timed-out', 'disposed'].includes(state);
}

/**
 * Checks whether a lifecycle state is active (non-terminal).
 */
export function isActiveStateSchema(state: TerminalLifecycleState): boolean {
  return ['proposed', 'validating', 'awaiting-approval', 'approved', 'running'].includes(state);
}
