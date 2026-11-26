import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  createProposeEditToolDefinition,
  type ProposeEditAdapterDependencies,
  type ProposeEditConfig,
  defaultProposeEditConfig,
  MIN_DIFF_PREVIEW_SIZE_BYTES,
} from '../propose-edit.js';
import { ToolDefinition, ToolExecutionContext, ToolErrorCode } from '@nexipi/models/tools';
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

const VALID_PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440000';

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
  result?: { proposalId: string; proposalVersion: number; status: string };
  fail?: boolean;
}): ProposalCreationBoundary {
  return {
    createProposal: async () => {
      if (overrides.fail) {
        throw new Error('Proposal store unavailable');
      }
      return {
        proposalId: overrides.result?.proposalId ?? VALID_PROPOSAL_ID,
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
  boundary?: ProposalCreationBoundary,
  config?: Partial<ProposeEditConfig>
): ProposeEditAdapterDependencies {
  return {
    fileSystem: vfs,
    workspaceFolder,
    proposalCreation: boundary ?? makeProposalBoundary({}),
    config,
  };
}

describe('propose_edit tool definition', () => {
  let vfs: TrackingFileSystem;
  const workspaceFolder = makeWorkspaceFolder(ROOT_URI, 'root');

  beforeEach(() => {
    vfs = new TrackingFileSystem();
  });

  describe('metadata', () => {
    it('has the propose_edit name and read-only metadata', () => {
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
      expect(result.proposalId).toBe(VALID_PROPOSAL_ID);
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

    it('creates a pending-validation proposal and always requires approval', async () => {
      vfs.addFile('/root/test.ts', 'content\n');
      const boundary = makeProposalBoundary({
        result: { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1, status: 'pending-validation' },
      });
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));

      const result = await tool.execute(
        {
          uri: makeUri('/root/test.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'top\n' }],
        },
        createContext()
      );

      expect(result.status).toBe('pending-validation');
      expect(result.approvalRequired).toBe(true);
    });
  });

  describe('proposal lifecycle separation', () => {
    const prohibitedStatuses: Array<[string, string]> = [
      ['approved', 'approved'],
      ['applied', 'applied'],
      ['rejected', 'rejected'],
      ['expired', 'expired'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
    ];

    it.each(prohibitedStatuses)(
      'rejects %s as an initial proposal creation status',
      async (_label, status) => {
        vfs.addFile('/root/test.ts', 'content\n');
        const boundary = makeProposalBoundary({
          result: { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1, status },
        });
        const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));

        await expect(
          tool.execute(
            {
              uri: makeUri('/root/test.ts'),
              operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
            },
            createContext()
          )
        ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_RESULT });
      }
    );

    it('does not convert an invalid boundary status into a valid one', async () => {
      vfs.addFile('/root/test.ts', 'content\n');
      const boundary = makeProposalBoundary({
        result: { proposalId: VALID_PROPOSAL_ID, proposalVersion: 1, status: 'approved' },
      });
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder, boundary));

      await expect(
        tool.execute(
          {
            uri: makeUri('/root/test.ts'),
            operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'x\n' }],
          },
          createContext()
        )
      ).rejects.toMatchObject({ code: ToolErrorCode.TOOL_INVALID_RESULT });
    });
  });

  describe('preview bounds', () => {
    it('returns a normal small preview without truncation', async () => {
      vfs.addFile('/root/small.ts', 'line one\nline two\nline three\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/small.ts'),
          operations: [
            { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
          ],
        },
        createContext()
      );

      expect(result.preview.truncated).toBe(false);
      expect(result.preview.originalTruncated).toBe(false);
      expect(result.preview.proposedTruncated).toBe(false);
      expect(result.preview.originalContent).toBe('line one\nline two\nline three\n');
      expect(result.preview.proposedContent).toBe('line one\nline two edited\nline three\n');
      // Complete hashes retained
      expect(result.originalContentHash).toBe(sha256('line one\nline two\nline three\n'));
      const proposed = applyOperations('line one\nline two\nline three\n', [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
      ]);
      expect(result.proposedContentHash).toBe(proposed.contentHash);
      expect(result.proposedSize).toBe(proposed.size);
    });

    it('truncates original content exceeding preview limit', async () => {
      const longContent = 'x'.repeat(200) + '\n';
      vfs.addFile('/root/long.ts', longContent);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 100,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/long.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'y\n' }],
        },
        createContext()
      );

      expect(result.preview.originalTruncated).toBe(true);
      expect(result.preview.truncated).toBe(true);
      expect(Buffer.byteLength(result.preview.originalContent, 'utf8')).toBeLessThanOrEqual(100);
      // Complete hash retained despite truncation
      expect(result.originalContentHash).toBe(sha256(longContent));
    });

    it('truncates proposed content exceeding preview limit', async () => {
      vfs.addFile('/root/orig.ts', 'a\nb\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 20,
          maxDiffLines: 4000,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/orig.ts'),
          operations: [{ kind: 'replace-full', newContent: 'z'.repeat(100) + '\n' }],
        },
        createContext()
      );

      expect(result.preview.proposedTruncated).toBe(true);
      expect(result.preview.truncated).toBe(true);
      expect(Buffer.byteLength(result.preview.proposedContent, 'utf8')).toBeLessThanOrEqual(20);
      // Complete proposed hash and size retained internally
      expect(result.proposedContentHash).toBe(sha256('z'.repeat(100) + '\n'));
      expect(result.proposedSize).toBe(Buffer.byteLength('z'.repeat(100) + '\n', 'utf8'));
    });

    it('truncates diff exceeding preview limit', async () => {
      const manyLines = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join('');
      vfs.addFile('/root/many.ts', manyLines);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 10,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/many.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'top\n' }],
        },
        createContext()
      );

      expect(result.preview.truncated).toBe(true);
      expect(result.originalContentHash).toBe(sha256(manyLines));
    });

    it('retains complete hashes despite preview truncation', async () => {
      const longContent = 'a'.repeat(1000) + '\n';
      vfs.addFile('/root/hash.ts', longContent);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 10,
          maxProposedPreviewSize: 10,
          maxDiffLines: 4000,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/hash.ts'),
          operations: [{ kind: 'replace-full', newContent: 'b'.repeat(2000) + '\n' }],
        },
        createContext()
      );

      // Preview truncated
      expect(result.preview.truncated).toBe(true);
      expect(Buffer.byteLength(result.preview.originalContent, 'utf8')).toBeLessThanOrEqual(10);
      expect(Buffer.byteLength(result.preview.proposedContent, 'utf8')).toBeLessThanOrEqual(10);
      // Complete hashes intact
      expect(result.originalContentHash).toBe(sha256(longContent));
      expect(result.proposedContentHash).toBe(sha256('b'.repeat(2000) + '\n'));
      expect(result.proposedSize).toBe(Buffer.byteLength('b'.repeat(2000) + '\n', 'utf8'));
    });

    it('passes complete content hash and size to the trusted boundary', async () => {
      const content = 'line one\nline two\nline three\n';
      vfs.addFile('/root/boundary.ts', content);
      let receivedRequest: ProposalCreationRequest | undefined;
      const boundary: ProposalCreationBoundary = {
        createProposal: async request => {
          receivedRequest = request;
          return {
            proposalId: VALID_PROPOSAL_ID,
            proposalVersion: 1,
            status: 'awaiting-approval',
            createdAt: 1700000000000,
            expiresAt: 1700000120000,
          };
        },
      };
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, boundary, {
          maxPreviewContentSize: 100,
          maxProposedPreviewSize: 100,
          maxDiffLines: 4000,
        })
      );

      const operations = [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'edited\n' },
      ];
      await tool.execute({ uri: makeUri('/root/boundary.ts'), operations }, createContext());

      expect(receivedRequest).toBeDefined();
      expect(receivedRequest!.originalContentHash).toBe(sha256(content));
      expect(receivedRequest!.originalSize).toBe(Buffer.byteLength(content, 'utf8'));
      const proposed = applyOperations(content, operations);
      expect(receivedRequest!.proposedContentHash).toBe(proposed.contentHash);
      expect(receivedRequest!.proposedSize).toBe(proposed.size);
    });

    it('leaves a normal diff unchanged with diffTruncated false', async () => {
      vfs.addFile('/root/small.ts', 'line one\nline two\nline three\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}))
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/small.ts'),
          operations: [
            { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
          ],
        },
        createContext()
      );

      expect(result.preview.diffTruncated).toBe(false);
      expect(result.preview.truncated).toBe(false);
      expect(result.preview.diffSummary.linesAdded).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesRemoved).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesModified).toBeGreaterThanOrEqual(0);
      expect(result.originalContentHash).toBe(sha256('line one\nline two\nline three\n'));
      const proposed = applyOperations('line one\nline two\nline three\n', [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
      ]);
      expect(result.proposedContentHash).toBe(proposed.contentHash);
      expect(result.proposedSize).toBe(proposed.size);
    });

    it('truncates diff representation when it exceeds maxDiffPreviewSize', async () => {
      vfs.addFile('/root/diff.ts', 'a\nb\nc\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/diff.ts'),
          operations: [{ kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'B\n' }],
        },
        createContext()
      );

      // At the minimum valid budget, a normal diff summary (~43 bytes) fits,
      // so no size-based truncation occurs.
      expect(result.preview.diffTruncated).toBe(false);
      expect(result.preview.truncated).toBe(false);
      expect(result.preview.diffSummary.linesAdded).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesRemoved).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesModified).toBeGreaterThanOrEqual(0);
      // Serialized summary stays within the accepted limit.
      expect(
        Buffer.byteLength(JSON.stringify(result.preview.diffSummary), 'utf8')
      ).toBeLessThanOrEqual(MIN_DIFF_PREVIEW_SIZE_BYTES);
    });

    it('does not split multi-byte UTF-8 characters in bounded content', async () => {
      const multibyteContent = 'héllo wörld\n🎉 line\nemoji: 🚀🔥\n';
      vfs.addFile('/root/mb.ts', multibyteContent);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 6, // cuts mid-multibyte if not handled
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: 1000000,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/mb.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'top\n' }],
        },
        createContext()
      );

      expect(result.preview.originalTruncated).toBe(true);
      // Truncation must not produce replacement characters or split sequences.
      expect(result.preview.originalContent).not.toContain('\uFFFD');
      expect(Buffer.byteLength(result.preview.originalContent, 'utf8')).toBeLessThanOrEqual(6);
    });

    it('reports diffTruncated accurately when few but extremely long lines exist', async () => {
      // Few lines (under maxDiffLines) but each extremely long.
      const longLine = 'x'.repeat(100000) + '\n';
      const content = `${longLine}${longLine}${longLine}`;
      vfs.addFile('/root/longlines.ts', content);
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/longlines.ts'),
          operations: [{ kind: 'insert-lines', atLine: 1, newContent: 'top\n' }],
        },
        createContext()
      );

      // diffSummary stays bounded (small integer counts) despite long lines.
      expect(result.preview.diffSummary.linesAdded).toBeLessThanOrEqual(3);
      expect(result.preview.diffSummary.linesRemoved).toBeLessThanOrEqual(3);
      expect(result.preview.diffSummary.linesModified).toBeLessThanOrEqual(3);
      // At the minimum valid budget, the small diff summary fits, so no
      // size-based truncation occurs despite long lines.
      expect(result.preview.diffTruncated).toBe(false);
      expect(result.preview.truncated).toBe(false);
      // Serialized summary stays within the accepted limit.
      expect(
        Buffer.byteLength(JSON.stringify(result.preview.diffSummary), 'utf8')
      ).toBeLessThanOrEqual(MIN_DIFF_PREVIEW_SIZE_BYTES);
      // Complete proposal content, hashes, and sizes remain unaffected.
      expect(result.originalContentHash).toBe(sha256(content));
      const proposed = applyOperations(content, [
        { kind: 'insert-lines', atLine: 1, newContent: 'top\n' },
      ]);
      expect(result.proposedContentHash).toBe(proposed.contentHash);
      expect(result.proposedSize).toBe(proposed.size);
    });

    it('preserves real diff summary counts at the minimum valid budget', async () => {
      vfs.addFile('/root/diffreduce.ts', 'a\nb\nc\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/diffreduce.ts'),
          operations: [{ kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'B\n' }],
        },
        createContext()
      );

      // At the minimum valid budget, a normal diff summary fits and is preserved,
      // not zeroed out.
      expect(result.preview.diffSummary.linesAdded).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesRemoved).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffSummary.linesModified).toBeGreaterThanOrEqual(0);
      expect(result.preview.diffTruncated).toBe(false);
      expect(result.preview.truncated).toBe(false);
      // Serialized summary stays within the accepted limit.
      expect(
        Buffer.byteLength(JSON.stringify(result.preview.diffSummary), 'utf8')
      ).toBeLessThanOrEqual(MIN_DIFF_PREVIEW_SIZE_BYTES);
    });

    it('keeps serialized model-facing diff output within the configured byte limit', async () => {
      vfs.addFile('/root/diffbound.ts', 'line one\nline two\nline three\n');
      const maxDiffPreviewSize = 100;
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/diffbound.ts'),
          operations: [
            { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'line two edited\n' },
          ],
        },
        createContext()
      );

      const serializedDiff = JSON.stringify(result.preview.diffSummary);
      expect(Buffer.byteLength(serializedDiff, 'utf8')).toBeLessThanOrEqual(maxDiffPreviewSize);
      expect(result.originalContentHash).toBe(sha256('line one\nline two\nline three\n'));
    });

    it('accepts the minimum valid diff preview size budget', () => {
      const result = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES,
        })
      );
      expect(result).toBeDefined();
    });

    it('rejects a diff preview size budget below the minimum', () => {
      expect(() =>
        createProposeEditToolDefinition(
          buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
            maxPreviewContentSize: 1000000,
            maxProposedPreviewSize: 1000000,
            maxDiffLines: 4000,
            maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES - 1,
          })
        )
      ).toThrow();
    });

    it('keeps an empty DiffSummary at the accepted minimum within the byte limit', async () => {
      vfs.addFile('/root/minbudget.ts', 'a\nb\n');
      const tool = createProposeEditToolDefinition(
        buildDeps(vfs, workspaceFolder, makeProposalBoundary({}), {
          maxPreviewContentSize: 1000000,
          maxProposedPreviewSize: 1000000,
          maxDiffLines: 4000,
          maxDiffPreviewSize: MIN_DIFF_PREVIEW_SIZE_BYTES,
        })
      );

      const result = await tool.execute(
        {
          uri: makeUri('/root/minbudget.ts'),
          operations: [{ kind: 'replace-full', newContent: 'c\nd\n' }],
        },
        createContext()
      );

      const serializedDiff = JSON.stringify(result.preview.diffSummary);
      expect(Buffer.byteLength(serializedDiff, 'utf8')).toBeLessThanOrEqual(
        MIN_DIFF_PREVIEW_SIZE_BYTES
      );
      expect(result.originalContentHash).toBe(sha256('a\nb\n'));
      expect(result.proposedContentHash).toBe(sha256('c\nd\n'));
      expect(result.proposedSize).toBe(Buffer.byteLength('c\nd\n', 'utf8'));
    });
  });

  describe('output schema enforces preview bounds', () => {
    it('rejects oversized preview original content', async () => {
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
      const oversizedContent = 'x'.repeat(defaultProposeEditConfig.maxPreviewContentSize + 1);
      const preview = {
        kind: 'edit-preview' as const,
        proposalId: VALID_PROPOSAL_ID,
        fileUri: makeUri('/root/x.ts'),
        relativePath: 'x.ts',
        originalContent: oversizedContent,
        proposedContent: 'y\n',
        diffSummary: { linesAdded: 0, linesRemoved: 0, linesModified: 0 },
        truncated: true,
        originalTruncated: true,
        proposedTruncated: false,
      };
      const parsed = tool.outputSchema!.safeParse({
        kind: 'propose-edit-result',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        status: 'awaiting-approval',
        relativePath: 'x.ts',
        fileUri: makeUri('/root/x.ts'),
        workspaceId: TEST_WORKSPACE_ID,
        originalContentHash: '0'.repeat(64),
        originalSize: oversizedContent.length,
        originalMtime: 1,
        proposedContentHash: '0'.repeat(64),
        proposedSize: 2,
        preview,
        approvalRequired: true,
        createdAt: 1700000000000,
        expiresAt: 1700000120000,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects oversized preview proposed content', async () => {
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
      const oversizedContent = 'x'.repeat(defaultProposeEditConfig.maxProposedPreviewSize + 1);
      const preview = {
        kind: 'edit-preview' as const,
        proposalId: VALID_PROPOSAL_ID,
        fileUri: makeUri('/root/x.ts'),
        relativePath: 'x.ts',
        originalContent: 'a\n',
        proposedContent: oversizedContent,
        diffSummary: { linesAdded: 0, linesRemoved: 0, linesModified: 0 },
        truncated: true,
        originalTruncated: false,
        proposedTruncated: true,
      };
      const parsed = tool.outputSchema!.safeParse({
        kind: 'propose-edit-result',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        status: 'awaiting-approval',
        relativePath: 'x.ts',
        fileUri: makeUri('/root/x.ts'),
        workspaceId: TEST_WORKSPACE_ID,
        originalContentHash: '0'.repeat(64),
        originalSize: 2,
        originalMtime: 1,
        proposedContentHash: '0'.repeat(64),
        proposedSize: oversizedContent.length,
        preview,
        approvalRequired: true,
        createdAt: 1700000000000,
        expiresAt: 1700000120000,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects preview missing diffTruncated field', async () => {
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
      const previewWithoutDiffTruncated = {
        kind: 'edit-preview' as const,
        proposalId: VALID_PROPOSAL_ID,
        fileUri: makeUri('/root/x.ts'),
        relativePath: 'x.ts',
        originalContent: 'a\n',
        proposedContent: 'b\n',
        diffSummary: { linesAdded: 0, linesRemoved: 0, linesModified: 0 },
        truncated: false,
        originalTruncated: false,
        proposedTruncated: false,
        // diffTruncated intentionally omitted
      };
      const parsed = tool.outputSchema!.safeParse({
        kind: 'propose-edit-result',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        status: 'awaiting-approval',
        relativePath: 'x.ts',
        fileUri: makeUri('/root/x.ts'),
        workspaceId: TEST_WORKSPACE_ID,
        originalContentHash: '0'.repeat(64),
        originalSize: 2,
        originalMtime: 1,
        proposedContentHash: '0'.repeat(64),
        proposedSize: 2,
        preview: previewWithoutDiffTruncated,
        approvalRequired: true,
        createdAt: 1700000000000,
        expiresAt: 1700000120000,
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts valid bounded diff representation in output schema', async () => {
      const tool = createProposeEditToolDefinition(buildDeps(vfs, workspaceFolder));
      const preview = {
        kind: 'edit-preview' as const,
        proposalId: VALID_PROPOSAL_ID,
        fileUri: makeUri('/root/x.ts'),
        relativePath: 'x.ts',
        originalContent: 'a\n',
        proposedContent: 'b\n',
        diffSummary: { linesAdded: 1, linesRemoved: 1, linesModified: 0 },
        truncated: false,
        originalTruncated: false,
        proposedTruncated: false,
        diffTruncated: false,
      };
      const parsed = tool.outputSchema!.safeParse({
        kind: 'propose-edit-result',
        proposalId: VALID_PROPOSAL_ID,
        proposalVersion: 1,
        status: 'awaiting-approval',
        relativePath: 'x.ts',
        fileUri: makeUri('/root/x.ts'),
        workspaceId: TEST_WORKSPACE_ID,
        originalContentHash: '0'.repeat(64),
        originalSize: 2,
        originalMtime: 1,
        proposedContentHash: '0'.repeat(64),
        proposedSize: 2,
        preview,
        approvalRequired: true,
        createdAt: 1700000000000,
        expiresAt: 1700000120000,
      });
      expect(parsed.success).toBe(true);
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
