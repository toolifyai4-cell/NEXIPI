import { describe, it, expect } from 'vitest';
import {
  EditProposalSchema,
  EditApprovalSchema,
  EditPreviewSchema,
  ApplyResultSchema,
  MAX_EDIT_OPERATIONS,
  validateEditProposal,
  safeValidateEditProposal,
  validateEditApproval,
  safeValidateEditApproval,
  validateApplyResult,
  safeValidateApplyResult,
} from '../schemas.js';

function makeValidProposalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    operations: [
      { kind: 'insert-lines', atLine: 1, newContent: 'line one\n' },
    ],
    proposedContentHash: '3a5d7c1b9e2f4a6c8d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c',
    proposedSize: 10,
    createdAt: 1700000000000,
    expiresAt: 1700000120000,
    status: 'awaiting-approval',
    ...overrides,
  };
}

describe('Editing schemas', () => {
  describe('EditProposalSchema', () => {
    it('validates a correct proposal', () => {
      const result = safeValidateEditProposal(makeValidProposalInput());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.proposalId).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(result.data.operations).toHaveLength(1);
        expect(result.data.status).toBe('awaiting-approval');
      }
    });

    it('rejects invalid UUID', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ proposalId: 'not-a-uuid' }));
      expect(result.success).toBe(false);
    });

    it('rejects uppercase hash', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        originalContentHash: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
      }));
      expect(result.success).toBe(false);
    });

    it('rejects short hash', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        originalContentHash: 'e3b0c442',
      }));
      expect(result.success).toBe(false);
    });

    it('rejects non-hex hash', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        originalContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85g',
      }));
      expect(result.success).toBe(false);
    });

    it('rejects zero proposalVersion', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ proposalVersion: 0 }));
      expect(result.success).toBe(false);
    });

    it('rejects negative proposalVersion', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ proposalVersion: -1 }));
      expect(result.success).toBe(false);
    });

    it('rejects empty workspaceId', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ workspaceId: '' }));
      expect(result.success).toBe(false);
    });

    it('rejects empty operations array', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ operations: [] }));
      expect(result.success).toBe(false);
    });

    it('rejects too many operations', () => {
      const ops = Array.from({ length: MAX_EDIT_OPERATIONS + 1 }, (_, i) => ({
        kind: 'insert-lines',
        atLine: i + 1,
        newContent: 'x\n',
      }));
      const result = safeValidateEditProposal(makeValidProposalInput({ operations: ops }));
      expect(result.success).toBe(false);
    });

    it('rejects invalid operation kind', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        operations: [{ kind: 'invalid-kind' as any }],
      }));
      expect(result.success).toBe(false);
    });

    it('rejects missing startLine in replace-lines', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        operations: [{ kind: 'replace-lines', endLine: 1, newContent: 'x\n' }],
      }));
      expect(result.success).toBe(false);
    });

    it('rejects negative startLine in replace-lines', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        operations: [{ kind: 'replace-lines', startLine: -1, endLine: 1, newContent: 'x\n' }],
      }));
      expect(result.success).toBe(false);
    });

    it('rejects replace-full with other operations', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        operations: [
          { kind: 'replace-full', newContent: 'all\n' },
          { kind: 'insert-lines', atLine: 1, newContent: 'extra\n' },
        ],
      }));
      expect(result.success).toBe(false);
    });

    it('rejects expired-before-created', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({
        createdAt: 1700000120000,
        expiresAt: 1700000000000,
      }));
      expect(result.success).toBe(false);
    });

    it('rejects invalid status', () => {
      const result = safeValidateEditProposal(makeValidProposalInput({ status: 'invalid-status' }));
      expect(result.success).toBe(false);
    });

    it('validates via validateEditProposal throwing', () => {
      expect(() => validateEditProposal(makeValidProposalInput())).not.toThrow();
      expect(() => validateEditProposal(makeValidProposalInput({ proposalId: 'bad' }))).toThrow();
    });
  });

  describe('EditApprovalSchema', () => {
    it('validates a correct approval', () => {
      const result = safeValidateEditApproval({
        kind: 'edit-approval',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        proposalVersion: 1,
        approvedContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approvedAt: 1700000000000,
        approvedBy: 'user',
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-user approver', () => {
      const result = safeValidateEditApproval({
        kind: 'edit-approval',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        proposalVersion: 1,
        approvedContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approvedAt: 1700000000000,
        approvedBy: 'model',
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      });
      expect(result.success).toBe(false);
    });

    it('rejects mismatched proposalId', () => {
      const result = safeValidateEditApproval({
        kind: 'edit-approval',
        proposalId: '550e8400-e29b-41d4-a716-446655440001',
        proposalVersion: 1,
        approvedContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approvedAt: 1700000000000,
        approvedBy: 'user',
        workspaceId: 'ws_workspaceA',
        fileUri: 'file:///workspaceA/file.txt',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('ApplyResultSchema', () => {
    it('validates applied outcome', () => {
      const result = safeValidateApplyResult({
        kind: 'apply-result',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        fileUri: 'file:///workspaceA/file.txt',
        relativePath: 'file.txt',
        outcome: 'applied',
        appliedAt: 1700000000000,
        finalContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        finalSize: 10,
        error: null,
        staleDetected: false,
        approvalVerified: true,
      });
      expect(result.success).toBe(true);
    });

    it('validates failed outcome with error', () => {
      const result = safeValidateApplyResult({
        kind: 'apply-result',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        fileUri: 'file:///workspaceA/file.txt',
        relativePath: 'file.txt',
        outcome: 'failed',
        appliedAt: null,
        finalContentHash: null,
        finalSize: null,
        error: { code: 'TOOL_EXECUTION_FAILED', message: 'Write failed' },
        staleDetected: false,
        approvalVerified: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid outcome', () => {
      const result = safeValidateApplyResult({
        kind: 'apply-result',
        proposalId: '550e8400-e29b-41d4-a716-446655440000',
        fileUri: 'file:///workspaceA/file.txt',
        relativePath: 'file.txt',
        outcome: 'unknown',
        appliedAt: null,
        finalContentHash: null,
        finalSize: null,
        error: null,
        staleDetected: false,
        approvalVerified: false,
      });
      expect(result.success).toBe(false);
    });
  });
});