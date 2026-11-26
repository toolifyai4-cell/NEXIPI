/**
 * Phase 10 Stage B — Editing domain errors.
 *
 * Self-contained error type for pure domain logic. Does not depend on
 * @nexipi/models/tools or Phase 09 error codes to keep the editing module
 * independently testable.
 */

export class EditDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EditDomainError';
    this.code = code;
    Object.setPrototypeOf(this, EditDomainError.prototype);
  }
}
