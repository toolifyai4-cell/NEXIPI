/**
 * Phase 10 Stage E2 — Proposal persistence.
 *
 * Driver-independent proposal repository interface and a sql.js implementation.
 * Operates on plain record objects that mirror the Stage B EditProposal domain
 * contract. Validation uses Zod schemas that mirror the domain contracts.
 *
 * The complete proposed file content is preserved (`proposed_content`) so it can
 * be used for eventual authorized application; no truncated or preview model
 * output is ever stored as the edit.
 *
 * No filesystem access, no VS Code imports, no model-facing tools, no I/O of
 * any kind beyond the supplied sql.js database handle.
 */

import type { SQLDatabase } from './PersistenceService.js';
import { PersistenceError } from './PersistenceService.js';
import z from 'zod';

type SqlValue = string | number | Uint8Array | null;

// Proposal status mirrors the Stage B editing domain contract
// (packages/workspace/src/editing/contracts.ts ProposalStatus).
export const ProposalStatusSchema = z.enum([
  'pending-validation',
  'validated',
  'awaiting-approval',
  'approved',
  'applied',
  'rejected',
  'expired',
  'failed',
  'cancelled',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export interface ProposalRecord {
  readonly id: string;
  readonly proposalVersion: number;
  readonly workspaceId: string;
  readonly workspaceFolderUri: string;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly originalContentHash: string;
  readonly originalSize: number;
  readonly originalMtime: number;
  readonly operations: readonly unknown[];
  readonly proposedContent: string;
  readonly proposedContentHash: string;
  readonly proposedSize: number;
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface CreateProposalInput {
  readonly id: string;
  readonly proposalVersion: number;
  readonly workspaceId: string;
  readonly workspaceFolderUri: string;
  readonly fileUri: string;
  readonly relativePath: string;
  readonly originalContentHash: string;
  readonly originalSize: number;
  readonly originalMtime: number;
  readonly operations: readonly unknown[];
  readonly proposedContent: string;
  readonly proposedContentHash: string;
  readonly proposedSize: number;
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export const ProposalRecordSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
  proposalVersion: z.number().int().positive().max(999),
  workspaceId: z.string().min(1, 'workspaceId is required'),
  workspaceFolderUri: z.string().min(1, 'workspaceFolderUri is required'),
  fileUri: z.string().min(1, 'fileUri is required'),
  relativePath: z.string().min(1, 'relativePath is required'),
  originalContentHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      'originalContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
    ),
  originalSize: z.number().int().nonnegative(),
  originalMtime: z.number().int().nonnegative(),
  operations: z.array(z.unknown()).min(1).max(50),
  proposedContent: z.string(),
  proposedContentHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      'proposedContentHash must be a lowercase SHA-256 hex string (64 hex chars)'
    ),
  proposedSize: z.number().int().nonnegative(),
  status: ProposalStatusSchema,
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})
  .refine(data => data.expiresAt > data.createdAt, 'expiresAt must be after createdAt');

export type ValidatedProposal = z.infer<typeof ProposalRecordSchema>;

export interface ProposalResult {
  proposal: ProposalRecord | null;
  error: PersistenceError | null;
}

export interface ProposalListResult {
  proposals: ProposalRecord[];
  error: PersistenceError | null;
}

export interface ProposalListFilter {
  readonly proposalId?: string;
  readonly status?: ProposalStatus;
  readonly workspaceId?: string;
  readonly fileUri?: string;
}

export interface ProposalRepository {
  createProposal(input: CreateProposalInput): Promise<ProposalResult>;
  getProposal(proposalId: string, proposalVersion: number): Promise<ProposalResult>;
  getProposalById(proposalId: string): Promise<ProposalListResult>;
  updateProposalStatus(
    proposalId: string,
    proposalVersion: number,
    status: ProposalStatus
  ): Promise<ProposalResult>;
  listProposals(
    filter?: ProposalListFilter,
    limit?: number,
    offset?: number
  ): Promise<ProposalListResult>;
}

const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 50;

const PROPOSAL_COLUMNS =
  'id, proposal_version, workspace_id, workspace_folder_uri, file_uri, relative_path, ' +
  'original_content_hash, original_size, original_mtime, operations, proposed_content, ' +
  'proposed_content_hash, proposed_size, status, created_at, expires_at';

function mapProposalRow(row: unknown[]): ProposalRecord {
  return {
    id: row[0] as string,
    proposalVersion: row[1] as number,
    workspaceId: row[2] as string,
    workspaceFolderUri: row[3] as string,
    fileUri: row[4] as string,
    relativePath: row[5] as string,
    originalContentHash: row[6] as string,
    originalSize: row[7] as number,
    originalMtime: row[8] as number,
    operations: JSON.parse(row[9] as string) as readonly unknown[],
    proposedContent: row[10] as string,
    proposedContentHash: row[11] as string,
    proposedSize: row[12] as number,
    status: row[13] as ProposalStatus,
    createdAt: row[14] as number,
    expiresAt: row[15] as number,
  };
}

