import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersistenceFoundation, SqlJsProposalRepository } from '@nexipi/persistence';
import { ProposalCreationRepositoryAdapter } from '../proposal-creation-boundary';
import type { FileSystemProvider } from '@nexipi/workspace';
import { sha256 } from '@nexipi/workspace';

const ORIGINAL_HASH =
  '1111111111111111111111111111111111111111111111111111111111111111';
const PROPOSED_HASH =
  '2222222222222222222222222222222222222222222222222222222222222222';

function makeFileSystem(overrides: Partial<FileSystemProvider> = {}): FileSystemProvider {
  return {
    readFile: vi.fn(),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    exists: vi.fn(),
    ...overrides,
  } as FileSystemProvider;
}

describe('ProposalCreationRepositoryAdapter', () => {
  let service: PersistenceFoundation;
  let repository: SqlJsProposalRepository;
  let adapter: ProposalCreationRepositoryAdapter;

  beforeEach(async () => {
    service = new PersistenceFoundation();
    await service.init();
    repository = new SqlJsProposalRepository(service.getRawDatabase());
    const fileSystem = makeFileSystem({
      readFile: vi.fn(() => Promise.resolve('original content here')),
    });
    adapter = new ProposalCreationRepositoryAdapter({ repository, fileSystem });
  });

  afterEach(() => {
    service.close();
  });

  it('creates a persisted proposal awaiting approval', async () => {
    const originalContentHash = sha256('original content here');
    const result = await adapter.createProposal({
      workspaceId: 'ws-1',
      workspaceFolderUri: 'file:///workspace',
      fileUri: 'file:///workspace/file.txt',
      relativePath: 'file.txt',
      originalContentHash,
      originalSize: 22,
      originalMtime: 1000,
      operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'proposed' }],
      proposedContentHash: PROPOSED_HASH,
      proposedSize: 8,
    });

    expect(result.proposalId).toBeDefined();
    expect(result.proposalVersion).toBe(1);
    expect(result.status).toBe('awaiting-approval');
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.expiresAt).toBeGreaterThan(result.createdAt);

    const get = await repository.getProposal(result.proposalId, 1);
    expect(get.error).toBeNull();
    expect(get.proposal!.proposedContent).toBe('proposed');
    expect(get.proposal!.proposedContentHash).toBe(sha256('proposed'));
    expect(get.proposal!.workspaceId).toBe('ws-1');
    expect(get.proposal!.fileUri).toBe('file:///workspace/file.txt');
  });

  it('fails closed when the original content hash does not match (stale file)', async () => {
    const fileSystem = makeFileSystem({
      readFile: vi.fn(() => Promise.resolve('different content')),
    });
    const staleAdapter = new ProposalCreationRepositoryAdapter({ repository, fileSystem });

    await expect(
      staleAdapter.createProposal({
        workspaceId: 'ws-1',
        workspaceFolderUri: 'file:///workspace',
        fileUri: 'file:///workspace/file.txt',
        relativePath: 'file.txt',
        originalContentHash: ORIGINAL_HASH,
        originalSize: 22,
        originalMtime: 1000,
        operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'x' }],
        proposedContentHash: PROPOSED_HASH,
        proposedSize: 1,
      })
    ).rejects.toThrow(/hash mismatch/);
  });

  it('fails closed when the target file cannot be read', async () => {
    const fileSystem = makeFileSystem({
      readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    });
    const failingAdapter = new ProposalCreationRepositoryAdapter({ repository, fileSystem });

    await expect(
      failingAdapter.createProposal({
        workspaceId: 'ws-1',
        workspaceFolderUri: 'file:///workspace',
        fileUri: 'file:///workspace/file.txt',
        relativePath: 'file.txt',
        originalContentHash: ORIGINAL_HASH,
        originalSize: 22,
        originalMtime: 1000,
        operations: [{ kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'x' }],
        proposedContentHash: PROPOSED_HASH,
        proposedSize: 1,
      })
    ).rejects.toThrow(/Failed to read target file/);
  });
});
