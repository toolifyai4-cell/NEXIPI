import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersistenceFoundation } from '@nexipi/persistence';
import { SqlJsProposalRepository, SqlJsApprovalRepository } from '@nexipi/persistence';
import { TrustedApprovalService, defaultNow, TrustedDecisionProvider } from '@nexipi/workspace';
import { TrustedEditAuthorizationBoundary } from '../editing/edit-authorization-boundary';
import {
  ProposalRepositoryAdapter,
  ApprovalRepositoryAdapter,
} from '../editing/persistence-repository-adapters';
import { sha256 } from '@nexipi/workspace';
import type { FileSystemProvider } from '@nexipi/workspace';

const ORIGINAL_CONTENT = 'original content here';
const ORIGINAL_HASH = sha256(ORIGINAL_CONTENT);
const PROPOSED_CONTENT = 'proposed content here';
const PROPOSED_HASH = sha256(PROPOSED_CONTENT);

function makeFileSystem(overrides: Partial<FileSystemProvider> = {}): FileSystemProvider {
  return {
    readFile: vi.fn(() => Promise.resolve(ORIGINAL_CONTENT)),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    exists: vi.fn(),
    ...overrides,
  } as FileSystemProvider;
}

function makeProposalInput(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    proposalVersion: 1,
    workspaceId: 'ws-1',
    workspaceFolderUri: 'file:///workspace',
    fileUri: 'file:///workspace/file.txt',
    relativePath: 'file.txt',
    originalContentHash: ORIGINAL_HASH,
    originalSize: Buffer.byteLength(ORIGINAL_CONTENT, 'utf8'),
    originalMtime: 1000,
    operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: PROPOSED_CONTENT }],
    proposedContent: PROPOSED_CONTENT,
    proposedContentHash: PROPOSED_HASH,
    proposedSize: Buffer.byteLength(PROPOSED_CONTENT, 'utf8'),
    status: 'awaiting-approval' as const,
    createdAt: 1000,
    expiresAt: 2_000_000_000_000,
    ...overrides,
  };
}

