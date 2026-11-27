/**
 * Phase 11 Stage B — Terminal execution domain errors.
 *
 * Typed errors for the terminal execution domain. Reuses EngineError from
 * @nexipi/core, which sanitizes error context and never serializes raw
 * messages, causes, stacks, or secrets.
 *
 * Error codes cover invalid requests, lifecycle transitions, execution
 * results, execution identities, approval binding mismatches, unsupported
 * configurations, and output limit violations.
 */

import { EngineError } from '@nexipi/core';

export enum TerminalErrorCode {
  TERMINAL_INVALID_REQUEST = 'TERMINAL_INVALID_REQUEST',
  TERMINAL_INVALID_TRANSITION = 'TERMINAL_INVALID_TRANSITION',
  TERMINAL_INVALID_RESULT = 'TERMINAL_INVALID_RESULT',
  TERMINAL_INVALID_IDENTITY = 'TERMINAL_INVALID_IDENTITY',
  TERMINAL_APPROVAL_BINDING_MISMATCH = 'TERMINAL_APPROVAL_BINDING_MISMATCH',
  TERMINAL_UNSUPPORTED_CONFIGURATION = 'TERMINAL_UNSUPPORTED_CONFIGURATION',
  TERMINAL_OUTPUT_LIMIT_VIOLATION = 'TERMINAL_OUTPUT_LIMIT_VIOLATION',
}

export interface TerminalErrorOptions {
  readonly terminalId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly cause?: Error | undefined;
  readonly context?: Record<string, unknown> | undefined;
  readonly retryable?: boolean | undefined;
}

export class TerminalError extends EngineError<TerminalErrorCode> {
  public readonly terminalId: string | undefined;
  public readonly requestId: string | undefined;
  public readonly retryable: boolean;

  constructor(code: TerminalErrorCode, message: string, options: TerminalErrorOptions = {}) {
    super(code, message, {
      cause: options.cause,
      context: options.context,
    });
    Object.setPrototypeOf(this, TerminalError.prototype);
    this.name = 'TerminalError';
    this.terminalId = options.terminalId ?? undefined;
    this.requestId = options.requestId ?? undefined;
    this.retryable = options.retryable ?? false;
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: 'TerminalError',
      code: this.code,
      terminalId: this.terminalId,
      requestId: this.requestId,
      retryable: this.retryable,
    };
  }
}

export function createTerminalError(
  code: TerminalErrorCode,
  message: string,
  options: TerminalErrorOptions = {}
): TerminalError {
  return new TerminalError(code, message, options);
}

export function isTerminalError(error: unknown): error is TerminalError {
  return error instanceof TerminalError;
}

export function isTerminalErrorCode(error: unknown, code: TerminalErrorCode): error is TerminalError {
  return isTerminalError(error) && error.code === code;
}
