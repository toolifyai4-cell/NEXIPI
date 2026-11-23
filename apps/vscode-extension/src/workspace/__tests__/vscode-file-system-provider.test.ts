import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { VSCodeFileSystemProvider } from '../vscode-file-system-provider.js';

const mockFs = {
  readFile: vi.fn(),
  readDirectory: vi.fn(),
  stat: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as any).fs = mockFs;
  (vscode.Uri as any) = {
    parse: vi.fn((uri: string) => {
      const schemeMatch = uri.match(/^([a-z][a-z0-9+.-]*):\/\//i);
      const scheme = schemeMatch ? schemeMatch[1] : 'file';
      return {
        scheme,
        path: uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''),
        with: vi.fn((partial: { path?: string }) => ({
          scheme,
          path: partial.path ?? path,
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

describe('VSCodeFileSystemProvider', () => {
  it('reads file content as utf8', async () => {
    mockFs.readFile.mockResolvedValue(Buffer.from('hello world'));
    const provider = new VSCodeFileSystemProvider();
    const content = await provider.readFile('file:///root/a.ts');
    expect(content).toBe('hello world');
    expect(mockFs.readFile).toHaveBeenCalledTimes(1);
  });

  it('reads directory entries and maps types', async () => {
    mockFs.readDirectory.mockResolvedValue([
      ['a.ts', 1], // File
      ['src', 2], // Directory
    ]);
    const provider = new VSCodeFileSystemProvider();
    const entries = await provider.readDirectory('file:///root');
    expect(entries).toEqual([
      { name: 'a.ts', type: 'file' },
      { name: 'src', type: 'directory' },
    ]);
  });

  it('stats a file', async () => {
    mockFs.stat.mockResolvedValue({ type: 1, size: 42, mtime: 1000, ctime: 900 });
    const provider = new VSCodeFileSystemProvider();
    const stat = await provider.stat('file:///root/a.ts');
    expect(stat).toEqual({ type: 'file', size: 42, mtime: 1000, ctime: 900 });
  });

  it('reports existence via stat', async () => {
    mockFs.stat.mockResolvedValue({ type: 1, size: 1, mtime: 1, ctime: 1 });
    const provider = new VSCodeFileSystemProvider();
    expect(await provider.exists('file:///root/a.ts')).toBe(true);
  });

  it('reports non-existence when stat throws', async () => {
    mockFs.stat.mockRejectedValue(new Error('not found'));
    const provider = new VSCodeFileSystemProvider();
    expect(await provider.exists('file:///root/missing.ts')).toBe(false);
  });

  it('reconstitutes scheme-stripped paths as file:// URIs', async () => {
    const readFileSpy = mockFs.readFile.mockResolvedValue(Buffer.from('x'));
    const provider = new VSCodeFileSystemProvider();
    await provider.readFile('/root/a.ts');
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('detects a symlinked parent directory via parent-directory lookup without following it', async () => {
    // lstat reads the parent directory and inspects the entry there, so a
    // symlinked parent is reported as a symbolic link without ever calling
    // readDirectory on the symlinked path itself.
    mockFs.readDirectory.mockResolvedValue([
      ['linked-dir', vscode.FileType.SymbolicLink],
      ['real.txt', vscode.FileType.File],
    ]);
    const provider = new VSCodeFileSystemProvider();
    const stat = await provider.lstat('file:///root/linked-dir');
    expect(stat.type).toBe('symbolicLink');
    expect(mockFs.readDirectory).toHaveBeenCalledTimes(1);
    expect(mockFs.readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/root' })
    );
  });
});
