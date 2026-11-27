import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FileSystemProvider } from '@nexipi/workspace';
import {
  PersistenceFoundation,
  SqlJsProposalRepository,
  SqlJsApprovalRepository,
  type SQLDatabase,
} from '@nexipi/persistence';
import {
  createTrustedApprovalService,
  defaultNow,
  sha256,
  type TrustedDecisionProvider,
  type TrustedUserDecision,
  type TrustedUserDecisionRequest,
} from '@nexipi/workspace';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from '../persistence-repository-adapters.js';
import { ProposalCreationRepositoryAdapter } from '../proposal-creation-boundary.js';
import { ApprovalController } from '../approval-controller.js';
import { TrustedEditAuthorizationBoundary } from '../edit-authorization-boundary.js';
import type { Logger } from '@nexipi/core';

const NOW = 1_700_000_000_000;
const WORKSPACE_ID = 'ws_a';
const FILE_URI = 'file:///rootA/file.ts';
const PROPOSAL_ID_HINT = '550e8400-e29b-41d4-a716-446655440000';
const PROPOSED_CONTENT = 'const x = 1;';
const PROPOSED_HASH = sha256(PROPOSED_CONTENT);
const ORIGINAL_CONTENT = 'const x = 0;';
const ORIGINAL_HASH = sha256(ORIGINAL_CONTENT);

