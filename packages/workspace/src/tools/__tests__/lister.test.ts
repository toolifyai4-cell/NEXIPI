import { describe, it, expect, beforeEach } from 'vitest';
import {
  DirectoryLister,
  createDirectoryLister,
  ToolErrorCode,
  ToolError,
  type DirectoryListConfig,
} from '../index.js';
import type {
  FileSystemProvider,
  DirectoryEntry,
  FileStat,
} from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return {
    id: createWorkspaceFolderId(uri),
    uri,
    name,
    index: 0,
  };
}

class VirtualFileSystem implements FileSystemProvider {
  private files = new Map<string, string>();
  private stats = new Map<string, FileStat & { ctime: number }>();
  private dirs = new Map<string, DirectoryEntry[]>();
  private failingStat = new Set<string>();
  private failingLstat = new Set<string>();
  private failingRead = new Set<string>();
  private failingReaddir = new Set<string>();

  private key(p: string): string {
    return p
      .replace(/^file:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/\/+$/, '');
  }

  private registerDirEntry(dirPath: string, name: string, type: DirectoryEntry['type']): void {
    const k = this.key(dirPath);
    if (!this.dirs.has(k)) {
      this.dirs.set(k, []);
    }
    const entries = this.dirs.get(k)!;
    if (!entries.some(e => e.name === name)) {
      entries.push({ name, type });
    }
  }

  addDirEntry(dirPath: string, name: string, type: DirectoryEntry['type']): void {
    this.registerDirEntry(dirPath, name, type);
  }

  addFile(p: string, content: string): void {
    const k = this.key(p);
    this.files.set(k, content);
    this.stats.set(k, { type: 'file', size: content.length, mtime: Date.now(), ctime: Date.now() });
  }

  addDir(p: string, entries: DirectoryEntry[] = []): void {
    const k = this.key(p);
    this.stats.set(k, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
    this.dirs.set(k, [...entries]);
  }

  failStat(p: string): void {
    this.failingStat.add(this.key(p));
  }

  failLstat(p: string): void {
    this.failingLstat.add(this.key(p));
  }

  failRead(p: string): void {
    this.failingRead.add(this.key(p));
  }

  failReaddir(p: string): void {
    this.failingReaddir.add(this.key(p));
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const k = this.key(uri);
    if (this.failingReaddir.has(k)) {
      throw new Error(`EACCES: permission denied, readDirectory '${uri}'`);
    }
    const base = this.dirs.get(k);
    if (base === undefined) {
      throw new Error(`ENOENT: no such directory, readDirectory '${uri}'`);
    }
    return [...base];
  }

  async stat(uri: string): Promise<FileStat> {
    const k = this.key(uri);
    if (this.failingStat.has(k)) {
      throw new Error(`ENOENT: no such file or directory, stat '${uri}'`);
    }
    const s = this.stats.get(k);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory, stat '${uri}'`);
    }
    return { ...s };
  }

  async lstat(uri: string): Promise<FileStat> {
    const k = this.key(uri);
    if (this.failingLstat.has(k)) {
      throw new Error(`cannot determine symlink status, lstat '${uri}'`);
    }
    const s = this.stats.get(k);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory, lstat '${uri}'`);
    }
    return { ...s };
  }

  async readFile(uri: string): Promise<string> {
    const k = this.key(uri);
    if (this.failingRead.has(k)) {
      throw new Error(`EACCES: permission denied, read '${uri}'`);
    }
    const content = this.files.get(k);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, read '${uri}'`);
    }
    return content;
  }

  async exists(uri: string): Promise<boolean> {
    const k = this.key(uri);
    return this.files.has(k) || this.stats.has(k);
  }
}

function makeUri(path: string): string {
  return `file://${path}`;
}

function createLister(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Partial<DirectoryListConfig>
) {
  return createDirectoryLister({
    fileSystem: vfs,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    config,
  });
}

function expectToolError(promise: Promise<unknown>, code: ToolErrorCode): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'ToolError',
    code,
  } as ToolError);
}

