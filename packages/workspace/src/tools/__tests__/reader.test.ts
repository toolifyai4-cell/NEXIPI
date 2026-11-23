import { describe, it, expect, beforeEach } from 'vitest';
import {
  FileReader,
  createFileReader,
  ToolErrorCode,
  ToolError,
  type FileReadConfig,
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

  private key(p: string): string {
    return p
      .replace(/^file:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
  }

  addFile(p: string, content: string): void {
    const k = this.key(p);
    this.files.set(k, content);
    this.stats.set(k, {
      type: 'file',
      size: content.length,
      mtime: Date.now(),
      ctime: Date.now(),
    });
    this.ensureDir(k);
  }

  addDir(p: string, entries: DirectoryEntry[] = []): void {
    const k = this.key(p);
    this.ensureDir(k);
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

  private ensureDir(filePath: string): void {
    const parts = filePath.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/';
      if (!this.dirs.has(dir)) {
        this.dirs.set(dir, []);
      }
      if (!this.stats.has(dir)) {
        this.stats.set(dir, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
      }
    }
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const k = this.key(uri);
    if (this.failingStat.has(k)) {
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

function createReader(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Partial<FileReadConfig>
) {
  return createFileReader({
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

describe('FileReader', () => {
  let vfs: VirtualFileSystem;
  let reader: FileReader;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    reader = createReader(vfs);
  });

  describe('successful reads', () => {
    it('should read a normal text file', async () => {
      vfs.addFile('/root/hello.ts', 'console.log("hi");\n');
      const result = await reader.readFile({
        uri: makeUri('/root/hello.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.kind).toBe('read');
      expect(result.content).toBe('console.log("hi");\n');
      expect(result.size).toBe('console.log("hi");\n'.length);
      expect(result.lineCount).toBe(1);
      expect(result.binary).toBe(false);
      expect(result.encoding).toBe('utf-8');
      expect(result.cancelled).toBe(false);
      expect(result.truncated).toBe(false);
    });

    it('should read an empty file', async () => {
      vfs.addFile('/root/empty.ts', '');
      const result = await reader.readFile({
        uri: makeUri('/root/empty.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('');
      expect(result.lineCount).toBe(0);
      expect(result.returnedLineCount).toBe(0);
      expect(result.firstLine).toBeNull();
      expect(result.lastLine).toBeNull();
      expect(result.size).toBe(0);
    });

    it('should handle LF line endings with accurate line numbers', async () => {
      vfs.addFile('/root/lf.ts', 'line1\nline2\nline3\n');
      const result = await reader.readFile({
        uri: makeUri('/root/lf.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.lineCount).toBe(3);
      expect(result.content).toBe('line1\nline2\nline3\n');
    });

    it('should handle CRLF line endings with accurate line numbers', async () => {
      vfs.addFile('/root/crlf.ts', 'line1\r\nline2\r\nline3\r\n');
      const result = await reader.readFile({
        uri: makeUri('/root/crlf.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.lineCount).toBe(3);
      expect(result.content).toBe('line1\r\nline2\r\nline3\r\n');
    });

    it('should handle a final line without a trailing newline', async () => {
      vfs.addFile('/root/notrail.ts', 'line1\nline2\nline3');
      const result = await reader.readFile({
        uri: makeUri('/root/notrail.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.lineCount).toBe(3);
      expect(result.content).toBe('line1\nline2\nline3');
    });

    it('should read a valid inclusive one-based line range', async () => {
      vfs.addFile('/root/range.ts', 'a\nb\nc\nd\n');
      const result = await reader.readFile({
        uri: makeUri('/root/range.ts'),
        lineStart: 2,
        lineEnd: 3,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('b\nc\n');
      expect(result.firstLine).toBe(2);
      expect(result.lastLine).toBe(3);
      expect(result.returnedLineCount).toBe(2);
      expect(result.lineCount).toBe(4);
    });

    it('should read from line 1 when lineStart is omitted', async () => {
      vfs.addFile('/root/range.ts', 'a\nb\nc\n');
      const result = await reader.readFile({
        uri: makeUri('/root/range.ts'),
        lineEnd: 2,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('a\nb\n');
      expect(result.firstLine).toBe(1);
      expect(result.lastLine).toBe(2);
    });

    it('should read to the last line when lineEnd is omitted', async () => {
      vfs.addFile('/root/range.ts', 'a\nb\nc\n');
      const result = await reader.readFile({
        uri: makeUri('/root/range.ts'),
        lineStart: 2,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('b\nc\n');
      expect(result.firstLine).toBe(2);
      expect(result.lastLine).toBe(3);
    });

    it('should accept scheme-stripped absolute paths', async () => {
      vfs.addFile('/root/plain.ts', 'plain\n');
      const result = await reader.readFile({
        uri: '/root/plain.ts',
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('plain\n');
    });
  });

  describe('line range validation', () => {
    it('should reject a lineStart below 1', async () => {
      vfs.addFile('/root/x.ts', 'a\n');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/x.ts'),
          lineStart: 0,
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_INVALID_ARGUMENT
      );
    });

    it('should reject a reversed line range', async () => {
      vfs.addFile('/root/x.ts', 'a\nb\n');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/x.ts'),
          lineStart: 3,
          lineEnd: 2,
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_INVALID_ARGUMENT
      );
    });
  });

  describe('ranges beyond the file', () => {
    it('should return empty content when start is beyond the file', async () => {
      vfs.addFile('/root/x.ts', 'a\nb\n');
      const result = await reader.readFile({
        uri: makeUri('/root/x.ts'),
        lineStart: 10,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('');
      expect(result.returnedLineCount).toBe(0);
      expect(result.firstLine).toBeNull();
      expect(result.lastLine).toBeNull();
      expect(result.lineCount).toBe(2);
    });

    it('should clamp end beyond the file to the last line', async () => {
      vfs.addFile('/root/x.ts', 'a\nb\nc\n');
      const result = await reader.readFile({
        uri: makeUri('/root/x.ts'),
        lineStart: 2,
        lineEnd: 100,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('b\nc\n');
      expect(result.firstLine).toBe(2);
      expect(result.lastLine).toBe(3);
      expect(result.returnedLineCount).toBe(2);
    });
  });

  describe('size limits', () => {
    it('should reject files exceeding the configured max file size', async () => {
      const big = 'x'.repeat(2 * 1024 * 1024);
      vfs.addFile('/root/big.ts', big);
      const smallReader = createReader(vfs, 'file:///root', { maxFileSize: 1024 * 1024 });
      await expectToolError(
        smallReader.readFile({
          uri: makeUri('/root/big.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_TOO_LARGE
      );
    });

    it('should truncate content exceeding the max output size', async () => {
      vfs.addFile('/root/long.ts', 'hello world\n');
      const limitedReader = createReader(vfs, 'file:///root', { maxOutputSize: 5 });
      const result = await limitedReader.readFile({
        uri: makeUri('/root/long.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(5);
      expect(result.lineCount).toBe(1);
    });
  });

  describe('binary handling', () => {
    it('should reject binary content detected by null byte', async () => {
      vfs.addFile('/root/bin.dat', 'text\x00more');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/bin.dat'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_BINARY
      );
    });

    it('should reject a binary extension even without null bytes', async () => {
      vfs.addFile('/root/image.png', 'fake-png');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/image.png'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_BINARY
      );
    });
  });

  describe('sensitive and ignored files', () => {
    it('should reject sensitive files', async () => {
      vfs.addFile('/root/.env', 'SECRET=1');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/.env'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_SENSITIVE
      );
    });

    it('should reject ignored files (default exclusions)', async () => {
      vfs.addFile('/root/node_modules/pkg/index.js', 'module.exports = {};');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/node_modules/pkg/index.js'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_IGNORED
      );
    });

    it('should reject files under .git (mandatory safety exclusion)', async () => {
      vfs.addFile('/root/.git/config', '[core]\n');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/.git/config'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_IGNORED
      );
    });
  });

  describe('workspace boundaries', () => {
    it('should reject path traversal with ..', async () => {
      vfs.addFile('/etc/passwd', 'root:x:0:0:');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/../../etc/passwd'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should reject traversal via parent segment', async () => {
      vfs.addFile('/outside.ts', 'x');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/../outside.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should reject absolute paths outside the workspace root', async () => {
      vfs.addFile('/other/secret.ts', 'x');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/other/secret.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE
      );
    });

    it('should allow reading the workspace root file', async () => {
      vfs.addFile('/root/allowed.ts', 'ok\n');
      const result = await reader.readFile({
        uri: makeUri('/root/allowed.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('ok\n');
    });
  });

  describe('symlink boundary enforcement', () => {
    it('should read a normal nested file', async () => {
      vfs.addFile('/root/sub/nested.ts', 'nested\n');
      const result = await reader.readFile({
        uri: makeUri('/root/sub/nested.ts'),
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(result.content).toBe('nested\n');
    });

    it('should reject a direct file symlink pointing outside the workspace', async () => {
      vfs.addFile('/root/real.ts', 'real\n');
      vfs.stats.set('/root/link.ts', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/link.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });

    it('should reject a file beneath a symlinked parent directory', async () => {
      vfs.addFile('/root/linked-dir/secret.txt', 'classified\n');
      vfs.stats.set('/root/linked-dir', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/linked-dir/secret.txt'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });

    it('should reject a file beneath nested parents where one component is a symlink', async () => {
      vfs.addFile('/root/a/b/link/c.txt', 'classified\n');
      vfs.stats.set('/root/a/b/link', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/a/b/link/c.txt'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });

    it('should fail closed when an intermediate component cannot be verified', async () => {
      vfs.addFile('/root/a/b/file.txt', 'x\n');
      vfs.failLstat('/root/a');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/a/b/file.txt'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILESYSTEM_ERROR
      );
    });

    it('should reject a symlinked workspace root', async () => {
      vfs.stats.set('/root', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      vfs.addFile('/root/file.txt', 'x\n');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/file.txt'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });
  });

  describe('errors', () => {
    it('should handle missing files', async () => {
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/missing.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILE_NOT_FOUND
      );
    });

    it('should reject directories supplied as file paths', async () => {
      vfs.addDir('/root/sub');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/sub'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_NOT_A_FILE
      );
    });

    it('should reject symbolic links regardless of configuration', async () => {
      vfs.addFile('/root/real.ts', 'real\n');
      vfs.addDir('/root', [{ name: 'link.ts', type: 'symbolicLink' }]);
      vfs.stats.set('/root/link.ts', {
        type: 'symbolicLink',
        size: 0,
        mtime: Date.now(),
        ctime: Date.now(),
      });
      // Default config: symlinks are rejected.
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/link.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
      // Attempting to enable symlink following via config must not enable it:
      // followSymlinks is no longer a supported config option and is ignored.
      const strictReader = createFileReader({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        config: { followSymlinks: true } as unknown as Partial<FileReadConfig>,
      });
      await expectToolError(
        strictReader.readFile({
          uri: makeUri('/root/link.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });

    it('should handle filesystem errors on read', async () => {
      vfs.addFile('/root/perm.ts', 'secret');
      vfs.failRead('/root/perm.ts');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/perm.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILESYSTEM_ERROR
      );
    });

    it('should honor cancellation before the read', async () => {
      const controller = new AbortController();
      controller.abort();
      vfs.addFile('/root/x.ts', 'a\n');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/x.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          signal: controller.signal,
        }),
        ToolErrorCode.TOOL_CANCELLED
      );
    });

    it('should fail closed when lstat cannot determine symlink status', async () => {
      vfs.addFile('/root/secret.ts', 'secret\n');
      vfs.failLstat('/root/secret.ts');
      await expectToolError(
        reader.readFile({
          uri: makeUri('/root/secret.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_FILESYSTEM_ERROR
      );
    });

    it('should reject symlink even when stat reports the target as a file', async () => {
      // lstat identifies the link; stat follows and reports the target. The
      // reader must rely on lstat and reject regardless of what stat says.
      const fs: FileSystemProvider = {
        readDirectory: async () => [],
        stat: async () => ({
          type: 'file' as const,
          size: 5,
          mtime: Date.now(),
          ctime: Date.now(),
        }),
        lstat: async () => ({
          type: 'symbolicLink' as const,
          size: 0,
          mtime: Date.now(),
          ctime: Date.now(),
        }),
        readFile: async () => 'outside\n',
        exists: async () => true,
      };
      const symlinkReader = createFileReader({
        fileSystem: fs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      await expectToolError(
        symlinkReader.readFile({
          uri: makeUri('/root/link.ts'),
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        }),
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED
      );
    });
  });
});
