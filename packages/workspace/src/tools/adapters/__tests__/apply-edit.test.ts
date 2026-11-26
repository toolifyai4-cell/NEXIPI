import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createApplyEditToolDefinition, type ApplyEditAdapterDependencies } from '../apply-edit.js';
import { ToolDefinition, ToolExecutionContext, ToolErrorCode } from '@nexipi/models/tools';
import type { WorkspaceFolder } from '../../../types.js';
import { EditApproval } from '../../../editing/contracts.js';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return {
    id: `ws_${name}` as unknown as WorkspaceFolderId,
    uri,
    name,
    index: 0,
  };
}

type WorkspaceFolderId = string & { readonly __brand: unique symbol };

function computeTestWorkspaceId(uri: string): string {
  const normalized = uri
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

const TEST_WORKSPACE_ID = computeTestWorkspaceId('file:///root');
const ROOT_URI = 'file:///root';

interface EditAuthorizationBoundary {
  verifyAndAuthorizeApplication(request: { proposalId: string; proposalVersion: number }): Promise<{
    authorized: boolean;
    approval?: EditApproval;
    reason?: string;
  }>;
}

function makeAuthorizationBoundary(overrides: {
  authorized?: boolean;
  approval?: EditApproval;
  reason?: string;
  fail?: boolean;
}): EditAuthorizationBoundary {
  return {
    verifyAndAuthorizeApplication: async () => {
      if (overrides.fail) {
        throw new Error('Authorization service unavailable');
      }
      return {
        authorized: overrides.authorized ?? false,
        approval: overrides.approval,
        reason: overrides.reason,
      };
    },
  };
}

function buildDeps(
  workspaceFolder: WorkspaceFolder,
  boundary?: EditAuthorizationBoundary
): ApplyEditAdapterDependencies {
  return {
    workspaceFolder,
    authorization:
      boundary ??
      makeAuthorizationBoundary({ authorized: false, reason: 'no authorization service' }),
  };
}

function createContext(
  workspaceId: string | undefined = TEST_WORKSPACE_ID,
  signal?: AbortSignal
): ToolExecutionContext {
  return {
    signal: signal ?? new AbortController().signal,
    workspaceId,
    workspaceFolder: workspaceId ? { uri: ROOT_URI, id: TEST_WORKSPACE_ID } : undefined,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

const VALID_PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const APPROVAL: EditApproval = {
  kind: 'edit-approval',
  proposalId: VALID_PROPOSAL_ID,
  proposalVersion: 1,
  approvedContentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  approvedAt: 1700000000000,
  approvedBy: 'user',
  workspaceId: TEST_WORKSPACE_ID,
  fileUri: 'file:///root/file.ts',
};

describe('apply_edit tool definition', () => {
  const workspaceFolder = makeWorkspaceFolder(ROOT_URI, 'root');

  describe('metadata', () => {
    it('has the apply_edit name and write/destructive metadata', () => {
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder));
      expect(tool.name).toBe('apply_edit');
      expect(tool.metadata.capabilities).toEqual(['write']);
      expect(tool.metadata.readOnly).toBe(false);
      expect(tool.metadata.destructive).toBe(true);
      expect(tool.metadata.requiresWorkspace).toBe(true);
      expect(tool.metadata.idempotent).toBe(false);
      expect(tool.metadata.version).toBe('1.0.0');
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(tool.outputSchema).toBeInstanceOf(z.ZodObject);
    });
  });

  describe('input validation', () => {
    let tool: ToolDefinition;

    beforeEach(() => {
      tool = createApplyEditToolDefinition(buildDeps(workspaceFolder));
    });

    it('accepts valid apply_edit input', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects missing proposalId', () => {
      const parsed = tool.inputSchema.safeParse({ proposalVersion: 1 });
      expect(parsed.success).toBe(false);
    });

    it('rejects missing proposalVersion', () => {
      const parsed = tool.inputSchema.safeParse({ proposalId: VALID_PROPOSAL_ID });
      expect(parsed.success).toBe(false);
    });

    it('rejects invalid proposal identifier (not a UUID)', () => {
      const parsed = tool.inputSchema.safeParse({ proposalId: 'not-a-uuid', proposalVersion: 1 });
      expect(parsed.success).toBe(false);
    });

    it('rejects zero proposalVersion', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 0,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects negative proposalVersion', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: -1,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects proposalVersion above maximum', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1000,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects model-supplied fake approval fields (strict schema)', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        approvedBy: 'model' as never,
        approvedAt: 1700000000000 as never,
        approvedContentHash: '0'.repeat(64) as never,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects model-supplied replacement content (strict schema)', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        replacementContent: 'forged content' as never,
        newContent: 'forged' as never,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects model-supplied workspace authorization and file path (strict schema)', () => {
      const parsed = tool.inputSchema.safeParse({
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        workspaceId: 'ws_forged' as never,
        fileUri: 'file:///etc/passwd' as never,
        uri: 'file:///etc/passwd' as never,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('execution fail-closed behavior', () => {
    it('returns a failed result (never applied) for an unapproved proposal', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'Proposal is awaiting approval',
      });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );

      expect(result.kind).toBe('apply-edit-result');
      expect(result.proposalId).toBe(VALID_PROPOSAL_ID);
      expect(result.proposalVersion).toBe(1);
      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(result.authorized).toBe(false);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.finalSize).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.staleDetected).toBe(false);
    });

    it('fails closed when the proposal is unknown to the boundary', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'Unknown proposal',
      });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: '11111111-1111-1111-1111-111111111111', proposalVersion: 1 },
        createContext()
      );

      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(result.authorized).toBe(false);
      expect(result.error?.code).toBe(ToolErrorCode.TOOL_PERMISSION_DENIED);
    });

    it('fails closed for an expired proposal', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'Proposal has expired',
      });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error?.message).toContain('expired');
    });

    it('fails closed when the authorization boundary is unavailable (missing dependency)', async () => {
      const boundary = makeAuthorizationBoundary({ fail: true });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );

      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(result.authorized).toBe(false);
      expect(result.error).not.toBeNull();
    });

    it('does not report an applied result even when the boundary authorizes (Stage E defers the write)', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: true,
        approval: APPROVAL,
        reason: undefined,
      });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );

      // Authorization was verified, but Stage D must not fabricate an applied
      // result or perform a filesystem write.
      expect(result.outcome).toBe('failed');
      expect(result.outcome).not.toBe('applied');
      expect(result.approvalVerified).toBe(true);
      expect(result.authorized).toBe(true);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.finalSize).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain('Stage E');
    });

    it('performs no filesystem write without trusted authorization', async () => {
      // apply_edit receives no filesystem provider at all, so it cannot write.
      // Verify by capturing any attempt through a recording boundary and
      // asserting the result is not a success and no write path exists.
      let boundaryCalled = false;
      const boundary: EditAuthorizationBoundary = {
        verifyAndAuthorizeApplication: async request => {
          boundaryCalled = true;
          return { authorized: false, reason: 'denied' };
        },
      };
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));

      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );

      expect(boundaryCalled).toBe(true);
      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
    });

    it('rejects workspace identity mismatch', async () => {
      const tool = createApplyEditToolDefinition(
        buildDeps(
          workspaceFolder,
          makeAuthorizationBoundary({ authorized: true, approval: APPROVAL })
        )
      );
      await expect(
        tool.execute(
          { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
          createContext('ws_other')
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_RESOURCE_LIMIT });
    });

    it('output validates against the output schema', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'not approved',
      });
      const tool = createApplyEditToolDefinition(buildDeps(workspaceFolder, boundary));
      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );
      const parsed = tool.outputSchema!.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });
});