function normalizeUri(uri: string): string {
  return uri.replace(/^file:\/\//i, '').replace(/\\/g, '/');
}

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeGate(): {
  provider: TrustedDecisionProvider;
  calls: TrustedUserDecisionRequest[];
  settle: (value: TrustedUserDecision | null) => void;
} {
  const calls: TrustedUserDecisionRequest[] = [];
  let resolveFn: ((value: TrustedUserDecision | null) => void) | undefined;
  let queued: TrustedUserDecision | null | undefined;
  const provider: TrustedDecisionProvider = {
    establishUserDecision: async request => {
      calls.push(request);
      return new Promise<TrustedUserDecision | null>(resolve => {
        resolveFn = resolve;
        if (queued !== undefined) {
          const value = queued;
          queued = undefined;
          resolve(value);
        }
      });
    },
  };
  return {
    provider,
    calls,
    settle: (value: TrustedUserDecision | null) => {
      if (resolveFn) {
        resolveFn(value);
      } else {
        queued = value;
      }
    },
  };
}

interface Harness {
  db: SQLDatabase;
  proposalRepo: SqlJsProposalRepository;
  service: TrustedApprovalService;
  controller: ApprovalController;
  gate: ReturnType<typeof makeGate>;
  posted: Array<{ type: string; payload: unknown }>;
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const foundation = new PersistenceFoundation();
  await foundation.init();
  const db = foundation.getRawDatabase() as SQLDatabase;
  const proposalRepo = new SqlJsProposalRepository(db);
  const approvalRepo = new SqlJsApprovalRepository(db);
  const proposalPort = new ProposalRepositoryAdapter(proposalRepo);
  const approvalPort = new ApprovalRepositoryAdapter(approvalRepo);
  const gate = makeGate();
  const service = createTrustedApprovalService({
    proposals: proposalPort,
    approvals: approvalPort,
    trustedDecisionProvider: gate.provider,
    now: () => NOW,
    createApprovalId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const posted: Array<{ type: string; payload: unknown }> = [];
  const controller = new ApprovalController({
    trustedApprovalService: service,
    proposals: proposalPort,
    approvals: approvalPort,
    postMessage: message => posted.push({ type: 'message', payload: message }),
    logger: makeLogger(),
  });
  return {
    db,
    proposalRepo,
    service,
    controller,
    gate,
    posted,
    dispose: async () => {
      controller.dispose();
      foundation.close();
    },
  };
}

function readOnlyFileSystem(contents: Map<string, string>): FileSystemProvider {
  return {
    readFile: async (uri: string) => {
      const key = normalizeUri(uri);
      const content = contents.get(key);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, read '${uri}'`);
      }
      return content;
    },
  } as unknown as FileSystemProvider;
}

function previewFor(proposalId: string): {
  kind: 'edit-preview';
  proposalId: string;
  fileUri: string;
  relativePath: string;
  originalContent: string;
  proposedContent: string;
  diffSummary: { linesAdded: number; linesRemoved: number; linesModified: number };
  truncated: boolean;
  originalTruncated: boolean;
  proposedTruncated: boolean;
} {
  return {
    kind: 'edit-preview',
    proposalId,
    fileUri: FILE_URI,
    relativePath: 'file.ts',
    originalContent: ORIGINAL_CONTENT,
    proposedContent: PROPOSED_CONTENT,
    diffSummary: { linesAdded: 1, linesRemoved: 1, linesModified: 0 },
    truncated: false,
    originalTruncated: false,
    proposedTruncated: false,
  };
}

function registerPending(
  controller: ApprovalController,
  proposalId: string,
  expiresAt: number
): void {
  controller.onProposalCreated({
    proposalId,
    proposalVersion: 1,
    fileUri: FILE_URI,
    relativePath: 'file.ts',
    workspaceId: WORKSPACE_ID,
    workspaceName: 'rootA',
    proposedContentHash: PROPOSED_HASH,
    proposedSize: Buffer.byteLength(PROPOSED_CONTENT, 'utf8'),
    createdAt: NOW,
    expiresAt,
    preview: previewFor(proposalId),
  });
}

describe('Editing workflow — end to end', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.dispose();
    vi.restoreAllMocks();
  });

  it('successful proposal -> trusted approval -> authorized application', async () => {
    const fs = readOnlyFileSystem(new Map([[normalizeUri(FILE_URI), ORIGINAL_CONTENT]]));
    const creation = new ProposalCreationRepositoryAdapter({
      repository: h.proposalRepo,
      fileSystem: fs,
    });

    const created = await creation.createProposal({
      fileUri: FILE_URI,
      workspaceId: WORKSPACE_ID,
      workspaceFolderUri: 'file:///rootA',
      relativePath: 'file.ts',
      originalContentHash: ORIGINAL_HASH,
      originalSize: Buffer.byteLength(ORIGINAL_CONTENT, 'utf8'),
      originalMtime: NOW,
      operations: [
        { kind: 'replace-lines', startLine: 1, endLine: 1, newContent: PROPOSED_CONTENT },
      ],
    });
    expect(created.status).toBe('awaiting-approval');

    registerPending(h.controller, created.proposalId, created.expiresAt);

    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await decisionPromise;

    const boundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: h.service,
      proposalRepository: new ProposalRepositoryAdapter(h.proposalRepo),
      fileSystem: fs,
      workspaceId: WORKSPACE_ID,
      now: () => NOW,
    });

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
    });
    expect(authorization.authorized).toBe(true);
    expect(authorization.apply!.fileUri).toBe(FILE_URI);
    expect(authorization.apply!.relativePath).toBe('file.ts');
    expect(authorization.apply!.proposedContent).toBe(PROPOSED_CONTENT);
    expect(authorization.apply!.proposedContentHash).toBe(PROPOSED_HASH);

    // The write intent produced by the authorization boundary is exactly the
    // persisted proposed content.
    const written: Array<{ uri: string; content: Uint8Array }> = [];
    const writableFileSystem = {
      writeFile: async (uri: string, content: Uint8Array) => {
        written.push({ uri, content });
      },
    };
    await writableFileSystem.writeFile(
      authorization.apply!.fileUri,
      Buffer.from(authorization.apply!.proposedContent, 'utf8')
    );
    expect(written.length).toBe(1);
    expect(written[0]!.uri).toBe(FILE_URI);
    expect(written[0]!.content.toString('utf8')).toBe(PROPOSED_CONTENT);
  });

  it('rejected proposal is not authorized for application', async () => {
    const fs = readOnlyFileSystem(new Map([[normalizeUri(FILE_URI), ORIGINAL_CONTENT]]));
    const creation = new ProposalCreationRepositoryAdapter({
      repository: h.proposalRepo,
      fileSystem: fs,
    });

    const created = await creation.createProposal({
      fileUri: FILE_URI,
      workspaceId: WORKSPACE_ID,
      workspaceFolderUri: 'file:///rootA',
      relativePath: 'file.ts',
      originalContentHash: ORIGINAL_HASH,
      originalSize: Buffer.byteLength(ORIGINAL_CONTENT, 'utf8'),
      originalMtime: NOW,
      operations: [
        { kind: 'replace-lines', startLine: 1, endLine: 1, newContent: PROPOSED_CONTENT },
      ],
    });

    registerPending(h.controller, created.proposalId, created.expiresAt);
    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
      decision: 'reject',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'reject',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await decisionPromise;

    const boundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: h.service,
      proposalRepository: new ProposalRepositoryAdapter(h.proposalRepo),
      fileSystem: fs,
      workspaceId: WORKSPACE_ID,
      now: () => NOW,
    });

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
    });
    expect(authorization.authorized).toBe(false);
  });

  it('file changed after proposal is rejected at application time', async () => {
    const contents = new Map([[normalizeUri(FILE_URI), ORIGINAL_CONTENT]]);
    const fs = readOnlyFileSystem(contents);
    const creation = new ProposalCreationRepositoryAdapter({
      repository: h.proposalRepo,
      fileSystem: fs,
    });

    const created = await creation.createProposal({
      fileUri: FILE_URI,
      workspaceId: WORKSPACE_ID,
      workspaceFolderUri: 'file:///rootA',
      relativePath: 'file.ts',
      originalContentHash: ORIGINAL_HASH,
      originalSize: Buffer.byteLength(ORIGINAL_CONTENT, 'utf8'),
      originalMtime: NOW,
      operations: [
        { kind: 'replace-lines', startLine: 1, endLine: 1, newContent: PROPOSED_CONTENT },
      ],
    });

    // Change the file after the proposal was created.
    contents.set(normalizeUri(FILE_URI), 'const x = 99;');

    registerPending(h.controller, created.proposalId, created.expiresAt);
    const decisionPromise = h.controller.handleApprovalAction({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
      decision: 'approve',
      workspaceId: WORKSPACE_ID,
      fileUri: FILE_URI,
    });
    h.gate.settle({
      decision: 'approve',
      boundary: 'test-boundary',
      decidedAt: NOW,
      expiresAt: null,
    });
    await decisionPromise;

    const boundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: h.service,
      proposalRepository: new ProposalRepositoryAdapter(h.proposalRepo),
      fileSystem: fs,
      workspaceId: WORKSPACE_ID,
      now: () => NOW,
    });

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: created.proposalId,
      proposalVersion: created.proposalVersion,
    });
    expect(authorization.authorized).toBe(false);
    expect(authorization.staleDetected).toBe(true);
  });
});
