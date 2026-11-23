import {
  EngineError,
  type EngineErrorOptions,
} from '@nexipi/core';
import type { ScanId } from './scan-types.js';

export enum ScanErrorCode {
  SCAN_INITIALIZATION_FAILED = 'SCAN_INITIALIZATION_FAILED',
  WORKSPACE_DISCOVERY_FAILED = 'WORKSPACE_DISCOVERY_FAILED',
  FILE_DISCOVERY_FAILED = 'FILE_DISCOVERY_FAILED',
  SCAN_CANCELLED = 'SCAN_CANCELLED',
  QUEUE_OVERFLOW = 'QUEUE_OVERFLOW',
  INVALID_WORKSPACE_STATE = 'INVALID_WORKSPACE_STATE',
  INCREMENTAL_REFRESH_FAILED = 'INCREMENTAL_REFRESH_FAILED',
  DISPOSAL_FAILED = 'DISPOSAL_FAILED',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  SCAN_NOT_FOUND = 'SCAN_NOT_FOUND',
}

export interface ScanErrorOptions extends EngineErrorOptions {
  readonly scanId?: ScanId;
}

export class ScanError extends EngineError<ScanErrorCode> {
  public readonly scanId: ScanId | undefined;

  constructor(code: ScanErrorCode, message: string, options: ScanErrorOptions = {}) {
    super(code, message, {
      cause: options.cause,
      context: options.context,
    });
    this.scanId = options.scanId;
    Object.setPrototypeOf(this, ScanError.prototype);
  }
}

export function createScanError(
  code: ScanErrorCode,
  message: string,
  options: ScanErrorOptions = {}
): ScanError {
  return new ScanError(code, message, options);
}

export function isScanError(error: unknown): error is ScanError {
  return error instanceof ScanError;
}

export class ScanInitializationError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.SCAN_INITIALIZATION_FAILED, message, options);
    Object.setPrototypeOf(this, ScanInitializationError.prototype);
  }
}

export class WorkspaceDiscoveryError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.WORKSPACE_DISCOVERY_FAILED, message, options);
    Object.setPrototypeOf(this, WorkspaceDiscoveryError.prototype);
  }
}

export class FileDiscoveryError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.FILE_DISCOVERY_FAILED, message, options);
    Object.setPrototypeOf(this, FileDiscoveryError.prototype);
  }
}

export class ScanCancelledError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.SCAN_CANCELLED, message, options);
    Object.setPrototypeOf(this, ScanCancelledError.prototype);
  }
}

export class QueueOverflowError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.QUEUE_OVERFLOW, message, options);
    Object.setPrototypeOf(this, QueueOverflowError.prototype);
  }
}

export class InvalidWorkspaceStateError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.INVALID_WORKSPACE_STATE, message, options);
    Object.setPrototypeOf(this, InvalidWorkspaceStateError.prototype);
  }
}

export class IncrementalRefreshError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.INCREMENTAL_REFRESH_FAILED, message, options);
    Object.setPrototypeOf(this, IncrementalRefreshError.prototype);
  }
}

export class DisposalError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.DISPOSAL_FAILED, message, options);
    Object.setPrototypeOf(this, DisposalError.prototype);
  }
}

export class InvalidStateTransitionError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.INVALID_STATE_TRANSITION, message, options);
    Object.setPrototypeOf(this, InvalidStateTransitionError.prototype);
  }
}

export class ScanNotFoundError extends ScanError {
  constructor(message: string, options: ScanErrorOptions = {}) {
    super(ScanErrorCode.SCAN_NOT_FOUND, message, options);
    Object.setPrototypeOf(this, ScanNotFoundError.prototype);
  }
}

export function toScanError(error: unknown, defaultCode: ScanErrorCode): ScanError {
  if (isScanError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new ScanError(defaultCode, error.message, { cause: error });
  }
  return new ScanError(defaultCode, String(error));
}
