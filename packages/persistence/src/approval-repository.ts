/**
 * Phase 10 Stage E2 — Approval persistence.
 *
 * Driver-independent approval repository interface and a sql.js implementation.
 * Operates on plain record objects that mirror the Stage E1 Approval domain
 * contract. Validation uses Zod schemas that mirror the domain contracts.
 *
 * Every approval decision is persisted as its own row, keyed by approvalId.
 * Historical decisions are never silently overwritten: creating a duplicate
 * approvalId fails deterministically (primary-key violation), and each
 * proposal version binds to its own set of approval records through a foreign
 * key so an old-version approval can never be retargeted at a newer version.
 *
 * Persisted provenance is metadata only. The store faithfully persists the
 * supplied provenance label but never treats it as authenticated user approval;
 * trusted-user approval enforcement belongs to Stage E3.
 *
 * Lifecycle transitions mirror the Stage E1 approval state machine
 * (packages/workspace/src/editing/approval-lifecycle.ts) so invalid states and
 * forbidden transitions are rejected at the persistence boundary.
 *
 * No filesystem access, no VS Code imports, no model-facing tools, no I/O of
 * any kind beyond the supplied sql.js database handle.
 */

import type { SQLDatabase } from './PersistenceService.js';
import { PersistenceError } from './PersistenceService.js';
import z from 'zod';

type SqlValue = string | number | Uint8Array | null;

// Approval lifecycle mirrors the Stage E1 approval domain contract
// (packages/workspace/src/editing/approval-contracts.ts / approval-schemas.ts).
export const ApprovalLifecycleStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
]);
export type ApprovalLifecycleState = z.infer<typeof ApprovalLifecycleStateSchema>;

export const ApprovalDecisionSchema = z.enum(['approve', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ContentHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'content hash must be a lowercase SHA-256 hex string (64 hex chars)');

export const TimestampSchema = z
  .number()
  .int('timestamp must be an integer')
  .positive('timestamp must be a positive millisecond value');
export type Timestamp = z.infer<typeof TimestampSchema>;

export const ApprovalProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('trusted-boundary'),
    boundary: z.string().min(1, 'trusted boundary identifier is required'),
  }),
  z.object({ kind: z.literal('model-tool-input') }),
  z.object({ kind: z.literal('proposal-creation') }),
  z.object({
    kind: z.literal('untrusted'),
    reason: z.string().min(1, 'untrusted provenance reason is required'),
  }),
]);
export type ApprovalProvenance = z.infer<typeof ApprovalProvenanceSchema>;

export interface ApprovalRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: ApprovalDecision | null;
  readonly approvedContentHash: string;
  readonly decidedAt: Timestamp | null;
  readonly provenance: ApprovalProvenance;
  readonly lifecycleState: ApprovalLifecycleState;
  readonly expiresAt: Timestamp | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: Timestamp;
}

export interface CreateApprovalInput {
  readonly id: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly decision: ApprovalDecision | null;
  readonly approvedContentHash: string;
  readonly decidedAt: Timestamp | null;
  readonly provenance: ApprovalProvenance;
  readonly lifecycleState: ApprovalLifecycleState;
  readonly expiresAt: Timestamp | null;
  readonly workspaceId: string;
  readonly fileUri: string;
  readonly createdAt: Timestamp;
}

const ApprovalRecordSchema = z.object({
  id: z.string().uuid('approvalId must be a valid UUID'),
  proposalId: z.string().uuid('proposalId must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  decision: ApprovalDecisionSchema.nullable(),
  approvedContentHash: ContentHashSchema,
  decidedAt: TimestampSchema.nullable(),
  provenance: ApprovalProvenanceSchema,
  lifecycleState: ApprovalLifecycleStateSchema,
  expiresAt: z.number().int().nonnegative().nullable(),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
  createdAt: TimestampSchema,
});

const VALID_TRANSITIONS: Record<ApprovalLifecycleState, readonly ApprovalLifecycleState[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['revoked', 'expired'],
  rejected: [],
  expired: [],
  revoked: [],
};

function applyApprovalTransition(
  currentState: ApprovalLifecycleState,
  nextState: ApprovalLifecycleState
): ApprovalLifecycleState {
  if (currentState === nextState) {
    return currentState;
  }
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed || !allowed.includes(nextState)) {
    throw new Error(
      `Invalid approval lifecycle transition from '${currentState}' to '${nextState}'`
    );
  }
  return nextState;
}

function validateCreateApprovalInput(input: CreateApprovalInput): ApprovalRecord {
  const record = ApprovalRecordSchema.parse(input);

  if (record.lifecycleState === 'pending') {
    if (record.decision !== null || record.decidedAt !== null) {
      throw new Error('a pending approval must have no decision and no decidedAt');
    }
  } else {
    if (record.decision === null || record.decidedAt === null) {
      throw new Error('a decided approval must have a decision and a decidedAt');
    }
  }

  if (record.decision === 'reject' && record.lifecycleState !== 'rejected') {
    throw new Error('a rejection decision must have lifecycle state rejected');
  }

  if (
    record.decision === 'approve' &&
    !['approved', 'expired', 'revoked'].includes(record.lifecycleState)
  ) {
    throw new Error('an approval decision must have lifecycle state approved, expired, or revoked');
  }

  return record;
}

