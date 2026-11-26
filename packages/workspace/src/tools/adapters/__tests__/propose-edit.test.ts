import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import {
  createProposeEditToolDefinition,
  type ProposeEditAdapterDependencies,
} from '../propose-edit.js';
import {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolErrorCode,
} from '@nexipi/models/tools';
import type {
  FileSystemProvider,
  DirectoryEntry,
  FileStat,
} from '../../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../../types.js';
import { normalizePath } from '../../classification.js';
import { sha256 } from '../../../editing/hash.js';
import { applyOperations } from '../../../editing/operations.js';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return {
    id: `ws_${name}` as unknown as WorkspaceFolderId,
    uri,
    name,
    index: 0,
  };
}

type WorkspaceFolderId = string & { readonly __brand: unique symbol };

function makeUri(path: string): string {
  return `file://${path}`;
}

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

class TrackingFileSystem implements FileSystemProvider {
  private files = new Map<string, string>();
  private stats = new Map<string, FileStat & { ctime: number }>();
  writeCalls: string[] = [];
  readCalls: string[] = [];

  private key(p: string): string {
    return normalizePath(p);
  }

  private ensureDir(filePath: string): void {
    const parts = filePath.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/';
      if (!this.stats.has(dir)) {
        this.stats.set(dir, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
      }
    }
  }

  addFile(p: string, content: string, mtime?: number): void {
    const k = this.key(p);
    this.files.set(k, content);
    this.stats.set(k, {
      type: 'file',
      size: Buffer.byteLength(content, 'utf8'),
      mtime: mtime ?? Date.now(),
      ctime: Date.now(),
    });
    this.ensureDir(k);
  }

  addDir(p: string): void {
    const k = this.key(p);
    this.stats.set(k, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
    this.ensureDir(k);
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    return [];
  }

  async stat(uri: string): Promise<FileStat> {
    const k = this.key(uri);
    const s = this.stats.get(k);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory, stat '${uri}'`);
    }
    return { ...s };
  }

  async lstat(uri: string): Promise<FileStat> {
    return this.stat(uri);
  }

  async readFile(uri: string): Promise<string> {
    this.readCalls.push(uri);
    const k = this.key(uri);
    const content = this.files.get(k);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, read '${uri}'`);
    }
    return content;
  }

  async exists(uri: string): Promise<boolean> {
    return this.files.has(this.key(uri)) || this.stats.has(this.key(uri));
  }

  // Write-path methods are intentionally present to assert they are never
  // invoked by propose_edit, which only receives a read-only provider.
  writeFile(uri: string, _content: Uint8Array): Promise<void> {
    this.writeCalls.push(uri);
    return Promise.resolve();
  }
  rename(_oldUri: string, _newUri: string): Promise<void> {
    this.writeCalls.push('rename');
    return Promise.resolve();
  }
  deleteFile(_uri: string): Promise<void> {
    this.writeCalls.push('delete');
    return Promise.resolve();
  }
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

function makeProposalBoundary(overrides: {
  result?: { proposalId: string; proposalVersion: number; status: 'awaiting-approval' };
  fail?: boolean;
}): ProposalCreationBoundary {
  return {
    createProposal: async () => {
      if (overrides.fail) {
        throw new Error('Proposal store unavailable');
      }
      return {
        proposalId: overrides.result?.proposalId ?? '550e8400-e29b-41d4-a716-446655440000',
        proposalVersion: overrides.result?.proposalVersion ?? 1,
        status: overrides.result?.status ?? 'awaiting-approval',
        createdAt: 1700000000000,
        expiresAt: 1700000120000,
      };
    },
  };
}

interface ProposalCreationBoundary {
  createProposal(request: {
    workspaceId: string;
    workspaceFolderUri: string;
    fileUri: string;
    relativePath: string;
    originalContentHash: string;
    originalSize: number;
    originalMtime: number;
    operations: unknown[];
    proposedContentHash: string;
    proposedSize: number;
  }): Promise<{
    proposalId: string;
    proposalVersion: number;
    status: string;
    createdAt: number;
    expiresAt: number;
  }>;
}

