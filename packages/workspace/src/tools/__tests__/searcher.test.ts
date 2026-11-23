import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CodeSearcher,
  createCodeSearcher,
  ToolErrorCode,
  ToolError,
  type CodeSearchConfig,
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
  private readDelayMs = 0;

  private key(p: string): string {
    return p
      .replace(/^file:\/\//i, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
  }

  setReadDelay(ms: number): void {
    this.readDelayMs = ms;
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
    const parts = k.split('/');
    const name = parts.pop()!;
    const parentDir = parts.join('/') || '/';
    if (!this.dirs.has(parentDir)) {
      this.dirs.set(parentDir, []);
    }
    const entries = this.dirs.get(parentDir)!;
    if (!entries.some(e => e.name === name && e.type === 'file')) {
      entries.push({ name, type: 'file' });
    }
  }

  addSymlink(p: string): void {
    const k = this.key(p);
    this.stats.set(k, {
      type: 'symbolicLink',
      size: 0,
      mtime: Date.now(),
      ctime: Date.now(),
    });
  }

  addDir(p: string, entries: DirectoryEntry[] = []): void {
    const k = this.key(p);
    this.ensureDir(k);
    this.stats.set(k, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
    this.dirs.set(k, [...entries]);
  }

  addDirEntry(dirPath: string, name: string, type: DirectoryEntry['type']): void {
    const k = this.key(dirPath);
    if (!this.dirs.has(k)) {
      this.dirs.set(k, []);
    }
    const entries = this.dirs.get(k)!;
    if (!entries.some(e => e.name === name)) {
      entries.push({ name, type });
    }
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
    const base = this.dirs.get(k);
    if (base === undefined) {
      throw new Error(`ENOENT: no such directory, readDirectory '${uri}'`);
    }
    return [...base];
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
    const k = this.key(uri);
    const s = this.stats.get(k);
    if (!s) {
      throw new Error(`ENOENT: no such file or directory, lstat '${uri}'`);
    }
    return { ...s };
  }

  async readFile(uri: string): Promise<string> {
    if (this.readDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.readDelayMs));
    }
    const k = this.key(uri);
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

function createSearcher(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Partial<CodeSearchConfig>
) {
  return createCodeSearcher({
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
  vfs.addFile('/root/a.txt', 'hello world\nhello again\n');
  vfs.addFile('/root/b.txt', 'Hello World\nHELLO\n');
  vfs.addFile('/root/c.ts', 'const x = 1;\nconst y = 2;\n');
  vfs.addFile('/root/sub/d.txt', 'nested hello\n');
  vfs.addFile('/root/ignored.ts', 'should not match\n');
  vfs.addDir('/root/.git', [{ name: 'config', type: 'file' }]);
  vfs.addFile('/root/.git/config', '[core]\n');
  vfs.addDir('/root/node_modules', [{ name: 'pkg', type: 'directory' }]);
  vfs.addFile('/root/node_modules/pkg/index.js', 'module.exports = {}\n');
  vfs.addFile('/root/.env', 'SECRET=1\n');
  vfs.addFile('/root/id_rsa', 'private key\n');
  vfs.addFile('/root/data.bin', '\x00\x01\x02binary');
}

describe('CodeSearcher', () => {
  let vfs: VirtualFileSystem;
  let searcher: CodeSearcher;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    buildTree(vfs);
    searcher = createSearcher(vfs);
  });

  describe('literal search', () => {
    it('should perform a basic literal match', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.kind).toBe('search');
      expect(result.mode).toBe('literal');
      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.cancelled).toBe(false);
      expect(result.completed).toBe(true);
    });

    it('should match across multiple files', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      const filesWithMatches = result.files.filter(f => f.matchCount > 0);
      expect(filesWithMatches.length).toBeGreaterThan(1);
    });

    it('should be case-sensitive', async () => {
      const sensitive = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'Hello',
        mode: 'literal',
        caseSensitive: true,
      });
      const insensitive = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'Hello',
        mode: 'literal',
        caseSensitive: false,
      });
      expect(insensitive.totalMatches).toBeGreaterThanOrEqual(sensitive.totalMatches);
    });

    it('should support case-insensitive matching', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'HELLO',
        mode: 'literal',
        caseSensitive: false,
      });
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should support whole-word matching', async () => {
      const whole = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
        wholeWord: true,
      });
      const notWhole = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'ell',
        mode: 'literal',
        wholeWord: true,
      });
      expect(notWhole.totalMatches).toBe(0);
      expect(whole.totalMatches).toBeGreaterThan(0);
    });

    it('should find multiple matches on one line', async () => {
      vfs.addFile('/root/multi.txt', 'hello hello hello\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      const multiFile = result.files.find(f => f.relativePath === 'multi.txt');
      expect(multiFile).toBeDefined();
      expect(multiFile!.matchCount).toBe(3);
    });

    it('should include context lines around matches', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'again',
        mode: 'literal',
        contextLines: 1,
      });
      const aFile = result.files.find(f => f.relativePath === 'a.txt');
      expect(aFile).toBeDefined();
      const match = aFile!.matches.find(m => m.matchedText === 'again');
      expect(match).toBeDefined();
      expect(match!.context).toBeDefined();
      expect(match!.context!.length).toBeGreaterThan(0);
    });

    it('should reject an empty query', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: '',
          mode: 'literal',
        }),
        ToolErrorCode.TOOL_INVALID_ARGUMENT
      );
    });

    it('should handle unicode text', async () => {
      vfs.addFile('/root/unicode.txt', 'héllo wörld\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'héllo',
        mode: 'literal',
      });
      expect(result.totalMatches).toBe(1);
    });

    it('should return deterministic ordering', async () => {
      const r1 = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'const',
        mode: 'literal',
      });
      const r2 = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'const',
        mode: 'literal',
      });
      const order1 = r1.files.map(f => f.relativePath);
      const order2 = r2.files.map(f => f.relativePath);
      expect(order1).toEqual(order2);
      expect(order1).toEqual([...order1].sort());
    });

    it('should treat query as literal text, not regex', async () => {
      vfs.addFile('/root/regex.txt', 'a.b\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'a.b',
        mode: 'literal',
      });
      expect(result.totalMatches).toBe(1);
      const match = result.files.find(f => f.relativePath === 'regex.txt')!.matches[0];
      expect(match.matchedText).toBe('a.b');
    });
  });

  describe('regex search', () => {
    it('should support basic regex match', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'regex',
      });
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should support character classes', async () => {
      vfs.addFile('/root/re1.txt', 'cat\nbat\nrat\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: '[cr]at',
        mode: 'regex',
      });
      expect(result.totalMatches).toBe(2);
    });

    it('should support alternation', async () => {
      vfs.addFile('/root/re2.txt', 'foo bar baz\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'foo|baz',
        mode: 'regex',
      });
      expect(result.totalMatches).toBe(2);
    });

    it('should support grouping', async () => {
      vfs.addFile('/root/re3.txt', 'abc abc\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: '(abc)',
        mode: 'regex',
      });
      expect(result.totalMatches).toBe(2);
    });

    it('should support repetition', async () => {
      vfs.addFile('/root/re4.txt', 'ab\nabb\nabbb\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'ab+',
        mode: 'regex',
      });
      expect(result.totalMatches).toBe(3);
    });

    it('should support word boundary', async () => {
      vfs.addFile('/root/re5.txt', 'cat concatenate\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: '\\bcat\\b',
        mode: 'regex',
      });
      expect(result.totalMatches).toBe(1);
    });

    it('should reject invalid regex syntax', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: '(',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_INVALID_REGEX
      );
    });

    it('should reject unsupported lookarounds', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: 'a(?=b)',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should reject backreferences', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: '(a)\\1',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should reject lazy quantifiers', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: 'a*?',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should reject bounded repetition', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: 'a{2,4}',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should reject over-long patterns', async () => {
      const long = 'a'.repeat(600);
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: long,
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should enforce query length limits', async () => {
      const long = 'x'.repeat(2000);
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: long,
          mode: 'literal',
        }),
        ToolErrorCode.TOOL_QUERY_TOO_LONG
      );
    });

    it('should not freeze on adversarial nested repetition', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: '(a+)+$',
          mode: 'regex',
        }),
        ToolErrorCode.TOOL_UNSUPPORTED_REGEX
      );
    });

    it('should safely execute a supported quantifier in linear time', async () => {
      const start = Date.now();
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'a*',
        mode: 'regex',
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
      expect(result.completed).toBe(true);
    });
  });

  describe('security', () => {
    it('should exclude ignored files (default exclusions)', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'module.exports',
        mode: 'literal',
      });
      expect(result.files.some(f => f.relativePath === 'node_modules/pkg/index.js')).toBe(false);
      expect(result.totalMatches).toBe(0);
    });

    it('should exclude .git (mandatory safety exclusion)', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'core',
        mode: 'literal',
      });
      expect(result.files.some(f => f.relativePath === '.git/config')).toBe(false);
      expect(result.totalMatches).toBe(0);
    });

    it('should exclude sensitive files (.env)', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'SECRET',
        mode: 'literal',
      });
      expect(result.files.some(f => f.relativePath === '.env')).toBe(false);
      expect(result.totalMatches).toBe(0);
    });

    it('should exclude sensitive key files', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'private',
        mode: 'literal',
      });
      const key = result.files.find(f => f.relativePath === 'id_rsa');
      expect(key).toBeDefined();
      expect(key!.skipped).toBe(true);
      expect(key!.skipReason).toBe('sensitive');
    });

    it('should exclude binary files', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'binary',
        mode: 'literal',
      });
      const bin = result.files.find(f => f.relativePath === 'data.bin');
      expect(bin).toBeDefined();
      expect(bin!.skipped).toBe(true);
      expect(bin!.skipReason).toBe('binary');
    });

    it('should skip oversized files', async () => {
      const big = 'x'.repeat(2 * 1024 * 1024);
      vfs.addFile('/root/big.txt', big);
      const limited = createSearcher(vfs, 'file:///root', { maxFileSize: 1024 * 1024 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'x',
        mode: 'literal',
      });
      const bigFile = result.files.find(f => f.relativePath === 'big.txt');
      expect(bigFile).toBeDefined();
      expect(bigFile!.skipped).toBe(true);
      expect(bigFile!.skipReason).toBe('tooLarge');
    });

    it('should not search symlinked files', async () => {
      vfs.addFile('/root/real.txt', 'real content\n');
      vfs.addSymlink('/root/link.txt');
      vfs.addDirEntry('/root', 'link.txt', 'symbolicLink');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'real',
        mode: 'literal',
      });
      const link = result.files.find(f => f.relativePath === 'link.txt');
      expect(link).toBeUndefined();
    });

    it('should not access files beneath symlinked ancestors', async () => {
      vfs.addSymlink('/root/linked-dir');
      vfs.addDirEntry('/root', 'linked-dir', 'symbolicLink');
      vfs.addFile('/root/linked-dir/secret.txt', 'classified\n');
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'classified',
        mode: 'literal',
      });
      const secret = result.files.find(f => f.relativePath === 'linked-dir/secret.txt');
      expect(secret).toBeUndefined();
    });

    it('should not log file contents', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.totalMatches).toBeGreaterThan(0);
      const logged = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(logged).not.toContain('hello world');
      logSpy.mockRestore();
    });
  });

  describe('resource limits', () => {
    it('should enforce candidate-file limit and report truncation', async () => {
      for (let i = 0; i < 15; i++) {
        vfs.addFile(`/root/file${i}.txt`, `hello ${i}\n`);
      }
      const limited = createSearcher(vfs, 'file:///root', { maxCandidateFiles: 10 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.truncated).toBe(true);
      expect(result.limitReached).toBe('maxCandidateFiles');
    });

    it('should enforce total bytes-read limit', async () => {
      const limited = createSearcher(vfs, 'file:///root', { maxTotalBytesRead: 50 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.truncated).toBe(true);
      expect(result.limitReached).toBe('maxTotalBytesRead');
    });

    it('should enforce per-file match limit', async () => {
      vfs.addFile('/root/many.txt', 'hello\n'.repeat(200));
      const limited = createSearcher(vfs, 'file:///root', { maxMatchesPerFile: 5 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      const many = result.files.find(f => f.relativePath === 'many.txt');
      expect(many!.matchCount).toBe(5);
      expect(many!.truncated).toBe(true);
    });

    it('should enforce total result limit', async () => {
      const limited = createSearcher(vfs, 'file:///root', { maxTotalResults: 3 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.truncated).toBe(true);
      expect(result.limitReached).toBe('maxTotalResults');
      expect(result.totalMatches).toBeGreaterThanOrEqual(3);
    });

    it('should truncate long lines', async () => {
      const longLine = 'a'.repeat(20000) + ' hello\n';
      vfs.addFile('/root/longline.txt', longLine);
      const limited = createSearcher(vfs, 'file:///root', { maxLineLength: 1000 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.completed).toBe(true);
    });

    it('should enforce context line limit', async () => {
      const limited = createSearcher(vfs, 'file:///root', { maxContextLines: 2 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'again',
        mode: 'literal',
        contextLines: 100,
      });
      const aFile = result.files.find(f => f.relativePath === 'a.txt');
      const match = aFile!.matches.find(m => m.matchedText === 'again');
      expect(match!.context!.length).toBeLessThanOrEqual(4);
    });

    it('should enforce output size limit and report truncation', async () => {
      const limited = createSearcher(vfs, 'file:///root', { maxOutputSize: 50 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.truncated).toBe(true);
      expect(result.limitReached).toBe('maxOutputSize');
    });

    it('should include correct truncation metadata', async () => {
      const limited = createSearcher(vfs, 'file:///root', { maxTotalResults: 2 });
      const result = await limited.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.truncated).toBe(true);
      expect(result.limitReached).toBe('maxTotalResults');
      expect(typeof result.cancelled).toBe('boolean');
      expect(typeof result.completed).toBe('boolean');
    });
  });

  describe('cancellation', () => {
    it('should cancel before execution', async () => {
      const controller = new AbortController();
      controller.abort();
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
          query: 'hello',
          mode: 'literal',
          signal: controller.signal,
        }),
        ToolErrorCode.TOOL_CANCELLED
      );
    });

    it('should report cancellation between files as not completed', async () => {
      for (let i = 0; i < 40; i++) {
        vfs.addFile(`/root/cancel${i}.txt`, `hello ${i}\n`);
      }
      vfs.setReadDelay(2);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
        signal: controller.signal,
      });
      expect(result.cancelled).toBe(true);
      expect(result.completed).toBe(false);
    });
  });

  describe('errors', () => {
    it('should complete successfully on a normal search', async () => {
      const result = await searcher.search({
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        query: 'hello',
        mode: 'literal',
      });
      expect(result.completed).toBe(true);
      expect(result.cancelled).toBe(false);
    });

    it('should validate invalid arguments', async () => {
      await expectToolError(
        searcher.search({
          workspaceFolder: makeWorkspaceFolder('', 'root'),
          query: 'hello',
          mode: 'literal',
        } as any),
        ToolErrorCode.TOOL_INVALID_ARGUMENT
      );
    });
  });
});
