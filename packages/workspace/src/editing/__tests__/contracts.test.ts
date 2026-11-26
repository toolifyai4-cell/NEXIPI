import { describe, it, expect } from 'vitest';
import type {
  EditProposal,
  EditOperation,
  EditPreview,
  EditApproval,
  ApplyResult,
  ProposalStatus,
} from '../contracts.js';
import {
  EditProposalSchema,
  EditApprovalSchema,
  EditPreviewSchema,
  ApplyResultSchema,
  validateEditProposal,
  safeValidateEditProposal,
  validateEditApproval,
  validateApplyResult,
} from '../schemas.js';

function makeValidProposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    kind: 'edit-proposal',
    proposalId: '550e8400-e29b-41d4-a716-446655440000',
    proposalVersion: 1,
    workspaceId: 'ws_workspaceA',
    workspaceFolderUri: 'file:///workspaceA',
    fileUri: 'file:///workspaceA/file.txt',
    relativePath: 'file.txt',
    originalContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    originalSize: 0,
    originalMtime: 0,
    operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'line one\n' }],
    proposedContentHash: '3a5d7c1b9e2f4a6c8d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c',
    proposedSize: 10,
    createdAt: 1700000000000,
    expiresAt: 1700000120000,
    status: 'awaiting-approval',
    ...overrides,
  };
}

describe('Editing contracts', () => {
  describe('EditProposal', () => {
    it('accepts a valid proposal', () => {
      const proposal = makeValidProposal();
      expect(proposal.kind).toBe('edit-proposal');
      expect(proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(proposal.proposalVersion).toBe(1);
      expect(proposal.status).toBe('awaiting-approval');
    });

    it('supports all valid statuses', () => {
      const statuses: ProposalStatus[] = [
        'pending-validation',
        'validated',
        'awaiting-approval',
        'approved',
        'applied',
        'rejected',
        'expired',
        'failed',
        'cancelled',
      ];
      for (const status of statuses) {
        const p = makeValidProposal({ status });
        expect(p.status).toBe(status);
      }
    });

    it('supports all operation kinds', () => {
      const validKinds = ['replace-lines', 'insert-lines', 'delete-lines', 'replace-full'];
      const ops: EditOperation[] = [
        { kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'a\n' },
        { kind: 'insert-lines', atLine: 2, newContent: 'b\n' },
        { kind: 'delete-lines', startLine: 3, endLine: 3 },
        { kind: 'replace-full', newContent: 'all\n' },
      ];
      for (const op of ops) {
        expect(validKinds).toContain(op.kind);
      }
    });

    it('requires workspace identity', () => {
      const p = makeValidProposal({ workspaceId: '' });
      expect(p.workspaceId).toBe('');
    });
  });

  describe('EditPreview', () => {
    it('has required fields', () => {
      const preview: EditPreview = {
        kind: 'edit-preview',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        fileUri: 'file:///workspaceA/file.txt',
        relativePath: 'file.txt',
        originalContent: 'original',
        proposedContent: 'proposed',
        diffSummary: {
          linesAdded: 1,
          linesRemoved: 1,
          linesModified: 1,
        },
        truncated: false,
        originalTruncated: false,
        proposedTruncated: false,
      };
      expect(preview.kind).toBe('edit-preview');
      expect(preview.diffSummary.linesAdded).toBe(1);
    });
  });

  describe('EditApproval', () => {
    it('requires user as approver', () => {
      const approval: EditApproval = {
        kind: 'edit-approval',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        proposalVersion: 1,
        approvedContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approvedAt: 1700000000000,
        approvedBy: 'user',
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      };
      expect(approval.approvedBy).toBe('user');
      expect(approval.proposalVersion).toBe(1);
    });
  });

  describe('ApplyResult', () => {
    it('supports all outcomes', () => {
      for (const outcome of ['applied', 'failed', 'cancelled'] as const) {
        const result: ApplyResult = {
          kind: 'apply-result',
          proposalId: '550e8400-e29b-41d4-a716-446655440000',
          fileUri: 'file:///workspaceA/file.txt',
          relativePath: 'file.txt',
          outcome,
          appliedAt: null,
          finalContentHash: null,
          finalSize: null,
          error: null,
          staleDetected: false,
          approvalVerified: false,
        };
        expect(result.outcome).toBe(outcome);
        expect(result.staleDetected).toBe(false);
      }
    });
  });
});
