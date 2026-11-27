import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  createApplyEditToolDefinition,
  type ApplyEditAdapterDependencies,
  type ApplyEditOutput,
} from '../apply-edit.js';
import { ToolDefinition, ToolExecutionContext, ToolErrorCode } from '@nexipi/models/tools';
import type { WorkspaceFolder } from '../../../types.js';
import type { Approval, WritableFileSystemProvider } from '../../../editing/index.js';
import type { FileSystemProvider } from '../../../discovery/workspace-provider.js';

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
    approval?: Approval;
    authorizationToApply?: unknown;
    apply?: {
      fileUri: string;
      relativePath: string;
      proposedContent: string;
      proposedContentHash: string;
    };
    reason?: string;
    staleDetected?: boolean;
  }>;
}

function makeAuthorizationBoundary(overrides: {
  authorized?: boolean;
  approval?: Approval;
  apply?: EditAuthorizationBoundary['apply'];
  reason?: string;
  fail?: boolean;
  staleDetected?: boolean;
}): EditAuthorizationBoundary {
  return {
    verifyAndAuthorizeApplication: async () => {
      if (overrides.fail) {
        throw new Error('Authorization service unavailable');
      }
      return {
        authorized: overrides.authorized ?? false,
        approval: overrides.approval,
        apply: overrides.apply,
        reason: overrides.reason,
        staleDetected: overrides.staleDetected,
      };
    },
  };
}

function makeWritableFileSystem(overrides: {
  writeFile?: (uri: string, content: Uint8Array, signal?: AbortSignal) => Promise<void>;
}): WritableFileSystemProvider {
  return {
    writeFile: overrides.writeFile ?? (async () => undefined),
    readFile: async () => '',
    readDirectory: async () => [],
    stat: async () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }),
    lstat: async () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }),
    exists: async () => true,
  };
}

function makeFileSystem(
  overrides: {
    readFile?: (uri: string) => Promise<string>;
  } = {}
): FileSystemProvider {
  return {
    readFile: overrides.readFile ?? (async () => ''),
  };
}

function buildDeps(
  boundary?: EditAuthorizationBoundary,
  writableFileSystem?: WritableFileSystemProvider,
  fileSystem?: FileSystemProvider
): ApplyEditAdapterDependencies {
  return {
    authorization:
      boundary ??
      makeAuthorizationBoundary({ authorized: false, reason: 'no authorization service' }),
    writableFileSystem: writableFileSystem ?? makeWritableFileSystem({}),
    fileSystem: fileSystem ?? makeFileSystem(),
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
const APPROVED_CONTENT = 'const x = 1;';
const APPROVED_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const APPROVAL: Approval = {
  kind: 'edit-approval',
  approvalId: 'a1' as never,
  proposalId: VALID_PROPOSAL_ID,
  proposalVersion: 1 as never,
  decision: 'approved' as never,
  approvedContentHash: APPROVED_CONTENT_HASH,
  decidedAt: 1700000000000,
  provenance: { kind: 'user', actorId: 'user', timestamp: 1700000000000 } as never,
  lifecycleState: 'approved' as never,
  expiresAt: null,
  workspaceId: TEST_WORKSPACE_ID,
  fileUri: 'file:///root/file.ts',
  createdAt: 1700000000000,
};

const APPLY_PAYLOAD = {
  fileUri: 'file:///root/file.ts',
  relativePath: 'file.ts',
  proposedContent: APPROVED_CONTENT,
  proposedContentHash: APPROVED_CONTENT_HASH,
};

describe('apply_edit tool definition', () => {
  const workspaceFolder = makeWorkspaceFolder(ROOT_URI, 'root');

  describe('metadata', () => {
    it('has the apply_edit name and write/destructive metadata', () => {
      const tool = createApplyEditToolDefinition(buildDeps());
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
      tool = createApplyEditToolDefinition(buildDeps());
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
      const writeFile = vi.fn();
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.kind).toBe('apply-edit-result');
      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(result.authorized).toBe(false);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.finalSize).toBeNull();
      expect(result.error).not.toBeNull();
      expect(result.staleDetected).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('fails closed when the authorization boundary is unavailable', async () => {
      const boundary = makeAuthorizationBoundary({ fail: true });
      const tool = createApplyEditToolDefinition(buildDeps(boundary));
      const fs = makeWritableFileSystem({ writeFile: vi.fn() });

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(result.authorized).toBe(false);
      expect(result.error).not.toBeNull();
    });

    it('applies the verified content when authorized and the write succeeds', async () => {
      const writeFile = vi.fn(async () => undefined);
      const boundary = makeAuthorizationBoundary({
        authorized: true,
        approval: APPROVAL,
        apply: APPLY_PAYLOAD,
      });
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('applied');
      expect(result.approvalVerified).toBe(true);
      expect(result.authorized).toBe(true);
      expect(result.appliedAt).not.toBeNull();
      expect(result.finalContentHash).toBe(APPROVED_CONTENT_HASH);
      expect(result.finalSize).toBe(new TextEncoder().encode(APPROVED_CONTENT).byteLength);
      expect(result.error).toBeNull();
      expect(result.staleDetected).toBe(false);
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [uri, content, signal] = writeFile.mock.calls[0];
      expect(uri).toBe(APPLY_PAYLOAD.fileUri);
      expect(new TextDecoder().decode(content as Uint8Array)).toBe(APPLY_PAYLOAD.proposedContent);
      expect(signal).toBeDefined();
    });

    it('reports failure when the write fails after authorization', async () => {
      const writeFile = vi.fn(async () => {
        throw new Error('ENOSPC');
      });
      const boundary = makeAuthorizationBoundary({
        authorized: true,
        approval: APPROVAL,
        apply: APPLY_PAYLOAD,
      });
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(true);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.error).not.toBeNull();
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it('performs no filesystem write without trusted authorization', async () => {
      const writeFile = vi.fn();
      const boundary: EditAuthorizationBoundary = {
        verifyAndAuthorizeApplication: async request => {
          return { authorized: false, reason: 'denied' };
        },
      };
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.approvalVerified).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('rejects workspace identity mismatch at the boundary', async () => {
      // The boundary is bound to a workspace; a proposal belonging to a
      // different workspace is denied by the boundary itself, so the adapter
      // fails closed and performs no write.
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'Workspace identity mismatch: proposal does not belong to this workspace',
      });
      const writeFile = vi.fn();
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.error?.message).toContain('Workspace identity mismatch');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('propagates a stale-file denial from the boundary without writing', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        staleDetected: true,
        reason: 'Target file has changed since the proposal was created',
      });
      const writeFile = vi.fn();
      const fs = makeWritableFileSystem({ writeFile });
      const tool = createApplyEditToolDefinition(buildDeps(boundary, fs));

      const result = (await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.approvalVerified).toBe(false);
      expect(result.staleDetected).toBe(true);
      expect(result.error?.message).toContain('changed since the proposal was created');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('output validates against the output schema', async () => {
      const boundary = makeAuthorizationBoundary({
        authorized: false,
        reason: 'not approved',
      });
      const tool = createApplyEditToolDefinition(buildDeps(boundary));
      const result = await tool.execute(
        { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1 },
        createContext()
      );
      const parsed = tool.outputSchema!.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });
});
