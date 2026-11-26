/**
 * Phase 10 Stage E1 — Approval domain contracts.
 *
 * Pure, platform-independent type definitions for the edit approval domain.
 *
 * Three concepts are deliberately distinct and must never be treated as
 * interchangeable:
 *   1. Proposal (EditProposal, Stage B) — the proposed edit, with its own
 *      ProposalStatus lifecycle.
 *   2. Approval decision (Approval below) — a trusted user's decision about a
 *      specific proposal version and content hash.
 *   3. Authorization to apply (derived via ApprovalVerificationResult) —
 *      whether an approval permits applying a particular proposal version.
 *
 * No filesystem access, no VS Code imports, no model-facing tools, no
 * authentication system. Trusted-user authentication and UI interaction are
 * deferred to later stages; E1 defines only the seam through which a trusted
 * application service can create an approval decision.
 */

export type ApprovalId = string;
export type ProposalVersion = number;

export type ApprovalLifecycleState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked';

export type ApprovalDecision = 'approve' | 'reject';

/**
 * Provenance of an approval record. Only `trusted-boundary` provenance is
 * trusted. `model-tool-input` and `proposal-creation` provenance are never
 * accepted as proof of user approval, which enforces the central security
 * principle that model-generated actions and proposal creation cannot create a
 * trusted approval.
 */
export type ApprovalProvenance =
  | { readonly kind: 'trusted-boundary'; readonly boundary: string }
  | { readonly kind: 'model-tool-input' }
  | { readonly kind: 'proposal-creation' }
  | { readonly kind: 'untrusted'; readonly reason: string };

export interface Approval {
  readonly kind: 'edit-approval';
  readonly approvalId: ApprovalId;
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  /** Null while pending; set once a decision is made. */
  readonly decision: ApprovalDecision | null;
  readonly approvedContentHash: string;
  /** Null while pending; set once a decision is made. */
  readonly decidedAt: number | null;
  readonly provenance: ApprovalProvenance;
  readonly lifecycleState: ApprovalLifecycleState;
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: number;
}

export interface ApprovalDecisionRequest {
  readonly approvalId: ApprovalId;
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  readonly decision: ApprovalDecision;
  readonly approvedContentHash: string;
  readonly provenance: ApprovalProvenance;
  readonly decidedAt: number;
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
}

export interface ApprovalVerificationInput {
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  readonly contentHash: string;
  readonly now: number;
}

export interface ApprovalVerificationResult {
  readonly authorized: boolean;
  readonly approval: Approval | null;
  readonly reason: string | null;
  readonly versionMatches: boolean;
  readonly contentHashMatches: boolean;
  readonly statePermitsApplication: boolean;
  readonly notExpired: boolean;
  readonly provenanceTrusted: boolean;
}

export interface AuthorizationToApply {
  readonly approvalId: ApprovalId;
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  readonly contentHash: string;
  readonly authorizedAt: number;
}

/**
 * Seam through which a trusted application service creates an approval decision
 * (implemented in a later substage; E1 defines the contract only).
 */
export interface ApprovalCreationRequest {
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  readonly decision: ApprovalDecision;
  readonly approvedContentHash: string;
  readonly provenance: ApprovalProvenance;
  readonly decidedAt: number;
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
}

export interface ApprovalCreationResult {
  readonly approvalId: ApprovalId;
  readonly approval: Approval;
}

export interface ApprovalCreationBoundary {
  createApprovalDecision(request: ApprovalCreationRequest): Promise<ApprovalCreationResult>;
}

export function isTrustedProvenance(provenance: ApprovalProvenance): boolean {
  return provenance.kind === 'trusted-boundary';
}

export function isTerminalState(state: ApprovalLifecycleState): boolean {
  return state !== 'pending' && state !== 'approved';
}

export function isApplicationAuthorizedState(state: ApprovalLifecycleState): boolean {
  return state === 'approved';
}

export function isPendingState(state: ApprovalLifecycleState): boolean {
  return state === 'pending';
}

export interface CreatePendingApprovalInput {
  readonly approvalId: ApprovalId;
  readonly proposalId: string;
  readonly proposalVersion: ProposalVersion;
  readonly approvedContentHash: string;
  readonly provenance: ApprovalProvenance;
  readonly expiresAt: number | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: number;
}

/**
 * Creates a well-formed pending approval. A pending approval carries no
 * decision and no trusted decision provenance; it becomes trusted only when a
 * trusted boundary decides it via {@link decideApproval}.
 */
export function createPendingApproval(input: CreatePendingApprovalInput): Approval {
  return {
    kind: 'edit-approval',
    approvalId: input.approvalId,
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    decision: null,
    approvedContentHash: input.approvedContentHash,
    decidedAt: null,
    provenance: input.provenance,
    lifecycleState: 'pending',
    expiresAt: input.expiresAt,
    workspaceId: input.workspaceId,
    fileUri: input.fileUri,
    createdAt: input.createdAt,
  };
}
