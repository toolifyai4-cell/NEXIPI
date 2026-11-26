/**
 * Phase 10 Stage E1 — Approval domain errors.
 *
 * Typed errors for the approval domain. Reuses the existing EditDomainError
 * convention (code + message) through a single ApprovalDomainError subclass so
 * callers can distinguish approval errors from general editing errors without
 * introducing a redundant error hierarchy.
 */

import { EditDomainError } from './errors.js';

export class ApprovalDomainError extends EditDomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ApprovalDomainError';
    Object.setPrototypeOf(this, ApprovalDomainError.prototype);
  }
}

export const ApprovalErrorCode = {
  INVALID_ID: 'APPROVAL_INVALID_ID',
  INVALID_VERSION: 'APPROVAL_INVALID_VERSION',
  INVALID_HASH: 'APPROVAL_INVALID_HASH',
  INVALID_TIMESTAMP: 'APPROVAL_INVALID_TIMESTAMP',
  INVALID_STATE: 'APPROVAL_INVALID_STATE',
  INVALID_PROVENANCE: 'APPROVAL_INVALID_PROVENANCE',
  INVALID_TRANSITION: 'APPROVAL_INVALID_TRANSITION',
  NOT_PENDING: 'APPROVAL_NOT_PENDING',
  STALE_VERSION: 'APPROVAL_STALE_VERSION',
  CONTENT_HASH_MISMATCH: 'APPROVAL_CONTENT_HASH_MISMATCH',
  NOT_AUTHORIZED: 'APPROVAL_NOT_AUTHORIZED',
  TERMINAL_STATE: 'APPROVAL_TERMINAL_STATE',
  TRUSTED_BOUNDARY_UNAVAILABLE: 'APPROVAL_TRUSTED_BOUNDARY_UNAVAILABLE',
  TRUSTED_DECISION_NOT_ESTABLISHED: 'APPROVAL_TRUSTED_DECISION_NOT_ESTABLISHED',
} as const;

export type ApprovalErrorCode = (typeof ApprovalErrorCode)[keyof typeof ApprovalErrorCode];

export function createApprovalError(code: ApprovalErrorCode, message: string): ApprovalDomainError {
  return new ApprovalDomainError(code, message);
}
