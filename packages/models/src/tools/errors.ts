import { EngineError } from '@nexipi/core';

export enum ToolErrorCode {
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_INVALID_ARGUMENTS = 'TOOL_INVALID_ARGUMENTS',
  TOOL_PERMISSION_DENIED = 'TOOL_PERMISSION_DENIED',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',
  TOOL_CANCELLED = 'TOOL_CANCELLED',
  TOOL_OUTPUT_TOO_LARGE = 'TOOL_OUTPUT_TOO_LARGE',
  TOOL_RESOURCE_LIMIT = 'TOOL_RESOURCE_LIMIT',
  TOOL_INVALID_RESULT = 'TOOL_INVALID_RESULT',
  TOOL_PROVIDER_ERROR = 'TOOL_PROVIDER_ERROR',
}

export interface ToolErrorOptions {
  readonly toolName?: string | undefined;
  readonly cause?: Error | undefined;
  readonly context?: Record<string, unknown> | undefined;
  readonly retryable?: boolean | undefined;
}

export class ToolError extends EngineError<ToolErrorCode> {
  public readonly toolName: string | undefined;
  public readonly retryable: boolean;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(code, message, {
      cause: options.cause,
      context: options.context,
    });
    Object.setPrototypeOf(this, ToolError.prototype);
    this.name = 'ToolError';
    this.toolName = options.toolName ?? undefined;
    this.retryable = options.retryable ?? false;
  }

  override toJSON(): Record<string, unknown> {
    const base = super.toJSON();
    return {
      ...base,
      name: 'ToolError',
      toolName: this.toolName,
      retryable: this.retryable,
    };
  }
}

export function createToolError(
  code: ToolErrorCode,
  message: string,
  options: ToolErrorOptions = {}
): ToolError {
  return new ToolError(code, message, options);
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

export function isToolErrorCode(error: unknown, code: ToolErrorCode): error is ToolError {
  return isToolError(error) && error.code === code;
}