function buildDeps(
  vfs: TrackingFileSystem,
  workspaceFolder: WorkspaceFolder,
  boundary?: ProposalCreationBoundary
): ProposeEditAdapterDependencies {
  return {
    fileSystem: vfs,
    workspaceFolder,
    proposalCreation: boundary ?? makeProposalBoundary({}),
  };
}

describe('propose_edit tool definition', () => {
  let vfs: TrackingFileSystem;
  const workspaceFolder = makeWorkspaceFolder(ROOT_URI, 'root');

  beforeEach(() => {
    vfs = new TrackingFileSystem();
  });

  describe('metadata', () => {
    it('has the proposed_edit name and read-only metadata', () => {
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
      expect(tool.name).toBe('propose_edit');
      expect(tool.metadata.capabilities).toEqual(['read']);
      expect(tool.metadata.readOnly).toBe(true);
      expect(tool.metadata.destructive).toBe(false);
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
      tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
    });

    it('accepts valid propose_edit input', () => {
      const parsed = tool.inputSchema.safeParse({
        uri: makeUri('/root/test.ts'),
        operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'edited\n' }],
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects missing uri', () => {
      const parsed = tool.inputSchema.safeParse({
        operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'x\n' }],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects empty operations array', () => {
      const parsed = tool.inputSchema.safeParse({
        uri: makeUri('/root/test.ts'),
        operations: [],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects invalid operation kind', () => {
      const parsed = tool.inputSchema.safeParse({
        uri: makeUri('/root/test.ts'),
        operations: [{ kind: 'bad-kind' as never }],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects too many operations', () => {
      const ops = Array.from({ length: 51 }, (_, i) => ({
        kind: 'insert-lines',
        atLine: i + 1,
        newContent: 'x\n',
      }));
      const parsed = tool.inputSchema.safeParse({ uri: makeUri('/root/test.ts'), operations: ops });
      expect(parsed.success).toBe(false);
    });

    it('rejects model-supplied trusted metadata (strict schema)', () => {
      const parsed = tool.inputSchema.safeParse({
        uri: makeUri('/root/test.ts'),
        operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
        workspaceId: 'ws_forged',
        originalContentHash: '0'.repeat(64),
        originalSize: 999,
        approvalStatus: 'approved' as never,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects model-supplied replacement content outside operations', () => {
      const parsed = tool.inputSchema.safeParse({
        uri: makeUri('/root/test.ts'),
        operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
        replacementContent: 'forged' as never,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('execution success', () => {
    it('creates a proposal for valid arguments and returns hashes and preview', async () => {
      vfs.addFile('/root/test.ts', 'line one\nline two\nline three\n');
      const boundary = makeProposalBoundary({});
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));
      const context = createContext();

      const result = await tool.execute(
        {
          uri: makeUri('/root/test.ts'),
          operations: [
            { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
          ],
        },
        context
      );

      expect(result.kind).toBe('propose-edit-result');
      expect(result.proposalId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.proposalVersion).toBe(1);
      expect(result.status).toBe('awaiting-approval');
      expect(result.relativePath).toBe('test.ts');
      expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(result.approvalRequired).toBe(true);
      expect(result.preview.kind).toBe('edit-preview');
      expect(result.preview.proposalId).toBe(result.proposalId);
      expect(result.preview.diffSummary.linesRemoved).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesAdded).toBeGreaterThanOrEqual(0);

      // Original hash correctness
      const originalContent = 'line one\nline two\nline three\n';
      expect(result.originalContentHash).toBe(sha256(originalContent));
      expect(result.originalSize).toBe(Buffer.byteLength(originalContent, 'utf8'));

      // Proposed hash correctness via Stage B pure function
      const proposed = applyOperations(originalContent, [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
      ]);
      expect(result.proposedContentHash).toBe(proposed.contentHash);
      expect(result.proposedSize).toBe(proposed.size);
    });

    it('uses the trusted boundary for proposal identity and version', async () => {
      vfs.addFile('/root/test.ts', 'content\n');
      const boundary = makeProposalBoundary({
        result: {
          proposalId: '11111111-1111-1111-1111-111111111111',
          proposalVersion: 3,
          status: 'validated',
        },
      });
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));

      const result = await tool.execute(
        {
          uri: makeUri('/root/test.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'top\n' }],
        },
        createContext()
      );

      expect(result.proposalId).toBe('11111111-1111-1111-1111-111111111111');
      expect(result.proposalVersion).toBe(3);
      expect(result.status).toBe('validated');
      expect(result.approvalRequired).toBe(true);
    });

    it('reports approval not required when boundary returns approved', async () => {
      vfs.addFile('/root/test.ts', 'content\n');
      const boundary = makeProposalBoundary({
        result: {
          proposalId: '11111111-1111-1111-1111-111111111111',
          proposalVersion: 1,
          status: 'approved',
        },
      });
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));

      const result = await tool.execute(
        {
          uri: makeUri('/root/test.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
        },
        createContext()
      );

      expect(result.status).toBe('approved');
      expect(result.approvalRequired).toBe(false);
    });

    it('generates a correct diff summary and preview', async () => {
      vfs.addFile('/root/diff.ts', 'a\nb\nc\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/diff.ts'),
          operations: [{ kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'B\n' }],
        },
        createContext()
      );

      expect(result.preview.originalContent).toBe('a\nb\nc\n');
      expect(result.preview.proposedContent).toBe('a\nB\nc\n');
      expect(result.preview.diffSummary.linesRemoved).toBe(1);
      expect(result.preview.diffSummary.linesAdded).toBe(1);
      expect(result.preview.relativePath).toBe('diff.ts');
      expect(result.preview.fileUri).toBe(makeUri('/root/diff.ts'));
    });

    it('does not perform any filesystem write during proposal creation', async () => {
      vfs.addFile('/root/readonly.ts', 'data\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );

      await tool.execute(
        {
          uri: makeUri('/root/readonly.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
        },
        createContext()
      );

      expect(vfs.writeCalls).toEqual([]);
      // Only read operations should have happened.
      expect(vfs.readCalls.length).toBeGreaterThan(0);
    });
  });

  describe('execution rejection', () => {
    it('rejects path traversal outside the workspace', async () => {
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/../outside.ts'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_ARGUMENTS });
    });

    it('rejects missing file', async () => {
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/missing.ts'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_EXECUTION_FAILED });
    });

    it('rejects invalid line ranges (startLine > endLine)', async () => {
      vfs.addFile('/root/range.ts', 'a\nb\nc\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/range.ts'),
            operations: [{ kind: 'replace-lines', startLine: 3, endLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_ARGUMENTS });
    });

    it('rejects line range beyond file length', async () => {
      vfs.addFile('/root/short.ts', 'a\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/short.ts'),
            operations: [{ kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_ARGUMENTS });
    });

    it('rejects excessive content size (replace-full over limit)', async () => {
      vfs.addFile('/root/big.ts', 'x\n');
      const bigContent = 'y'.repeat(10 * 1024 * 1024 + 1);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/big.ts'),
            operations: [{ kind: 'replace-full', newContent: bigContent }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_ARGUMENTS });
    });

    it('rejects sensitive file type', async () => {
      vfs.addFile('/root/.env', 'SECRET=1');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/.env'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_EXECUTION_FAILED });
    });

    it('rejects binary file content', async () => {
      vfs.addFile('/root/bin.dat', 'text\x00more');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/bin.dat'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_EXECUTION_FAILED });
    });

    it('rejects directory path (not a file)', async () => {
      vfs.addDir('/root/subdir');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/subdir'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_ARGUMENTS });
    });

    it('fails closed when the proposal-creation boundary fails', async () => {
      vfs.addFile('/root/fail.ts', 'content\n');
      const boundary = makeProposalBoundary({ fail: true });
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/fail.ts'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_EXECUTION_FAILED });
    });

    it('rejects workspace identity mismatch', async () => {
      vfs.addFile('/root/mismatch.ts', 'content\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      await expect(
        tool.execute(
          {
            uri: makeUri('/root/mismatch.ts'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext('ws_other')
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_RESOURCE_LIMIT });
    });

    it('output validates against the output schema', async () => {
      vfs.addFile('/root/schema.ts', 'one\ntwo\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );
      const result = await tool.execute(
        {
          uri: makeUri('/root/schema.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'zero\n' }],
        },
        createContext()
      );
      const parsed = tool.outputSchema!.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });
});