export interface ApprovalResult {
  approval: ApprovalRecord | null;
  error: PersistenceError | null;
}

export interface ApprovalListResult {
  approvals: ApprovalRecord[];
  error: PersistenceError | null;
}

export interface ApprovalListFilter {
  readonly proposalId?: string;
  readonly proposalVersion?: number;
  readonly lifecycleState?: ApprovalLifecycleState;
  readonly decision?: ApprovalDecision;
}

export interface ApprovalRepository {
  createApproval(input: CreateApprovalInput): Promise<ApprovalResult>;
  getApproval(approvalId: string): Promise<ApprovalResult>;
  getApprovalsByProposal(proposalId: string, proposalVersion?: number): Promise<ApprovalListResult>;
  getApprovalForVersion(proposalId: string, proposalVersion: number): Promise<ApprovalResult>;
  updateApprovalLifecycle(
    approvalId: string,
    nextState: ApprovalLifecycleState
  ): Promise<ApprovalResult>;
  recordExpiration(approvalId: string): Promise<ApprovalResult>;
  recordRevocation(approvalId: string): Promise<ApprovalResult>;
  listApprovals(
    filter?: ApprovalListFilter,
    limit?: number,
    offset?: number
  ): Promise<ApprovalListResult>;
}

const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 50;

const APPROVAL_COLUMNS =
  'id, proposal_id, proposal_version, decision, approved_content_hash, decided_at, ' +
  'provenance, lifecycle_state, expires_at, workspace_id, file_uri, created_at';

function mapApprovalRow(row: unknown[]): ApprovalRecord {
  return {
    id: row[0] as string,
    proposalId: row[1] as string,
    proposalVersion: row[2] as number,
    decision: row[3] as ApprovalDecision | null,
    approvedContentHash: row[4] as string,
    decidedAt: (row[5] as number | null) ?? null,
    provenance: ApprovalProvenanceSchema.parse(JSON.parse(row[6] as string)),
    lifecycleState: row[7] as ApprovalLifecycleState,
    expiresAt: (row[8] as number | null) ?? null,
    workspaceId: row[9] as string,
    fileUri: row[10] as string,
    createdAt: row[11] as number,
  };
}

