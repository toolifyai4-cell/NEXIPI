import {
  EngineError,
  EngineErrorCode,
  type EngineErrorOptions,
  createSanitizedContext,
} from '@nexipi/core';

export enum ToolErrorCode {
  TOOL_INVALID_ARGUMENT = 'TOOL_INVALID_ARGUMENT',
  TOOL_PATH_OUTSIDE_WORKSPACE = 'TOOL_PATH_OUTSIDE_WORKSPACE',
  TOOL_PATH_TRAVERSAL = 'TOOL_PATH_TRAVERSAL',
  TOOL_FILE_NOT_FOUND = 'TOOL_FILE_NOT_FOUND',
  TOOL_NOT_A_FILE = 'TOOL_NOT_A_FILE',
  TOOL_NOT_A_DIRECTORY = 'TOOL_NOT_A_DIRECTORY',
  TOOL_SYMLINK_NOT_ALLOWED = 'TOOL_SYMLINK_NOT_ALLOWED',
  TOOL_FILE_IGNORED = 'TOOL_FILE_IGNORED',
  TOOL_FILE_SENSITIVE = 'TOOL_FILE_SENSITIVE',
  TOOL_FILE_BINARY = 'TOOL_FILE_BINARY',
  TOOL_FILE_TOO_LARGE = 'TOOL_FILE_TOO_LARGE',
  TOOL_OUTPUT_TOO_LARGE = 'TOOL_OUTPUT_TOO_LARGE',
  TOOL_CANCELLED = 'TOOL_CANCELLED',
  TOOL_FILESYSTEM_ERROR = 'TOOL_FILESYSTEM_ERROR',
  TOOL_INTERNAL_ERROR = 'TOOL_INTERNAL_ERROR',
}

export interface ToolErrorOptions extends EngineErrorOptions {
  readonly path?: string | undefined;
}

export class ToolError extends EngineError<ToolErrorCode> {
  public readonly path: string | undefined;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(code, message, {
      cause: options.cause,
      context: createSanitizedContext({
        ...options.context,
        ...(options.path !== undefined ? { path: options.path } : undefined),
      }),
    });
    this.path = options.path;
    Object.setPrototypeOf(this, ToolError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      path: this.path,
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

export function isToolErrorCode(
  error: unknown,
  code: ToolErrorCode
): error is ToolError {
  return isToolError(error) && error.code === code;
}
