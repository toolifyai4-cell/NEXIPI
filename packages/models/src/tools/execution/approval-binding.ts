/**
 * Phase 11 Stage B — Approval binding foundations for terminal execution.
 *
 * Defines the immutable data used to bind an approval to an exact terminal
 * execution request. Changing any execution-relevant field invalidates the
 * binding.
 *
 * Trusted user approval and persistence are intentionally NOT implemented
 * here; they belong to Stage E, which reuses the Phase 10 trusted approval
 * architecture. Raw secret values are never hashed or exposed as ordinary
 * approval metadata: environment configuration is referenced by identity
 * only.
 */

import { createHash } from 'node:crypto';
import type { ApprovalBinding, EnvironmentConfigId } from './contracts.js';
import { TerminalErrorCode, createTerminalError } from './errors.js';

/**
 * Fields that contribute to the approval binding content hash. All are
 * execution-relevant: changing any one of them invalidates the binding.
 */
export interface ApprovalBindingFields {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceId: string;
  readonly environmentConfigId: EnvironmentConfigId | undefined;
}

/**
 * Signature of a content-hash function. The default uses SHA-256 over a
 * canonical UTF-8 serialization. Injecting a test double makes binding
 * determinism testable without real cryptography.
 */
export type ContentHashFunction = (fields: ApprovalBindingFields) => string;

/**
 * Default content hash: lowercase hexadecimal SHA-256 over a deterministic,
 * key-ordered JSON serialization of the binding fields. Environment secret
 * values are never included; only the environment config identity is.
 */
export const defaultContentHash: ContentHashFunction = fields => {
  const canonical = JSON.stringify({
    executable: fields.executable,
    arguments: fields.arguments,
    workingDirectory: fields.workingDirectory,
    workspaceId: fields.workspaceId,
    environmentConfigId: fields.environmentConfigId,
  });
  const buffer = Buffer.from(canonical, 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
};

export interface CreateApprovalBindingInput {
  readonly bindingId: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceId: string;
  readonly environmentConfigId: EnvironmentConfigId | undefined;
  readonly createdAt?: number;
  readonly contentHashFunction?: ContentHashFunction | undefined;
}

/**
 * Creates an immutable approval binding bound to an exact execution request.
 *
 * The content hash is computed over the canonical serialization of the
 * execution-relevant fields. Any change to executable, arguments, working
 * directory, workspace, or environment config identity produces a different
 * hash and therefore invalidates the binding.
 *
 * Returns a new object; the input is never mutated.
 */
export function createApprovalBinding(input: CreateApprovalBindingInput): ApprovalBinding {
  const now = input.createdAt ?? Date.now();
  const hashFunction = input.contentHashFunction ?? defaultContentHash;

  const fields: ApprovalBindingFields = {
    executable: input.executable,
    arguments: input.arguments,
    workingDirectory: input.workingDirectory,
    workspaceId: input.workspaceId,
    environmentConfigId: input.environmentConfigId,
  };

  const contentHash = hashFunction(fields);

  return {
    kind: 'terminal-approval-binding',
    bindingId: input.bindingId,
    executable: fields.executable,
    arguments: [...fields.arguments],
    workingDirectory: fields.workingDirectory,
    workspaceId: fields.workspaceId,
    environmentConfigId: fields.environmentConfigId,
    contentHash,
    createdAt: now,
  };
}

/**
 * Computes the content hash for a set of binding fields using the default
 * SHA-256 function. Exposed so callers can pre-compute or compare hashes
 * without constructing a full binding.
 */
export function computeContentHash(fields: ApprovalBindingFields): string {
  return defaultContentHash(fields);
}

/**
 * Verifies that a terminal command matches an existing approval binding.
 *
 * Returns true only when executable, ordered arguments, working directory,
 * workspace id, and environment config identity all match the binding's
 * content hash. Any mismatch invalidates the binding.
 *
 * The comparison is performed by recomputing the hash from the command and
 * comparing it to the binding's stored hash, so a binding can never be
 * satisfied by a superset or reordered argument list.
 */
export function approvalBindingMatchesCommand(
  binding: ApprovalBinding,
  command: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly workspaceId: string;
    readonly environmentConfigId?: EnvironmentConfigId | undefined;
  },
  contentHashFunction: ContentHashFunction = defaultContentHash
): boolean {
  const fields: ApprovalBindingFields = {
    executable: command.executable,
    arguments: command.arguments,
    workingDirectory: command.workingDirectory,
    workspaceId: command.workspaceId,
    environmentConfigId: command.environmentConfigId ?? undefined,
  };
  return contentHashFunction(fields) === binding.contentHash;
}

/**
 * Throws TerminalError when a command does not match an approval
 * binding. Use this at the authorization boundary to fail closed on any
 * execution-context modification.
 *
 * @throws TerminalError with code TERMINAL_APPROVAL_BINDING_MISMATCH
 *         when the command does not match the binding.
 */
export function assertApprovalBindingMatchesCommand(
  binding: ApprovalBinding,
  command: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly workspaceId: string;
    readonly environmentConfigId?: EnvironmentConfigId | undefined;
  },
  contentHashFunction: ContentHashFunction = defaultContentHash
): void {
  if (!approvalBindingMatchesCommand(binding, command, contentHashFunction)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH,
      `Approval binding '${binding.bindingId}' does not match the requested command '${binding.executable}'`,
      { terminalId: binding.bindingId }
    );
  }
}