export class SqlJsApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: SQLDatabase) {}

  async createApproval(input: CreateApprovalInput): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const record = validateCreateApprovalInput(input);

      // The foreign key guarantees the referenced proposal version exists.
      // Additionally bind the approval to the persisted content hash so an
      // approval cannot be created against a mismatched version or hash.
      const proposalHashResult = this.db.exec(
        `SELECT proposed_content_hash FROM proposal_versions WHERE id = ? AND proposal_version = ?`,
        [record.proposalId, record.proposalVersion] as SqlValue[]
      );
      if (
        proposalHashResult.length === 0 ||
        proposalHashResult[0].values.length === 0
      ) {
        throw new Error(
          `Referenced proposal version not found: ${record.proposalId}/${record.proposalVersion}`
        );
      }
      const persistedHash = proposalHashResult[0].values[0][0] as string;
      if (persistedHash !== record.approvedContentHash) {
        throw new Error(
          `approvedContentHash does not match the persisted content hash for proposal version ${record.proposalId}/${record.proposalVersion}`
        );
      }

      this.db.exec(
        `INSERT INTO approval_decisions (${APPROVAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.proposalId,
          record.proposalVersion,
          record.decision,
          record.approvedContentHash,
          record.decidedAt,
          JSON.stringify(record.provenance),
          record.lifecycleState,
          record.expiresAt,
          record.workspaceId,
          record.fileUri,
          record.createdAt,
        ] as SqlValue[]
      );

      return { approval: record, error: null };
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to create approval',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async getApproval(approvalId: string): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        `SELECT ${APPROVAL_COLUMNS} FROM approval_decisions WHERE id = ?`,
        [approvalId] as SqlValue[]
      );
      if (result.length === 0 || result[0].values.length === 0) {
        return { approval: null, error: null };
      }
      return { approval: mapApprovalRow(result[0].values[0]), error: null };
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to get approval',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async getApprovalsByProposal(
    proposalId: string,
    proposalVersion?: number
  ): Promise<ApprovalListResult> {
    await Promise.resolve();
    try {
      let sql = `SELECT ${APPROVAL_COLUMNS} FROM approval_decisions WHERE proposal_id = ?`;
      const params: unknown[] = [proposalId];

      if (proposalVersion !== undefined) {
        sql += ' AND proposal_version = ?';
        params.push(proposalVersion);
      }

      sql += ' ORDER BY created_at ASC, id ASC';

      const result = this.db.exec(sql, params as SqlValue[]);
      const approvals = result.length > 0 ? result[0].values.map(mapApprovalRow) : [];
      return { approvals, error: null };
    } catch (error) {
      return {
        approvals: [],
        error: new PersistenceError(
          'Failed to list approvals by proposal',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async getApprovalForVersion(
    proposalId: string,
    proposalVersion: number
  ): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        `SELECT ${APPROVAL_COLUMNS} FROM approval_decisions WHERE proposal_id = ? AND proposal_version = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [proposalId, proposalVersion] as SqlValue[]
      );
      if (result.length === 0 || result[0].values.length === 0) {
        return { approval: null, error: null };
      }
      return { approval: mapApprovalRow(result[0].values[0]), error: null };
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to get approval for version',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async updateApprovalLifecycle(
    approvalId: string,
    nextState: ApprovalLifecycleState
  ): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const existing = await this.getApproval(approvalId);
      if (existing.error !== null) {
        return { approval: null, error: existing.error };
      }
      if (existing.approval === null) {
        return { approval: null, error: new PersistenceError('Approval not found') };
      }

      let resolvedNext: ApprovalLifecycleState;
      try {
        resolvedNext = applyApprovalTransition(existing.approval.lifecycleState, nextState);
      } catch (error) {
        return {
          approval: null,
          error: new PersistenceError(
            'Invalid lifecycle transition',
            error instanceof Error ? error : undefined
          ),
        };
      }

      if (resolvedNext === existing.approval.lifecycleState) {
        return existing;
      }

      this.db.exec(`UPDATE approval_decisions SET lifecycle_state = ? WHERE id = ?`, [
        resolvedNext,
        approvalId,
      ] as SqlValue[]);

      return this.getApproval(approvalId);
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to update approval lifecycle',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async recordExpiration(approvalId: string): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const existing = await this.getApproval(approvalId);
      if (existing.error !== null) {
        return { approval: null, error: existing.error };
      }
      if (existing.approval === null) {
        return { approval: null, error: new PersistenceError('Approval not found') };
      }

      const current = existing.approval.lifecycleState;
      // Only pending or approved approvals can expire; terminal rejected/revoked
      // approvals are left unchanged (mirrors Stage E1 markExpired).
      if (current === 'expired' || current === 'rejected' || current === 'revoked') {
        return existing;
      }
      if (current !== 'pending' && current !== 'approved') {
        return existing;
      }

      this.db.exec(`UPDATE approval_decisions SET lifecycle_state = 'expired' WHERE id = ?`, [
        approvalId,
      ] as SqlValue[]);

      return this.getApproval(approvalId);
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to record expiration',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async recordRevocation(approvalId: string): Promise<ApprovalResult> {
    await Promise.resolve();
    try {
      const existing = await this.getApproval(approvalId);
      if (existing.error !== null) {
        return { approval: null, error: existing.error };
      }
      if (existing.approval === null) {
        return { approval: null, error: new PersistenceError('Approval not found') };
      }

      const current = existing.approval.lifecycleState;
      // Only an approved approval can be revoked.
      if (current !== 'approved') {
        return {
          approval: null,
          error: new PersistenceError(
            `Only an approved approval can be revoked; current state is '${current}'`
          ),
        };
      }

      this.db.exec(`UPDATE approval_decisions SET lifecycle_state = 'revoked' WHERE id = ?`, [
        approvalId,
      ] as SqlValue[]);

      return this.getApproval(approvalId);
    } catch (error) {
      return {
        approval: null,
        error: new PersistenceError(
          'Failed to record revocation',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async listApprovals(
    filter?: ApprovalListFilter,
    limit: number = DEFAULT_LIST_LIMIT,
    offset: number = 0
  ): Promise<ApprovalListResult> {
    await Promise.resolve();
    try {
      const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
      const safeOffset = Math.max(offset, 0);

      let sql = `SELECT ${APPROVAL_COLUMNS} FROM approval_decisions`;
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (filter?.proposalId) {
        conditions.push('proposal_id = ?');
        params.push(filter.proposalId);
      }
      if (filter?.proposalVersion !== undefined) {
        conditions.push('proposal_version = ?');
        params.push(filter.proposalVersion);
      }
      if (filter?.lifecycleState) {
        conditions.push('lifecycle_state = ?');
        params.push(filter.lifecycleState);
      }
      if (filter?.decision) {
        conditions.push('decision = ?');
        params.push(filter.decision);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY created_at ASC, id ASC';
      sql += ' LIMIT ? OFFSET ?';
      params.push(safeLimit, safeOffset);

      const result = this.db.exec(sql, params as SqlValue[]);
      const approvals = result.length > 0 ? result[0].values.map(mapApprovalRow) : [];
      return { approvals, error: null };
    } catch (error) {
      return {
        approvals: [],
        error: new PersistenceError(
          'Failed to list approvals',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }
}
