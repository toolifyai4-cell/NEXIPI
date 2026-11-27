/**
 * Phase 10 Stage E4 — apply_edit end-to-end integration tests.
 *
 * Exercises the full path from a model-facing apply_edit invocation through
 * the trusted authorization boundary and the writable filesystem boundary,
 * using real persistence repositories (isolated in-memory sql.js database) and
 * a controlled test double for the trusted decision provider.
 *
 * No approval UI (Stage F) is implemented or exercised here: the trusted
 * decision provider is a test double, and FailingTrustedDecisionProvider is
 * the safe default that fails closed when no real provider is configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  PersistenceFoundation,
  SqlJsProposalRepository,
  SqlJsApprovalRepository,
  type ProposalStatus,
  type SQLDatabase,
} from '@nexipi/persistence';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from '../editing/persistence-repository-adapters.js';
import {
  createTrustedApprovalService,
  TrustedApprovalService,
  FailingTrustedDecisionProvider,
  WritableFileSystemError,
  type TrustedDecisionProvider,
  type TrustedUserDecision,
  type Approval,
} from '@nexipi/workspace';
import { TrustedEditAuthorizationBoundary } from '../editing/edit-authorization-boundary.js';
import { VSCodeWritableFileSystem } from '../../workspace/vscode-writable-file-system.js';
import { createApplyEditToolDefinition } from '@nexipi/workspace/tools';
import type { ApplyEditOutput, WritableFileSystemProvider } from '@nexipi/workspace/tools';
import type { WorkspaceFolder } from '@nexipi/workspace';

// ---------------------------------------------------------------------------
// Shared in-memory VS Code filesystem, shared between the mocked `vscode`
// module and the harness so writes are observable.
// ---------------------------------------------------------------------------

interface InMemoryEntry {
  content: string;
  mtime: number;
}

interface InMemoryStore {
  files: Map<string, InMemoryEntry>;
  directories: Set<string>;
}

const store = vi.hoisted(() => ({ current: null as InMemoryStore | null }));

function makeStore(): InMemoryStore {
  return { files: new Map(), directories: new Set(['/']) };
}

function normalizeFsUri(uri: string | { fsPath: string }): string {
  const p = typeof uri === 'string' ? uri : uri.fsPath;
  return (
    p
      .replace(/^file:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '') || '/'
  );
}

function storeStat(uri: string | { fsPath: string }) {
  const s = store.current;
  if (!s) {
    const error = new Error('store not initialized') as Error & { code?: string };
    error.code = 'ENOENT';
    throw error;
  }
  const file = s.files.get(p(uri));
  if (file) {
    return {
      type: 'file' as const,
      size: new TextEncoder().encode(file.content).length,
      mtime: file.mtime,
      ctime: file.mtime,
    };
  }
  if (s.directories.has(p(uri))) {
    return { type: 'directory' as const, size: 0, mtime: 0, ctime: 0 };
  }
  const error = new Error(`Not found: ${p(uri)}`) as Error & { code?: string };
  error.code = 'ENOENT';
  throw error;
}

function p(uri: string | { fsPath: string }): string {
  return normalizeFsUri(uri);
}

function ensureDir(path: string) {
  const s = store.current;
  if (!s) return;
  const parts = path.split('/').filter(part => part.length > 0);
  let current = '/';
  s.directories.add(current);
  for (const part of parts) {
    current = current === '/' ? `/${part}` : `${current}/${part}`;
    s.directories.add(current);
  }
}

vi.mock('vscode', () => {
  const s = makeStore();
  store.current = s;
  return {
    workspace: {
      fs: {
        stat: vi.fn(storeStat),
        lstat: vi.fn(storeStat),
        readDirectory: vi.fn(() => []),
        readFile: vi.fn(async (uri: string | { fsPath: string }) => {
          const p = normalizeFsUri(uri);
          const file = s.files.get(p);
          if (!file) {
            const error = new Error(`Not found: ${p}`) as Error & { code?: string };
            error.code = 'ENOENT';
            throw error;
          }
          return file.content;
        }),
        writeFile: vi.fn(
          async (_uri: string | { fsPath: string }, content: string | Uint8Array) => {
            const p = normalizeFsUri(_uri);
            ensureDir(p.substring(0, p.lastIndexOf('/')) || '/');
            s.files.set(p, {
              content: typeof content === 'string' ? content : new TextDecoder().decode(content),
              mtime: Date.now(),
            });
          }
        ),
        rename: vi.fn(
          async (oldUri: string | { fsPath: string }, newUri: string | { fsPath: string }) => {
            const oldP = normalizeFsUri(oldUri);
            const newP = normalizeFsUri(newUri);
            const file = s.files.get(oldP);
            if (!file) {
              const error = new Error(`Not found: ${oldP}`) as Error & { code?: string };
              error.code = 'ENOENT';
              throw error;
            }
            s.files.delete(oldP);
            s.files.set(newP, file);
          }
        ),
        delete: vi.fn(async (uri: string | { fsPath: string }) => {
          s.files.delete(normalizeFsUri(uri));
        }),
        createDirectory: vi.fn(async (uri: string | { fsPath: string }) => {
          s.directories.add(normalizeFsUri(uri));
        }),
      },
    },
    Uri: {
      parse: vi.fn((s: string) => ({ fsPath: s.replace(/^file:\/\//i, ''), toString: () => s })),
    },
    window: {
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
      createStatusBarItem: vi.fn(() => ({
        text: '',
        tooltip: '',
        command: '',
        show: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  const s = store.current;
  if (s) {
    s.files.clear();
    s.directories.clear();
    s.directories.add('/');
  }
});

// ---------------------------------------------------------------------------
// Trusted decision provider test double.
// ---------------------------------------------------------------------------

function makeTestProvider(decision: TrustedUserDecision | null): TrustedDecisionProvider {
  return {
    establishUserDecision: vi.fn(async request => {
      if (decision === null) {
        return null;
      }
      return { ...decision, decision: request.decision };
    }),
  };
}

const APPROVED_DECISION: TrustedUserDecision = {
  decision: 'approve',
  boundary: 'test-boundary',
  decidedAt: 1_700_000_000_000,
  expiresAt: null,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const ROOT_A_URI = 'file:///rootA';
const ROOT_B_URI = 'file:///rootB';
const FILE_URI_A = 'file:///rootA/file.ts';
const FILE_URI_B = 'file:///rootB/file.ts';
const PROPOSAL_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROPOSED_CONTENT = 'const x = 1;';
const PROPOSED_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return {
    id: `ws_${name}` as unknown as { readonly __brand: unique symbol },
    uri,
    name,
    index: 0,
  };
}

async function createProposal(
  repo: SqlJsProposalRepository,
  overrides: Partial<{
    id: string;
    proposalVersion: number;
    workspaceId: string;
    fileUri: string;
    relativePath: string;
    proposedContent: string;
    proposedContentHash: string;
    status: ProposalStatus;
    createdAt: number;
    expiresAt: number;
  }> = {}
): Promise<void> {
  const input = {
    id: overrides.id ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? 1,
    workspaceId: overrides.workspaceId ?? 'ws_a',
    workspaceFolderUri: overrides.workspaceId === 'ws_b' ? ROOT_B_URI : ROOT_A_URI,
    fileUri: overrides.fileUri ?? FILE_URI_A,
    relativePath: overrides.relativePath ?? 'file.ts',
    originalContentHash: '0'.repeat(64),
    originalSize: 0,
    originalMtime: 0,
    operations: [{ kind: 'replace' }],
    proposedContent: overrides.proposedContent ?? PROPOSED_CONTENT,
    proposedContentHash: overrides.proposedContentHash ?? PROPOSED_CONTENT_HASH,
    proposedSize: new TextEncoder().encode(PROPOSED_CONTENT).length,
    status: (overrides.status ?? 'validated') as ProposalStatus,
    createdAt: overrides.createdAt ?? NOW,
    expiresAt: overrides.expiresAt ?? NOW + 1_000_000,
  };
  const result = await repo.createProposal(input);
  if (result.error !== null) {
    throw new Error(`createProposal failed: ${result.error.message}`);
  }
}

async function establishApproval(
  service: TrustedApprovalService,
  provider: TrustedDecisionProvider,
  overrides: Partial<{
    proposalId: string;
    proposalVersion: number;
    workspaceId: string;
    fileUri: string;
    decision: 'approve' | 'reject';
    approvedContentHash: string;
    expiresAt: number | null;
  }> = {}
): Promise<string> {
  const created = await service.createApprovalDecision({
    proposalId: overrides.proposalId ?? PROPOSAL_ID,
    proposalVersion: overrides.proposalVersion ?? 1,
    decision: overrides.decision ?? 'approve',
    approvedContentHash: overrides.approvedContentHash ?? PROPOSED_CONTENT_HASH,
    provenance: { kind: 'trusted-boundary', boundary: 'test-boundary' },
    decidedAt: NOW,
    expiresAt: overrides.expiresAt ?? null,
    workspaceId: overrides.workspaceId ?? 'ws_a',
    fileUri: overrides.fileUri ?? FILE_URI_A,
  });
  return created.approvalId;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: SQLDatabase;
  proposalRepo: SqlJsProposalRepository;
  approvalRepo: SqlJsApprovalRepository;
  service: TrustedApprovalService;
  provider: TrustedDecisionProvider;
  boundaryA: TrustedEditAuthorizationBoundary;
  writableFS: VSCodeWritableFileSystem;
  applyEdit: ReturnType<typeof createApplyEditToolDefinition>;
  dispose: () => void;
}

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function createHarness(
  overrides: {
    provider?: TrustedDecisionProvider;
    now?: () => number;
    workspaceIdA?: string;
  } = {}
): Promise<Harness> {
  const foundation = new PersistenceFoundation(); // in-memory sql.js
  await foundation.init();
  const db = foundation.getRawDatabase() as SQLDatabase;
  const proposalRepo = new SqlJsProposalRepository(db);
  const approvalRepo = new SqlJsApprovalRepository(db);
  const proposalPort = new ProposalRepositoryAdapter(proposalRepo);
  const approvalPort = new ApprovalRepositoryAdapter(approvalRepo);
  const provider = overrides.provider ?? makeTestProvider(APPROVED_DECISION);
  const now = overrides.now ?? (() => NOW);
  const service = createTrustedApprovalService({
    proposals: proposalPort,
    approvals: approvalPort,
    trustedDecisionProvider: provider,
    now,
    createApprovalId: () => crypto.randomUUID(),
  });

  const workspaceIdA = overrides.workspaceIdA ?? 'ws_a';
  const boundaryA = new TrustedEditAuthorizationBoundary({
    trustedApprovalService: service,
    proposalRepository: proposalPort,
    workspaceId: workspaceIdA,
    now,
  });
  const writableFS = new VSCodeWritableFileSystem({
    workspaceFolder: makeWorkspaceFolder(ROOT_A_URI, 'rootA'),
    fileSystem: {
      lstat: vi.fn((uri: string) => {
        const p = normalizeFsUri(uri);
        const s = store.current;
        if (!s) {
          const error = new Error('store not initialized') as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }
        if (s.files.has(p)) {
          const file = s.files.get(p)!;
          return {
            type: 'file' as const,
            size: new TextEncoder().encode(file.content).length,
            mtime: file.mtime,
            ctime: file.mtime,
          };
        }
        if (s.directories.has(p)) {
          return { type: 'directory' as const, size: 0, mtime: 0, ctime: 0 };
        }
        const error = new Error(`Not found: ${p}`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }),
    } as unknown as WritableFileSystemProvider,
  });
  const applyEdit = createApplyEditToolDefinition({
    authorization: boundaryA,
    writableFileSystem: writableFS,
  });

  return {
    db,
    proposalRepo,
    approvalRepo,
    service,
    provider,
    boundaryA,
    writableFS,
    applyEdit,
    dispose: () => void foundation.close(),
  };
}

function applyEditContext(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    workspaceId: 'ws_a',
    logger: createLogger(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apply_edit end-to-end authorization integration', () => {
  describe('authorized path', () => {
    it('applies the exact approved content and reports success only after the write', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      await establishApproval(h.service, h.provider);

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.kind).toBe('apply-edit-result');
      expect(result.outcome).toBe('applied');
      expect(result.approvalVerified).toBe(true);
      expect(result.appliedAt).not.toBeNull();
      expect(result.finalContentHash).toBe(PROPOSED_CONTENT_HASH);
      expect(result.finalSize).toBe(new TextEncoder().encode(PROPOSED_CONTENT).length);
      expect(result.error).toBeNull();
      expect(result.staleDetected).toBe(false);

      const stored = store.current!.files.get('/rootA/file.ts');
      expect(stored).toBeDefined();
      expect(stored!.content).toBe(PROPOSED_CONTENT);
      h.dispose();
    });
  });

  describe('denial paths', () => {
    it('denies when there is no approval (FailingTrustedDecisionProvider default)', async () => {
      const h = await createHarness({ provider: makeTestProvider(null) });
      await createProposal(h.proposalRepo);

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error).not.toBeNull();
      h.dispose();
    });

    it('denies a rejected approval', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      await establishApproval(h.service, h.provider, { decision: 'reject' });

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error?.message).toContain('not in approved state');
      h.dispose();
    });

    it('denies an expired approval', async () => {
      const h = await createHarness({
        now: () => NOW + 2_000_000,
        provider: makeTestProvider({ ...APPROVED_DECISION, expiresAt: NOW }),
      });
      await createProposal(h.proposalRepo, { expiresAt: NOW + 1_000_000 });
      await establishApproval(h.service, h.provider);

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error?.message).toContain('expired');
      h.dispose();
    });

    it('denies a revoked approval', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      const approvalId = await establishApproval(h.service, h.provider);
      const revResult = await h.approvalRepo.recordRevocation(approvalId);
      if (revResult.error !== null) {
        throw new Error(`recordRevocation failed: ${revResult.error.message}`);
      }

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      h.dispose();
    });

    it('denies a wrong proposal ID', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);

      const result = (await h.applyEdit.execute(
        { proposalId: '11111111-1111-1111-1111-111111111111', proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      h.dispose();
    });

    it('denies a wrong version', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo, { proposalVersion: 3 });

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      h.dispose();
    });

    it('denies when the approved content hash does not match the proposal', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo, { proposedContentHash: 'a'.repeat(64) });
      await expect(
        establishApproval(h.service, h.provider, { approvedContentHash: PROPOSED_CONTENT_HASH })
      ).rejects.toThrow();
      h.dispose();
    });

    it('denies when proposal content changed after approval (hash mismatch)', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      await establishApproval(h.service, h.provider);
      await h.proposalRepo.createProposal({
        id: PROPOSAL_ID,
        proposalVersion: 2,
        workspaceId: 'ws_a',
        workspaceFolderUri: ROOT_A_URI,
        fileUri: FILE_URI_A,
        relativePath: 'file.ts',
        originalContentHash: '0'.repeat(64),
        originalSize: 0,
        originalMtime: 0,
        operations: [{ kind: 'replace' }],
        proposedContent: 'const x = 2;',
        proposedContentHash: 'b'.repeat(64),
        proposedSize: 10,
        status: 'validated',
        createdAt: NOW,
        expiresAt: NOW + 1_000_000,
      });

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 2 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error).not.toBeNull();
      h.dispose();
    });

    it('denies a workspace mismatch (approval from another workspace cannot authorize)', async () => {
      const h = await createHarness({ workspaceIdA: 'ws_a' });
      await createProposal(h.proposalRepo, { workspaceId: 'ws_b', fileUri: FILE_URI_B });
      await establishApproval(h.service, h.provider, { workspaceId: 'ws_b', fileUri: FILE_URI_B });

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error?.message).toContain('Workspace identity mismatch');
      h.dispose();
    });

    it('denies when proposal reads fail (persistence failure)', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      vi.spyOn(h.proposalRepo, 'getProposal').mockRejectedValue(new Error('DB read failed'));

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      expect(result.error).not.toBeNull();
      h.dispose();
    });

    it('denies cancellation before authorization', async () => {
      const h = await createHarness();
      const controller = new AbortController();
      controller.abort();

      await expect(
        h.applyEdit.execute(
          { proposalId: PROPOSAL_ID, proposalVersion: 1 },
          applyEditContext(controller.signal)
        )
      ).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
      h.dispose();
    });

    it('reports cancellation when the writable filesystem reports WRITE_CANCELLED, not success', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      await establishApproval(h.service, h.provider);
      vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(
        new WritableFileSystemError('WRITE_CANCELLED', 'write cancelled')
      );

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('cancelled');
      expect(result.authorized).toBe(true);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.error).not.toBeNull();
      h.dispose();
    });

    it('does not apply when the write fails', async () => {
      const h = await createHarness();
      await createProposal(h.proposalRepo);
      await establishApproval(h.service, h.provider);
      vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValueOnce(new Error('ENOSPC'));

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(true);
      expect(result.appliedAt).toBeNull();
      expect(result.finalContentHash).toBeNull();
      expect(result.error).not.toBeNull();
      h.dispose();
    });
  });

  describe('trusted provider defaults', () => {
    it('fails closed with FailingTrustedDecisionProvider (no approval can be established)', async () => {
      const h = await createHarness({ provider: new FailingTrustedDecisionProvider() });
      await createProposal(h.proposalRepo);

      const result = (await h.applyEdit.execute(
        { proposalId: PROPOSAL_ID, proposalVersion: 1 },
        applyEditContext()
      )) as ApplyEditOutput;

      expect(result.outcome).toBe('failed');
      expect(result.authorized).toBe(false);
      h.dispose();
    });
  });
});

describe('apply_edit authorization boundary — multi-root isolation', () => {
  it('rejects a proposal from workspace B when the boundary is bound to workspace A', async () => {
    const h = await createHarness({ workspaceIdA: 'ws_a' });
    await createProposal(h.proposalRepo, { workspaceId: 'ws_b', fileUri: FILE_URI_B });
    await establishApproval(h.service, h.provider, { workspaceId: 'ws_b', fileUri: FILE_URI_B });

    // boundaryA is bound to ws_a; a ws_b proposal must be denied.
    const result = await h.boundaryA.verifyAndAuthorizeApplication({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('Workspace identity mismatch');
    h.dispose();
  });

  it('identical filenames in separate roots remain isolated', async () => {
    const h = await createHarness({ workspaceIdA: 'ws_a' });
    await createProposal(h.proposalRepo, {
      workspaceId: 'ws_a',
      fileUri: FILE_URI_A,
      relativePath: 'file.ts',
    });
    await createProposal(h.proposalRepo, {
      id: '66666666-6666-6666-6666-666666666666',
      workspaceId: 'ws_b',
      fileUri: FILE_URI_B,
      relativePath: 'file.ts',
    });
    await establishApproval(h.service, h.provider, {
      proposalId: PROPOSAL_ID,
      workspaceId: 'ws_a',
      fileUri: FILE_URI_A,
    });
    await establishApproval(h.service, h.provider, {
      proposalId: '66666666-6666-6666-6666-666666666666',
      workspaceId: 'ws_b',
      fileUri: FILE_URI_B,
    });

    const boundaryA = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: h.service,
      proposalRepository: new ProposalRepositoryAdapter(new SqlJsProposalRepository(h.db)),
      workspaceId: 'ws_a',
    });
    const boundaryB = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: h.service,
      proposalRepository: new ProposalRepositoryAdapter(new SqlJsProposalRepository(h.db)),
      workspaceId: 'ws_b',
    });

    const resultA = await boundaryA.verifyAndAuthorizeApplication({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
    });
    const resultB = await boundaryB.verifyAndAuthorizeApplication({
      proposalId: '66666666-6666-6666-6666-666666666666',
      proposalVersion: 1,
    });
    const crossA = await boundaryA.verifyAndAuthorizeApplication({
      proposalId: '66666666-6666-6666-6666-666666666666',
      proposalVersion: 1,
    });
    const crossB = await boundaryB.verifyAndAuthorizeApplication({
      proposalId: PROPOSAL_ID,
      proposalVersion: 1,
    });

    expect(resultA.authorized).toBe(true);
    expect(resultB.authorized).toBe(true);
    expect(crossA.authorized).toBe(false);
    expect(crossB.authorized).toBe(false);
    h.dispose();
  });
});