describe('apply_edit approval integration (Stage F)', () => {
  let service: any;
  let proposalRepository: SqlJsProposalRepository;
  let approvalRepository: SqlJsApprovalRepository;
  let proposalPort: ProposalRepositoryAdapter;
  let approvalPort: ApprovalRepositoryAdapter;
  let trustedService: TrustedApprovalService;
  let provider: TrustedDecisionProvider;
  let fileSystem: FileSystemProvider;
  let boundary: TrustedEditAuthorizationBoundary;

  beforeEach(async () => {
    service = new PersistenceFoundation();
    await service.init();
    const rawDb = service.getRawDatabase();
    proposalRepository = new SqlJsProposalRepository(rawDb);
    approvalRepository = new SqlJsApprovalRepository(rawDb);
    proposalPort = new ProposalRepositoryAdapter(proposalRepository);
    approvalPort = new ApprovalRepositoryAdapter(approvalRepository);

    provider = {
      establishUserDecision: vi.fn(() =>
        Promise.resolve({
          decision: 'approve',
          boundary: 'vscode-host:confirm-dialog',
          decidedAt: 1_500_000_000_000,
          expiresAt: 2_000_000_000_000,
        })
      ),
    };
    trustedService = new TrustedApprovalService({
      proposals: proposalPort,
      approvals: approvalPort,
      trustedDecisionProvider: provider,
      now: defaultNow,
      createApprovalId: () => crypto.randomUUID() as never,
    });

    fileSystem = makeFileSystem();
    boundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: trustedService,
      proposalRepository: proposalPort,
      fileSystem,
      workspaceId: 'ws-1',
    });

    await proposalRepository.createProposal(makeProposalInput());
  });

  afterEach(() => {
    service.close();
  });

  async function approveProposal(): Promise<string> {
    const result = await trustedService.createApprovalDecision({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'approve',
      approvedContentHash: PROPOSED_HASH,
      provenance: { kind: 'trusted-boundary', boundary: 'vscode-host:confirm-dialog' },
      decidedAt: 1_500_000_000_000,
      expiresAt: 2_000_000_000_000,
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });
    return result.approvalId;
  }

  it('an approved proposal authorizes apply_edit with the exact stored content', async () => {
    await approveProposal();

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(true);
    expect(authorization.approval!.decision).toBe('approve');
    expect(authorization.apply).toBeDefined();
    expect(authorization.apply!.fileUri).toBe('file:///workspace/file.txt');
    expect(authorization.apply!.proposedContent).toBe(PROPOSED_CONTENT);
    expect(authorization.apply!.proposedContentHash).toBe(PROPOSED_HASH);
  });

  it('a rejected proposal cannot be applied', async () => {
    vi.mocked(provider.establishUserDecision).mockResolvedValueOnce({
      decision: 'reject',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
    });
    await trustedService.createApprovalDecision({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
      decision: 'reject',
      approvedContentHash: PROPOSED_HASH,
      provenance: { kind: 'trusted-boundary', boundary: 'vscode-host:confirm-dialog' },
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.apply).toBeUndefined();
  });

  it('an unapproved proposal cannot be applied', async () => {
    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.apply).toBeUndefined();
  });

  it('a wrong proposal version is not authorized', async () => {
    await approveProposal();

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 99,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.apply).toBeUndefined();
  });

  it('a wrong content hash cannot be approved', async () => {
    await expect(
      trustedService.createApprovalDecision({
        proposalId: '11111111-1111-1111-1111-111111111111',
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: '0000000000000000000000000000000000000000000000000000000000000000',
        provenance: { kind: 'trusted-boundary', boundary: 'vscode-host:confirm-dialog' },
        decidedAt: 1_500_000_000_000,
        expiresAt: 2_000_000_000_000,
        workspaceId: 'ws-1',
        fileUri: 'file:///workspace/file.txt',
      })
    ).rejects.toThrow(/content hash/);
  });

  it('a proposal from another workspace cannot be authorized here', async () => {
    await proposalRepository.createProposal({
      ...makeProposalInput({
        id: '22222222-2222-2222-2222-222222222222',
        workspaceId: 'ws-other',
        fileUri: 'file:///workspace-other/other.txt',
      }),
    });
    await approveProposal(); // approves ws-1 proposal

    const otherBoundary = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: trustedService,
      proposalRepository: proposalPort,
      fileSystem,
      workspaceId: 'ws-other',
    });

    const authorization = await otherBoundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.apply).toBeUndefined();
  });

  it('a stale target file blocks application', async () => {
    await approveProposal();
    vi.mocked(fileSystem.readFile).mockResolvedValueOnce('modified content');

    const authorization = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.staleDetected).toBe(true);
    expect(authorization.apply).toBeUndefined();
  });

  it('an expired proposal cannot be approved at decision time', async () => {
    await proposalRepository.createProposal({
      ...makeProposalInput({
        id: '33333333-3333-3333-3333-333333333333',
        createdAt: 1,
        expiresAt: 2,
      }),
    });
    vi.mocked(provider.establishUserDecision).mockResolvedValueOnce({
      decision: 'approve',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: null,
    });

    // createApprovalDecision rejects because now (defaultNow) > expiresAt (2).
    await expect(
      trustedService.createApprovalDecision({
        proposalId: '33333333-3333-3333-3333-333333333333',
        proposalVersion: 1,
        decision: 'approve',
        approvedContentHash: PROPOSED_HASH,
        provenance: { kind: 'trusted-boundary', boundary: 'vscode-host:confirm-dialog' },
        decidedAt: 1_500_000_000_000,
        expiresAt: 2,
        workspaceId: 'ws-1',
        fileUri: 'file:///workspace/file.txt',
      })
    ).rejects.toThrow(/expired/);

    // No approval record was persisted.
    const approval = await approvalPort.getApprovalForVersion(
      '33333333-3333-3333-3333-333333333333',
      1
    );
    expect(approval.approval).toBeNull();
  });

  it('an already-approved proposal that has expired cannot be applied', async () => {
    await proposalRepository.createProposal({
      ...makeProposalInput({
        id: '44444444-4444-4444-4444-444444444444',
        createdAt: 1,
        expiresAt: 2_000_000_000_000,
      }),
    });
    vi.mocked(provider.establishUserDecision).mockResolvedValueOnce({
      decision: 'approve',
      boundary: 'vscode-host:confirm-dialog',
      decidedAt: 1_500_000_000_000,
      expiresAt: 2_000_000_000_000,
    });

    // Approve while not expired: use a service with a clock before expiresAt.
    const preExpiryService = new TrustedApprovalService({
      proposals: proposalPort,
      approvals: approvalPort,
      trustedDecisionProvider: provider,
      now: () => 1_500_000_000_000,
      createApprovalId: () => crypto.randomUUID() as never,
    });

    await preExpiryService.createApprovalDecision({
      proposalId: '44444444-4444-4444-4444-444444444444',
      proposalVersion: 1,
      decision: 'approve',
      approvedContentHash: PROPOSED_HASH,
      provenance: { kind: 'trusted-boundary', boundary: 'vscode-host:confirm-dialog' },
      decidedAt: 1_500_000_000_000,
      expiresAt: 2_000_000_000_000,
      workspaceId: 'ws-1',
      fileUri: 'file:///workspace/file.txt',
    });

    // At apply time, now is past expiresAt -> not authorized.
    const boundaryExpired = new TrustedEditAuthorizationBoundary({
      trustedApprovalService: trustedService,
      proposalRepository: proposalPort,
      fileSystem,
      workspaceId: 'ws-1',
      now: () => 2_000_000_000_001, // past expiresAt
    });

    const authorization = await boundaryExpired.verifyAndAuthorizeApplication({
      proposalId: '44444444-4444-4444-4444-444444444444',
      proposalVersion: 1,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.apply).toBeUndefined();
  });

  it('multiple pending proposals remain isolated by identity', async () => {
    await proposalRepository.createProposal({
      ...makeProposalInput({
        id: '44444444-4444-4444-4444-444444444444',
        fileUri: 'file:///workspace/other.txt',
        relativePath: 'other.txt',
        proposedContent: 'other content',
        proposedContentHash: sha256('other content'),
      }),
    });
    await approveProposal(); // approves the ws-1 file.txt proposal

    // The other.txt proposal has no approval -> cannot be applied.
    const other = await boundary.verifyAndAuthorizeApplication({
      proposalId: '44444444-4444-4444-4444-444444444444',
      proposalVersion: 1,
    });
    expect(other.authorized).toBe(false);

    // The file.txt proposal IS authorized.
    const main = await boundary.verifyAndAuthorizeApplication({
      proposalId: '11111111-1111-1111-1111-111111111111',
      proposalVersion: 1,
    });
    expect(main.authorized).toBe(true);
    expect(main.apply!.proposedContent).toBe(PROPOSED_CONTENT);
  });
});
