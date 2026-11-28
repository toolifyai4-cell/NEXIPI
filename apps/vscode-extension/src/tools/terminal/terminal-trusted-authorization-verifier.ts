/**
 * Phase 11 Stage E — Trusted authorization verifier for terminal execution.
 *
 * Implements {@link TrustedAuthorizationVerifier} by delegating to the
 * existing Phase 10 {@link TrustedApprovalService}. The verifier is the sole
 * authority on whether a {@link TerminalAuthorizationCapability} was created
 * through the trusted approval boundary. Stage D never creates capabilities
 * and never trusts a caller-supplied object.
 *
 * Security properties:
 *   - Only capabilities produced by TrustedApprovalService (which itself
 *     requires a genuine user decision through the injected
 *     TrustedDecisionProvider) can pass verification.
 *   - Caller-created/plain `{ decision: 'approved' }` objects are rejected by
 *     the kind check.
 *   - The exact execution binding is preserved: the capability's
 *     boundContentHash must equal the SHA-256 of the submitted binding.
 *   - Single-use enforcement: a capability may verify successfully at most
 *     once. Reuse fails closed.
 *   - Expiry is enforced via the capability's expiresAt and the approval's
 *     expiry.
 *
 * The verifier is injected through trusted extension-side composition
 * (extension.ts), never selected or configured by model input.
 */

import type {
  TerminalAuthorizationBinding,
  TerminalAuthorizationCapability,
  TrustedAuthorizationVerifier,
} from '@nexipi/models/tools';
import type {
  ApprovalRepositoryPort,
  TrustedApprovalService,
} from '@nexipi/workspace';
import type { Logger } from '@nexipi/core';
import { createNoopLogger } from '@nexipi/core';

/**
 * Options for {@link TerminalTrustedAuthorizationVerifier}.
 */
export interface TerminalTrustedAuthorizationVerifierOptions {
  trustedApprovalService: TrustedApprovalService;
  approvals: ApprovalRepositoryPort;
  now?: () => number;
  logger?: Logger;
}

/**
 * Trusted authorization verifier backed by the Phase 10 trusted approval
 * service.
 *
 * A capability verifies only when TrustedApprovalService can derive a valid
 * AuthorizationToApply from it (approved state, trusted provenance, not
 * expired), AND the capability's bound content hash matches the submitted
 * execution binding exactly, AND the capability has not already been used.
 */
export class TerminalTrustedAuthorizationVerifier implements TrustedAuthorizationVerifier {
  private readonly service: TrustedApprovalService;
  private readonly approvals: ApprovalRepositoryPort;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly usedCapabilityIds = new Set<string>();

  constructor(options: TerminalTrustedAuthorizationVerifierOptions) {
    this.service = options.trustedApprovalService;
    this.approvals = options.approvals;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? createNoopLogger();
  }

  /**
   * Verifies that an authorization capability is valid for the given
   * execution binding.
   *
   * Returns true only when every check passes. Any failure returns false;
   * verifier infrastructure errors propagate.
   */
  async verify(
    capability: TerminalAuthorizationCapability | undefined,
    binding: TerminalAuthorizationBinding
  ): Promise<boolean> {
    // --- 1. Must be a boundary-created capability, not a plain object ---
    if (
      capability === undefined ||
      capability === null ||
      capability.kind !== 'terminal-authorization-capability'
    ) {
      this.logger.debug('Authorization verification failed: capability is not a terminal-authorization-capability');
      return false;
    }

    // --- 2. Single-use enforcement: reject already-consumed capabilities ---
    if (this.usedCapabilityIds.has(capability.capabilityId)) {
      this.logger.debug('Authorization verification failed: capability already used', {
        capabilityId: capability.capabilityId,
      });
      return false;
    }

    // --- 3. Verify through the trusted Phase 10 boundary ---
    // createAuthorizationToApply returns non-null only when the approval is
    // currently valid: approved state, trusted provenance, content hash
    // match, not expired. This is the sole producer of trusted
    // authorization; a caller cannot forge a valid capability.
    const now = this.now();
    const authorization = await this.service.createAuthorizationToApply(capability.capabilityId, now);
    if (authorization === null) {
      this.logger.debug('Authorization verification failed: trusted boundary returned no authorization', {
        capabilityId: capability.capabilityId,
      });
      return false;
    }

    // --- 4. Binding must match exactly ---
    // The capability's boundContentHash is the SHA-256 of the exact
    // execution binding. Any change to executable, arguments, working
    // directory, workspace, or environment config produces a different hash.
    if (authorization.contentHash !== binding.contentHash) {
      this.logger.debug('Authorization verification failed: authorization content hash does not match binding', {
        capabilityId: capability.capabilityId,
        authorizationContentHash: authorization.contentHash,
        bindingContentHash: binding.contentHash,
      });
      return false;
    }
    if (capability.boundContentHash !== binding.contentHash) {
      this.logger.debug('Authorization verification failed: capability bound content hash does not match binding', {
        capabilityId: capability.capabilityId,
        capabilityBoundContentHash: capability.boundContentHash,
        bindingContentHash: binding.contentHash,
      });
      return false;
    }

    // --- 5. Capability expiry ---
    if (capability.expiresAt !== undefined && now > capability.expiresAt) {
      this.logger.debug('Authorization verification failed: capability expired', {
        capabilityId: capability.capabilityId,
        expiresAt: capability.expiresAt,
        now,
      });
      return false;
    }

    // --- 6. Durable single-use consumption (persists across restarts) ---
    // Atomically transitions the approval 'approved' -> 'revoked'. Only the
    // first concurrent call can succeed; any replay finds the state no longer
    // 'approved' and fails closed. This is durable because revocation is
    // persisted, so a consumed capability cannot be replayed after restart.
    const consumeResult = await this.approvals.recordRevocation(capability.capabilityId);
    if (consumeResult.error !== null || consumeResult.approval === null) {
      this.logger.debug('Authorization verification failed: durable single-use consumption failed', {
        capabilityId: capability.capabilityId,
        error: consumeResult.error?.message ?? 'unknown error',
      });
      return false;
    }

    // --- 7. Mark as used (single-use, in-memory fast path) ---
    this.usedCapabilityIds.add(capability.capabilityId);

    this.logger.debug('Authorization verification succeeded', {
      capabilityId: capability.capabilityId,
      approvalId: authorization.approvalId,
    });
    return true;
  }

  /**
   * Returns the set of capability IDs that have been consumed. Used by tests
   * and diagnostics to assert single-use enforcement.
   */
  get usedCapabilityIdsSnapshot(): readonly string[] {
    return [...this.usedCapabilityIds];
  }
}