function buildTree(vfs: VirtualFileSystem): void {
  vfs.addDir('/root', [
    { name: 'file1.ts', type: 'file' },
    { name: 'file2.js', type: 'file' },
    { name: 'sub', type: 'directory' },
    { name: '.env', type: 'file' },
    { name: '.git', type: 'directory' },
    { name: 'node_modules', type: 'directory' },
  ]);
  vfs.addFile('/root/file1.ts', 'export const a = 1;\n');
  vfs.addFile('/root/file2.js', 'const b = 2;\n');
  vfs.addFile('/root/.env', 'SECRET=1\n');

  vfs.addDir('/root/.git', [{ name: 'config', type: 'file' }]);
  vfs.addFile('/root/.git/config', '[core]\n');

  vfs.addDir('/root/node_modules', [{ name: 'pkg', type: 'directory' }]);
  vfs.addDir('/root/node_modules/pkg', [{ name: 'index.js', type: 'file' }]);
  vfs.addFile('/root/node_modules/pkg/index.js', 'module.exports = {}\n');

  vfs.addDir('/root/sub', [
    { name: 'file3.ts', type: 'file' },
    { name: 'file4.js', type: 'file' },
    { name: 'deep', type: 'directory' },
  ]);
  vfs.addFile('/root/sub/file3.ts', 'export const c = 3;\n');
  vfs.addFile('/root/sub/file4.js', 'const d = 4;\n');

  vfs.addDir('/root/sub/deep', [{ name: 'file5.ts', type: 'file' }]);
  vfs.addFile('/root/sub/deep/file5.ts', 'export const e = 5;\n');
}

