import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { VSCodeWritableFileSystem } from '../vscode-writable-file-system.js';
import { InMemoryFileSystemProvider } from '../../test-utils/in-memory-file-system.js';

const mockFs = {
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
};

function makeFileStat(type: 'file' | 'directory' | 'symbolicLink', size = 1, mtime = 1, ctime = 1) {
  return { type, size, mtime, ctime };
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as any).fs = mockFs;
  (vscode.Uri as any) = {
    parse: vi.fn((uri: string) => {
      const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/\//i);
      const scheme = schemeMatch ? schemeMatch[1] : 'file';
      const pathValue = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      return {
        scheme,
        path: pathValue,
        with: vi.fn((partial: { path?: string }) => ({
          scheme,
          path: partial.path ?? pathValue,
          toString: () => uri,
        })),
        toString: () => uri,
      };
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeAdapter(fileSystem: InMemoryFileSystemProvider, workspaceUri = 'file:///root') {
  fileSystem.createDirectory('/root');
  fileSystem.createDirectory('/root/src');
  return new VSCodeWritableFileSystem({
    workspaceFolder: {
      id: 'ws_test',
      uri: workspaceUri,
      name: 'test',
      index: 0,
    },
    fileSystem,
  });
}

function makeStubFs(): any {
  return {
    readFile: vi.fn(),
    readDirectory: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(async (uri: string) =>
      uri === '/root/src/link' ? makeFileStat('symbolicLink') : makeFileStat('directory')
    ),
    exists: vi.fn(),
  };
}

describe('VSCodeWritableFileSystem', () => {
  it('writes bytes preserving content via temp file + rename', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    const content = new Uint8Array([104, 105, 10]); // "hi\n"

    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);

    await adapter.writeFile('file:///root/src/a.ts', content);

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFs.rename).toHaveBeenCalledTimes(1);
    const renameArgs = mockFs.rename.mock.calls[0] as any;
    expect(renameArgs[0].toString()).toContain('/src');
    expect(renameArgs[1].toString()).toContain('/src/a.ts');
    expect(renameArgs[2]).toEqual({ overwrite: true });
  });

  it('preserves binary content exactly on write', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    inMemory.createDirectory('/root');
    inMemory.createDirectory('/root/bin');
    const adapter = new VSCodeWritableFileSystem({
      workspaceFolder: {
        id: 'ws_test',
        uri: 'file:///root',
        name: 'test',
        index: 0,
      },
      fileSystem: inMemory,
    });
    const binary = new Uint8Array([0, 137, 80, 78, 71, 13, 10, 26, 10]);

    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);

    await adapter.writeFile('file:///root/bin/image.png', binary);

    const writeArgs = mockFs.writeFile.mock.calls[0] as any;
    expect(writeArgs[0]).toBeDefined();
    expect(Buffer.from(writeArgs[1])).toEqual(Buffer.from(binary));
  });

  it('renames a file successfully', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    inMemory.writeFile('/root/src/a.ts', 'hello');

    mockFs.rename.mockResolvedValue(undefined);

    await adapter.rename('file:///root/src/a.ts', 'file:///root/src/b.ts');

    const renameArgs = mockFs.rename.mock.calls[0] as any;
    expect(renameArgs[0].toString()).toContain('/src/a.ts');
    expect(renameArgs[1].toString()).toContain('/src/b.ts');
    expect(renameArgs[2]).toEqual({ overwrite: false });
  });

  it('fails with RENAME_NOT_FOUND when source file is missing', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);

    await expect(
      adapter.rename('file:///root/src/missing.ts', 'file:///root/src/b.ts')
    ).rejects.toMatchObject({ code: 'RENAME_NOT_FOUND' });
  });

  it('fails with RENAME_OVERWRITE_DISALLOWED when destination collides and overwrite is false', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    inMemory.writeFile('/root/src/a.ts', 'hello');
    inMemory.writeFile('/root/src/b.ts', 'world');

    mockFs.rename.mockRejectedValue(
      Object.assign(new Error('EEXIST: file exists'), { code: 'EEXIST' })
    );

    await expect(
      adapter.rename('file:///root/src/a.ts', 'file:///root/src/b.ts')
    ).rejects.toMatchObject({ code: 'RENAME_OVERWRITE_DISALLOWED' });
  });

  it('fails with WRITE_PERMISSION_DENIED on write permission failure', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    mockFs.writeFile.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    await expect(
      adapter.writeFile('file:///root/src/a.ts', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'WRITE_PERMISSION_DENIED' });
  });

  it('fails with WRITE_INVALID_DESTINATION when destination is outside the workspace', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);

    await expect(
      adapter.writeFile('file:///outside/a.ts', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'WRITE_INVALID_DESTINATION' });
  });

  it('throws WRITE_CANCELLED before the write operation when signal is aborted', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.writeFile('file:///root/src/a.ts', new Uint8Array([1]), controller.signal)
    ).rejects.toMatchObject({ code: 'WRITE_CANCELLED' });

    await expect(
      adapter.rename('file:///root/src/a.ts', 'file:///root/src/b.ts', controller.signal)
    ).rejects.toMatchObject({ code: 'RENAME_CANCELLED' });

    await expect(
      adapter.deleteFile('file:///root/src/a.ts', controller.signal)
    ).rejects.toMatchObject({ code: 'DELETE_CANCELLED' });
  });

  it('cleans up temporary file and preserves the rename failure error', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    const renameError = new Error('rename failed');
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockRejectedValue(renameError);

    await expect(
      adapter.writeFile('file:///root/src/a.ts', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'RENAME_FILESYSTEM_ERROR' });

    // Cleanup should have been attempted against the temp file
    expect(mockFs.delete).toHaveBeenCalledTimes(1);
  });

  it('preserves the original rename error when temp cleanup fails', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = makeAdapter(inMemory);
    const renameError = new Error('rename failed');
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockRejectedValue(renameError);
    mockFs.delete.mockRejectedValue(new Error('cleanup failed'));

    const error = await adapter
      .writeFile('file:///root/src/a.ts', new Uint8Array([1]))
      .catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('rename failed');
  });

  it('rejects writes to symlinked paths with WRITE_SYMLINK_NOT_ALLOWED', async () => {
    const stubFs = makeStubFs();
    const symlinkAdapter = new VSCodeWritableFileSystem({
      workspaceFolder: {
        id: 'ws_test',
        uri: 'file:///root',
        name: 'test',
        index: 0,
      },
      fileSystem: stubFs,
    });

    await expect(
      symlinkAdapter.writeFile('file:///root/src/link', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'WRITE_SYMLINK_NOT_ALLOWED' });
  });

  it('enforces workspace isolation with multiple roots', async () => {
    const inMemory = new InMemoryFileSystemProvider();
    const adapter = new VSCodeWritableFileSystem({
      workspaceFolder: {
        id: 'ws_other',
        uri: 'file:///other',
        name: 'other',
        index: 0,
      },
      fileSystem: inMemory,
    });

    await expect(
      adapter.writeFile('file:///root/src/a.ts', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'WRITE_INVALID_DESTINATION' });
  });
});
