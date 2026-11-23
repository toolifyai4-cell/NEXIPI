import { EngineError, type EngineErrorOptions } from '@nexipi/core';

export enum RankingErrorCode {
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
  INVALID_QUERY = 'INVALID_QUERY',
  CANCELLED = 'CANCELLED',
  RANKING_FAILED = 'RANKING_FAILED',
  SELECTION_FAILED = 'SELECTION_FAILED',
}

export interface RankingErrorOptions extends EngineErrorOptions {
  readonly candidateId?: string;
}

export class RankingError extends EngineError<RankingErrorCode> {
  public readonly candidateId: string | undefined;

  constructor(code: RankingErrorCode, message: string, options: RankingErrorOptions = {}) {
    super(code, message, {
      cause: options.cause,
      context: options.context,
    });
    this.candidateId = options.candidateId;
    Object.setPrototypeOf(this, RankingError.prototype);
  }
}

export function createRankingError(
  code: RankingErrorCode,
  message: string,
  options: RankingErrorOptions = {}
): RankingError {
  return new RankingError(code, message, options);
}

export function isRankingError(error: unknown): error is RankingError {
  return error instanceof RankingError;
}

export class InvalidRankingConfigError extends RankingError {
  constructor(message: string, options: RankingErrorOptions = {}) {
    super(RankingErrorCode.INVALID_CONFIGURATION, message, options);
    Object.setPrototypeOf(this, InvalidRankingConfigError.prototype);
  }
}

export class InvalidQueryError extends RankingError {
  constructor(message: string, options: RankingErrorOptions = {}) {
    super(RankingErrorCode.INVALID_QUERY, message, options);
    Object.setPrototypeOf(this, InvalidQueryError.prototype);
  }
}

export class RankingCancelledError extends RankingError {
  constructor(message: string, options: RankingErrorOptions = {}) {
    super(RankingErrorCode.CANCELLED, message, options);
    Object.setPrototypeOf(this, RankingCancelledError.prototype);
  }
}

export class RankingFailedError extends RankingError {
  constructor(message: string, options: RankingErrorOptions = {}) {
    super(RankingErrorCode.RANKING_FAILED, message, options);
    Object.setPrototypeOf(this, RankingFailedError.prototype);
  }
}

export class ContextSelectionError extends RankingError {
  constructor(message: string, options: RankingErrorOptions = {}) {
    super(RankingErrorCode.SELECTION_FAILED, message, options);
    Object.setPrototypeOf(this, ContextSelectionError.prototype);
  }
}