export class SqlJsProposalRepository implements ProposalRepository {
  constructor(private readonly db: SQLDatabase) {}

  async createProposal(input: CreateProposalInput): Promise<ProposalResult> {
    await Promise.resolve();
    try {
      const record = ProposalRecordSchema.parse(input);

      this.db.exec(
        `INSERT INTO proposal_versions (${PROPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.proposalVersion,
          record.workspaceId,
          record.workspaceFolderUri,
          record.fileUri,
          record.relativePath,
          record.originalContentHash,
          record.originalSize,
          record.originalMtime,
          JSON.stringify(record.operations),
          record.proposedContent,
          record.proposedContentHash,
          record.proposedSize,
          record.status,
          record.createdAt,
          record.expiresAt,
        ] as SqlValue[]
      );

      return { proposal: record, error: null };
    } catch (error) {
      return {
        proposal: null,
        error: new PersistenceError(
          'Failed to create proposal',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async getProposal(
    proposalId: string,
    proposalVersion: number
  ): Promise<ProposalResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        `SELECT ${PROPOSAL_COLUMNS} FROM proposal_versions WHERE id = ? AND proposal_version = ?`,
        [proposalId, proposalVersion] as SqlValue[]
      );
      if (result.length === 0 || result[0].values.length === 0) {
        return { proposal: null, error: null };
      }
      return { proposal: mapProposalRow(result[0].values[0]), error: null };
    } catch (error) {
      return {
        proposal: null,
        error: new PersistenceError(
          'Failed to get proposal',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async getProposalById(proposalId: string): Promise<ProposalListResult> {
    await Promise.resolve();
    try {
      const result = this.db.exec(
        `SELECT ${PROPOSAL_COLUMNS} FROM proposal_versions WHERE id = ? ORDER BY proposal_version ASC`,
        [proposalId] as SqlValue[]
      );
      const proposals =
        result.length > 0 ? result[0].values.map(mapProposalRow) : [];
      return { proposals, error: null };
    } catch (error) {
      return {
        proposals: [],
        error: new PersistenceError(
          'Failed to list proposals by id',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async updateProposalStatus(
    proposalId: string,
    proposalVersion: number,
    status: ProposalStatus
  ): Promise<ProposalResult> {
    await Promise.resolve();
    try {
      const existing = await this.getProposal(proposalId, proposalVersion);
      if (existing.error !== null) {
        return { proposal: null, error: existing.error };
      }
      if (existing.proposal === null) {
        return { proposal: null, error: new PersistenceError('Proposal not found') };
      }

      this.db.exec(
        `UPDATE proposal_versions SET status = ? WHERE id = ? AND proposal_version = ?`,
        [status, proposalId, proposalVersion] as SqlValue[]
      );

      return this.getProposal(proposalId, proposalVersion);
    } catch (error) {
      return {
        proposal: null,
        error: new PersistenceError(
          'Failed to update proposal status',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }

  async listProposals(
    filter?: ProposalListFilter,
    limit: number = DEFAULT_LIST_LIMIT,
    offset: number = 0
  ): Promise<ProposalListResult> {
    await Promise.resolve();
    try {
      const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
      const safeOffset = Math.max(offset, 0);

      let sql = `SELECT ${PROPOSAL_COLUMNS} FROM proposal_versions`;
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (filter?.proposalId) {
        conditions.push('id = ?');
        params.push(filter.proposalId);
      }
      if (filter?.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      if (filter?.workspaceId) {
        conditions.push('workspace_id = ?');
        params.push(filter.workspaceId);
      }
      if (filter?.fileUri) {
        conditions.push('file_uri = ?');
        params.push(filter.fileUri);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY id ASC, proposal_version ASC';
      sql += ' LIMIT ? OFFSET ?';
      params.push(safeLimit, safeOffset);

      const result = this.db.exec(sql, params as SqlValue[]);
      const proposals =
        result.length > 0 ? result[0].values.map(mapProposalRow) : [];
      return { proposals, error: null };
    } catch (error) {
      return {
        proposals: [],
        error: new PersistenceError(
          'Failed to list proposals',
          error instanceof Error ? error : undefined
        ),
      };
    }
  }
}

/**
 * Executes a unit of work inside a sql.js transaction. All statements run
 * inside `BEGIN`/`COMMIT`; on any error the transaction is rolled back and the
 * original error is re-thrown so callers can observe the failure without
 * leaving partial data behind.
 */
export async function executeInTransaction<T>(
  db: SQLDatabase,
  work: (db: SQLDatabase) => Promise<T>
): Promise<T> {
  db.exec('BEGIN');
  try {
    const result = await work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failure masks nothing useful; the original error wins.
    }
    throw error;
  }
}