describe('DirectoryLister', () => {
  let vfs: VirtualFileSystem;
  let lister: ReturnType<typeof createLister>;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    buildTree(vfs);
    lister = createLister(vfs);
  });

  describe('successful listings', () => {
    it('should list a directory without recursion', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.kind).toBe('list');
      expect(result.completed).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.truncated).toBe(false);
      const names = result.entries.map(e => e.name).sort();
      expect(names).toContain('file1.ts');
      expect(names).toContain('file2.js');
      expect(names).toContain('sub');
      // excluded by ignore/sensitive rules
      expect(names).not.toContain('.env');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.git');
    });

    it('should list recursively', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxDepth: 10,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      const relPaths = result.entries.map(e => e.relativePath);
      expect(relPaths).toContain('file1.ts');
      expect(relPaths).toContain('sub/file3.ts');
      expect(relPaths).toContain('sub/file4.js');
      expect(relPaths).toContain('sub/deep/file5.ts');
      expect(relPaths).not.toContain('node_modules/pkg/index.js');
      expect(relPaths).not.toContain('.env');
    });

    it('should respect maximum depth', async () => {
      const depth0 = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxDepth: 0,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      // Only direct entries of /root (no nested paths).
      expect(depth0.entries.every(e => !e.relativePath.includes('/'))).toBe(true);

      const depth1 = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxDepth: 1,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(depth1.entries.some(e => e.relativePath === 'sub/file3.ts')).toBe(true);
      expect(depth1.entries.some(e => e.relativePath === 'sub/deep/file5.ts')).toBe(false);
    });

    it('should respect maximum entry count and report truncation', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxEntries: 2,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.count).toBeLessThanOrEqual(2);
      expect(result.truncated).toBe(true);
    });

    it('should respect ignore rules', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.some(e => e.relativePath.startsWith('node_modules/'))).toBe(false);
      expect(result.entries.some(e => e.relativePath.startsWith('.git/'))).toBe(false);
    });

    it('should exclude sensitive files (.env, keys, certificates)', async () => {
      vfs.addFile('/root/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\n');
      vfs.addFile('/root/cert.pem', '-----BEGIN CERTIFICATE-----\n');
      vfs.addFile('/root/config.crt', 'cert data\n');
      vfs.addDirEntry('/root', 'id_rsa', 'file');
      vfs.addDirEntry('/root', 'cert.pem', 'file');
      vfs.addDirEntry('/root', 'config.crt', 'file');

      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      const names = result.entries.map(e => e.name);
      expect(names).not.toContain('.env');
      expect(names).not.toContain('id_rsa');
      expect(names).not.toContain('cert.pem');
      expect(names).not.toContain('config.crt');
      expect(result.entries.some(e => e.isSensitive)).toBe(false);
    });

    it('should skip symbolic links to files', async () => {
      vfs.addDirEntry('/root', 'link.ts', 'symbolicLink');
      vfs.stats.set('/root/link.ts', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.some(e => e.name === 'link.ts')).toBe(false);
    });

    it('should not traverse into symlinked directories', async () => {
      vfs.addDirEntry('/root', 'escape', 'symbolicLink');
      vfs.stats.set('/root/escape', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      // Populate the symlink target so a traversal-following impl would descend into it.
      vfs.addDir('/escape', [{ name: 'secret.txt', type: 'file' }]);
      vfs.addFile('/escape/secret.txt', 'classified\n');

      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxDepth: 10,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      // The symlinked directory itself is not listed, and its target is not traversed.
      expect(result.entries.some(e => e.name === 'escape')).toBe(false);
      expect(result.entries.some(e => e.relativePath === 'escape/secret.txt')).toBe(false);
      expect(result.entries.some(e => e.name === 'secret.txt')).toBe(false);
    });

    it('should skip symlinks encountered during recursive listing', async () => {
      vfs.addDirEntry('/root/sub', 'link-out', 'symbolicLink');
      vfs.stats.set('/root/sub/link-out', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        maxDepth: 10,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.some(e => e.relativePath === 'sub/link-out')).toBe(false);
      // Real nested files are still listed.
      expect(result.entries.some(e => e.relativePath === 'sub/deep/file5.ts')).toBe(true);
    });

    it('should ignore followSymlinks in config (symlinks never enabled)', async () => {
      vfs.addDirEntry('/root', 'link.ts', 'symbolicLink');
      vfs.stats.set('/root/link.ts', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      const strictLister = createDirectoryLister({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        config: { followSymlinks: true } as unknown as Partial<DirectoryListConfig>,
      });
      const result = await strictLister.listDirectory({
        uri: makeUri('/root'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.some(e => e.name === 'link.ts')).toBe(false);
    });

    it('should filter files only', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        filterByType: 'file',
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.every(e => e.type === 'file')).toBe(true);
      expect(result.entries.some(e => e.type === 'directory')).toBe(false);
    });

    it('should filter directories only', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        filterByType: 'directory',
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.every(e => e.type === 'directory')).toBe(true);
    });

    it('should handle an empty directory', async () => {
      vfs.addDir('/root/emptydir');
      const result = await lister.listDirectory({
        uri: makeUri('/root/emptydir'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.completed).toBe(true);
    });

    it('should return deterministic sorted ordering', async () => {
      const scratch = new VirtualFileSystem();
      scratch.addDir('/root', [
        { name: 'zebra.ts', type: 'file' },
        { name: 'alpha.ts', type: 'file' },
        { name: 'mid.ts', type: 'file' },
      ]);
      scratch.addFile('/root/zebra.ts', 'z\n');
      scratch.addFile('/root/alpha.ts', 'a\n');
      scratch.addFile('/root/mid.ts', 'm\n');
      const sLister = createLister(scratch);
      const result = await sLister.listDirectory({
        uri: makeUri('/root'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      const names = result.entries.map(e => e.name);
      expect(names).toEqual(['alpha.ts', 'mid.ts', 'zebra.ts']);
    });

    it('should include metadata such as language and category', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      const tsFile = result.entries.find(e => e.name === 'file1.ts');
      expect(tsFile).toBeDefined();
      expect(tsFile!.language).toBe('typescript');
      expect(tsFile!.category).toBe('source');
      expect(tsFile!.size).toBeGreaterThan(0);
    });

    it('should support include patterns', async () => {
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        includePatterns: ['*.ts'],
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.entries.every(e => e.name.endsWith('.ts') || e.type === 'directory')).toBe(
        true
      );
      expect(result.entries.some(e => e.name === 'file2.js')).toBe(false);
      expect(result.entries.some(e => e.name === 'file3.ts')).toBe(true);
    });
  });

  describe('boundary and traversal security', () => {
    it('should reject paths outside the workspace root', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/other'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should reject path traversal with ..', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root/../../etc'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should reject traversal via parent segment', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root/../outside'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should reject non-directories', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root/file1.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_NOT_A_DIRECTORY
      );
    });

    it('should handle missing directories', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root/does-not-exist'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_NOT_FOUND
      );
    });

    it('should support remote-style URIs through the abstraction', async () => {
      const remote = new VirtualFileSystem();
      remote.addDir('ssh://host/root', [{ name: 'file.ts', type: 'file' }]);
      remote.addFile('ssh://host/root/file.ts', 'remote\n');
      const remoteLister = createDirectoryLister({
        fileSystem: remote,
        workspaceFolder: makeWorkspaceFolder('ssh://host/root', 'root'),
      });
      const result = await remoteLister.listDirectory({
        uri: 'ssh://host/root',
        workspaceFolder: makeWorkspaceFolder('ssh://host/root', 'root'),
      });
      expect(result.entries.some(e => e.name === 'file.ts')).toBe(true);
    });

    it('should support Windows-style paths', async () => {
      const win = new VirtualFileSystem();
      win.addDir('C:/root', [{ name: 'file.ts', type: 'file' }]);
      win.addFile('C:/root/file.ts', 'win\n');
      const winLister = createDirectoryLister({
        fileSystem: win,
        workspaceFolder: makeWorkspaceFolder('C:/root', 'root'),
      });
      const result = await winLister.listDirectory({
        uri: 'C:/root',
        workspaceFolder: makeWorkspaceFolder('C:/root', 'root'),
      });
      expect(result.entries.some(e => e.name === 'file.ts')).toBe(true);
    });
  });

  describe('errors and cancellation', () => {
    it('should isolate inaccessible subdirectories without crashing', async () => {
      vfs.failReaddir('/root/sub');
      const result = await lister.listDirectory({
        uri: makeUri('/root'),
        recursive: true,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      // Should complete with errors recorded, not throw.
      expect(result.completed).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
      // Top-level files still listed.
      expect(result.entries.some(e => e.name === 'file1.ts')).toBe(true);
    });

    it('should honor cancellation before listing', async () => {
      const controller = new AbortController();
      controller.abort();
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          signal: controller.signal,
        }),
        ToolErrorCode.TOOL_CANCELLED
      );
    });

    it('should validate invalid arguments', async () => {
      await expectToolError(
        lister.listDirectory({
          uri: '',
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_INVALID_ARGUMENT
      );
    });

    it('should reject a directory symlink pointing outside the workspace', async () => {
      vfs.stats.set('/root/escape', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root/escape'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });

    it('should fail closed when lstat cannot determine symlink status', async () => {
      vfs.failLstat('/root');
      await expectToolError(
        lister.listDirectory({
          uri: makeUri('/root'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILESYSTEM_ERROR
      );
    });

    it('should reject symlink even when stat reports the target as a directory', async () => {
      // lstat identifies the link; stat follows and reports the target. The
      // lister must rely on lstat and reject regardless of what stat says.
      const fs: FileSystemProvider = {
        readDirectory: async () => [],
        stat: async () => ({
          type: 'directory' as const,
          size: 0,
          mtime: Date.now(),
          ctime: Date.now(),
        }),
        lstat: async () => ({
          type: 'symbolicLink' as const,
          size: 0,
          mtime: Date.now(),
          ctime: Date.now(),
        }),
        readFile: async () => '',
        exists: async () => true,
      };
      const symlinkLister = createDirectoryLister({
        fileSystem: fs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      await expectToolError(
        symlinkLister.listDirectory({
          uri: makeUri('/root/link'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });
  });
});
