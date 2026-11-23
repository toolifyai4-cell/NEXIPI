import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LexicalFinder,
  createLexicalFinder,
  type LexicalFinderOptions,
} from '../lexical-finder.js';
import { ToolErrorCode, type ToolError } from '../errors.js';
import type { FileSystemProvider, DirectoryEntry, FileStat } from '../../discovery/workspace-provider.js';
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
  public readDelayMs = 0;

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
      size: Buffer.byteLength(content, 'utf8'),
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
    const parts = k.split('/');
    const name = parts.pop()!;
    const parentDir = parts.join('/') || '/';
    if (!this.dirs.has(parentDir)) {
      this.dirs.set(parentDir, []);
    }
    const entries = this.dirs.get(parentDir)!;
    if (!entries.some(e => e.name === name && e.type === 'symbolicLink')) {
      entries.push({ name, type: 'symbolicLink' });
    }
  }

  addDir(p: string, entries: DirectoryEntry[] = []): void {
    const k = this.key(p);
    this.ensureDir(k);
    this.stats.set(k, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
    this.dirs.set(k, [...entries]);
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const k = this.key(uri);
    const base = this.dirs.get(k);
    if (base === undefined) {
      throw new Error(`ENOENT: no such directory, readDirectory '${uri}'`);
    }
    return [...base];
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

function createFinder(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Parameters<typeof createLexicalFinder>[0]['config']
) {
  return createLexicalFinder({
    fileSystem: vfs,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    config,
  });
}

function buildTree(vfs: VirtualFileSystem): void {
  vfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\nfoobar\nfooBar\nbarfoo\n_foo\nfoo_\n');
  vfs.addFile('/root/b.ts', 'export const foo = 2;\nimport { foo } from "./x";\nfoo.bar();\n');
  vfs.addFile('/root/c.py', 'def foo():\n    return foo\nfoo_ = 1\n_foo = 2\n');
  vfs.addFile('/root/d.java', 'public class Foo { void foo() { foo(); } }\n');
  vfs.addFile('/root/e.go', 'package main\nfunc foo() {}\nfoo();\n');
  vfs.addFile('/root/sub/f.rb', 'def foo\n  puts foo\nend\n');
  vfs.addFile('/root/ignored.ts', 'should not match\n');
  vfs.addDir('/root/.git', [{ name: 'config', type: 'file' }]);
  vfs.addFile('/root/.git/config', '[core]\n');
  vfs.addDir('/root/node_modules', [{ name: 'pkg', type: 'directory' }]);
  vfs.addFile('/root/node_modules/pkg/index.js', 'module.exports = {}\n');
  vfs.addFile('/root/.env', 'SECRET=1\n');
  vfs.addFile('/root/id_rsa', 'private key\n');
  vfs.addFile('/root/data.bin', '\x00\x01\x02binary');
  vfs.addFile('/root/readme.txt', 'plain text foo\n');
}

function expectToolError(promise: Promise<unknown>, code: ToolErrorCode): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'ToolError',
    code,
  } as ToolError);
}

describe('LexicalFinder', () => {
  let vfs: VirtualFileSystem;
  let finder: ReturnType<typeof createFinder>;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    buildTree(vfs);
    finder = createFinder(vfs);
  });

  describe('identifier matching', () => {
    it('matches an exact standalone identifier', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      expect(ajs.references.length).toBeGreaterThan(0);
      expect(ajs.references[0].classification).toBe('textual_match');
      expect(ajs.references[0].confidence).toBe('low');
      expect(ajs.references[0].symbol).toBe('foo');
    });

    it('matches a function call identifier', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      const call = ajs.references.find(r => r.lineNumber === 1 && r.startColumn === 0)!;
      expect(call.matchedText).toBe('foo');
      expect(call.endColumn).toBe(3);
    });

    it('matches a variable declaration identifier', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      const decl = ajs.references.find(r => r.lineNumber === 2)!;
      expect(decl.matchedText).toBe('foo');
      // "const foo = 1;" -> foo starts at column 6
      expect(decl.startColumn).toBe(6);
    });

    it('matches a property/member identifier on both sides', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      const prop = ajs.references.find(r => r.lineNumber === 3)!; // "bar.foo"
      expect(prop.matchedText).toBe('foo');
      expect(prop.startColumn).toBe(4);
    });

    it('rejects substring matches (foobar, fooBar, barfoo)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      const line4 = ajs.references.filter(r => r.lineNumber === 4); // foobar
      const line5 = ajs.references.filter(r => r.lineNumber === 5); // fooBar
      const line6 = ajs.references.filter(r => r.lineNumber === 6); // barfoo
      expect(line4.length).toBe(0);
      expect(line5.length).toBe(0);
      expect(line6.length).toBe(0);
    });

    it('rejects underscore-adjacent identifiers (_foo, foo_)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      const line7 = ajs.references.filter(r => r.lineNumber === 7); // _foo
      const line8 = ajs.references.filter(r => r.lineNumber === 8); // foo_
      expect(line7.length).toBe(0);
      expect(line8.length).toBe(0);
    });

    it('treats $ as an identifier character ($foo, foo$)', async () => {
      vfs.addFile('/root/dollar.js', '$foo\nfoo$\n$foo$\n');
      const result = await finder.find({ symbol: 'foo' });
      const dollar = result.files.find(f => f.relativePath === 'dollar.js')!;
      expect(dollar.references.length).toBe(0);
    });

    it('treats non-ASCII identifier characters conservatively', async () => {
      vfs.addFile('/root/unicode.js', 'héllo foo\ncaféfoo\n');
      const result = await finder.find({ symbol: 'foo' });
      const uni = result.files.find(f => f.relativePath === 'unicode.js')!;
      const standalone = uni.references.find(r => r.lineNumber === 1)!;
      expect(standalone.matchedText).toBe('foo');
      const adjacent = uni.references.filter(r => r.lineNumber === 2); // caféfoo
      expect(adjacent.length).toBe(0);
    });

    it('matches across multiple recognized source languages', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const byLang: Record<string, number> = {};
      for (const f of result.files) {
        if (!f.skipped) {
          byLang[f.language] = (byLang[f.language] ?? 0) + f.referenceCount;
        }
      }
      expect(byLang['javascript']).toBeGreaterThan(0);
      expect(byLang['typescript']).toBeGreaterThan(0);
      expect(byLang['python']).toBeGreaterThan(0);
      expect(byLang['java']).toBeGreaterThan(0);
      expect(byLang['go']).toBeGreaterThan(0);
      expect(byLang['ruby']).toBeGreaterThan(0);
    });

    it('keeps file-level and occurrence-level language consistent', async () => {
      const result = await finder.find({ symbol: 'foo' });
      for (const f of result.files) {
        if (!f.skipped && f.references.length > 0) {
          expect(typeof f.language).toBe('string');
          expect(f.language.length).toBeGreaterThan(0);
          for (const r of f.references) {
            expect(r.language).toBe(f.language);
          }
        }
      }
    });
  });

  describe('language filtering', () => {
    it('honors the languages filter', async () => {
      const result = await finder.find({ symbol: 'foo', languages: ['python'] });
      for (const f of result.files) {
        if (!f.skipped) {
          expect(f.language).toBe('python');
        }
      }
      const python = result.files.find(f => f.relativePath === 'c.py')!;
      expect(python.referenceCount).toBeGreaterThan(0);
    });

    it('returns no matches when language filter excludes all files', async () => {
      const result = await finder.find({ symbol: 'foo', languages: ['rust'] });
      for (const f of result.files) {
        expect(f.referenceCount).toBe(0);
      }
    });

    it('skips files whose language cannot be determined', async () => {
      vfs.addFile('/root/unknown.xyz', 'foo\n');
      const result = await finder.find({ symbol: 'foo' });
      const unknown = result.files.find(f => f.relativePath === 'unknown.xyz');
      expect(unknown?.skipped).toBe(true);
      expect(unknown?.skipReason).toBe('unsupportedLanguage');
    });
  });

  describe('result correctness', () => {
    it('reports correct line numbers, columns, matched text and paths', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const bts = result.files.find(f => f.relativePath === 'b.ts')!;
      const first = bts.references[0];
      // "export const foo = 2;" -> foo at column 13, line 1
      expect(first.lineNumber).toBe(1);
      expect(first.startColumn).toBe(13);
      expect(first.endColumn).toBe(16);
      expect(first.matchedText).toBe('foo');
      expect(first.absolutePath).toBe('/root/b.ts');
      expect(first.relativePath).toBe('b.ts');
      expect(first.uri).toBe('file:///root/b.ts');
    });

    it('classifies every occurrence as textual_match with low confidence', async () => {
      const result = await finder.find({ symbol: 'foo' });
      for (const f of result.files) {
        for (const r of f.references) {
          expect(r.classification).toBe('textual_match');
          expect(r.confidence).toBe('low');
        }
      }
    });

    it('orders results deterministically by path, line, column', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const paths = result.files.map(f => f.relativePath);
      expect(paths).toEqual([...paths].sort());
      for (const f of result.files) {
        const refs = f.references;
        for (let i = 1; i < refs.length; i++) {
          const prev = refs[i - 1]!;
          const curr = refs[i]!;
          expect(
            prev.lineNumber < curr.lineNumber ||
            (prev.lineNumber === curr.lineNumber && prev.startColumn <= curr.startColumn)
          ).toBe(true);
        }
      }
    });

    it('groups results by file with correct counts', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ajs = result.files.find(f => f.relativePath === 'a.js')!;
      expect(ajs.referenceCount).toBe(ajs.references.length);
      // standalone foo() on line1, const foo line2, bar.foo line3 = 3 matches
      expect(ajs.referenceCount).toBe(3);
    });
  });

  describe('limits', () => {
    it('respects maxFilesExamined', async () => {
      const f = createFinder(vfs, 'file:///root', { maxFilesExamined: 2 });
      const result = await f.find({ symbol: 'foo' });
      expect(result.metadata.filesExamined).toBeLessThanOrEqual(2);
      if (result.metadata.truncated) {
        expect(result.metadata.limitReached).toBe('maxFilesExamined');
      }
    });

    it('respects maxFileSize (tooLarge)', async () => {
      vfs.addFile('/root/large.js', 'foo\n'.repeat(10));
      const f = createFinder(vfs, 'file:///root', { maxFileSize: 5 });
      const result = await f.find({ symbol: 'foo' });
      const large = result.files.find(f => f.relativePath === 'large.js')!;
      expect(large.skipped).toBe(true);
      expect(large.skipReason).toBe('tooLarge');
    });

    it('respects maxTotalBytesRead', async () => {
      const f = createFinder(vfs, 'file:///root', { maxTotalBytesRead: 10 });
      const result = await f.find({ symbol: 'foo' });
      if (result.metadata.truncated) {
        expect(result.metadata.limitReached).toBe('maxTotalBytesRead');
      }
    });

    it('respects maxReferencesPerFile', async () => {
      vfs.addFile('/root/many.js', 'foo\nfoo\nfoo\nfoo\nfoo\n');
      const f = createFinder(vfs, 'file:///root', { maxReferencesPerFile: 2 });
      const result = await f.find({ symbol: 'foo' });
      const many = result.files.find(f => f.relativePath === 'many.js')!;
      expect(many.referenceCount).toBe(2);
      expect(many.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxReferencesPerFile');
    });

    it('respects maxTotalReferences', async () => {
      const f = createFinder(vfs, 'file:///root', { maxTotalReferences: 1, maxReferencesPerFile: 1 });
      const result = await f.find({ symbol: 'foo' });
      expect(result.metadata.totalReferences).toBeLessThanOrEqual(1);
      if (result.metadata.truncated) {
        expect(result.metadata.limitReached).toBe('maxTotalReferences');
      }
    });

    it('respects maxOutputSize', async () => {
      const f = createFinder(vfs, 'file:///root', { maxOutputSize: 40 });
      const result = await f.find({ symbol: 'foo' });
      if (result.metadata.truncated) {
        expect(result.metadata.limitReached).toBe('maxOutputSize');
      }
    });

    it('applies config defaults when no config provided', async () => {
      expect(finder.getConfig().maxSymbolLength).toBe(256);
      expect(finder.getConfig().maxFilesExamined).toBe(1000);
      expect(finder.getConfig().enableLexicalFallback).toBe(true);
    });
  });

  describe('cancellation', () => {
    it('throws TOOL_CANCELLED when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expectToolError(finder.find({ symbol: 'foo', signal: controller.signal }), ToolErrorCode.TOOL_CANCELLED);
    });

    it('cancels between files when aborted mid-query', async () => {
      vfs.setReadDelay(150);
      const controller = new AbortController();
      const promise = finder.find({ symbol: 'foo', signal: controller.signal });
      setTimeout(() => controller.abort(), 40);
      await expectToolError(promise, ToolErrorCode.TOOL_CANCELLED);
    });
  });

  describe('security regressions', () => {
    it('excludes ignored files (node_modules, .git)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const ignored = result.files.find(f => f.relativePath === 'ignored.ts');
      // ignored.ts is matched by root-level default/user? No gitignore here.
      // It's a normal file, so it should be examined unless ignored.
      // node_modules and .git must not appear.
      expect(result.files.find(f => f.relativePath.startsWith('node_modules/'))).toBeUndefined();
      expect(result.files.find(f => f.relativePath.startsWith('.git/'))).toBeUndefined();
    });

    it('excludes sensitive files (.env, id_rsa)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const env = result.files.find(f => f.relativePath === '.env');
      const idRsa = result.files.find(f => f.relativePath === 'id_rsa');
      expect(env?.skipped).toBe(true);
      expect(env?.skipReason).toBe('sensitive');
      expect(idRsa?.skipped).toBe(true);
      expect(idRsa?.skipReason).toBe('sensitive');
    });

    it('excludes binary files by extension (.bin)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const bin = result.files.find(f => f.relativePath === 'data.bin');
      expect(bin?.skipped).toBe(true);
      expect(bin?.skipReason).toBe('binary');
    });

    it('does not follow symbolic links', async () => {
      vfs.addSymlink('/root/link.js');
      const result = await finder.find({ symbol: 'foo' });
      // Symbolic links are never traversed, so they do not appear in results.
      expect(result.files.find(f => f.relativePath === 'link.js')).toBeUndefined();
    });

    it('handles a read failure without terminating the query', async () => {
      vfs.addFile('/root/broken.js', 'foo\n');
      const originalRead = vfs.readFile.bind(vfs);
      vi.spyOn(vfs, 'readFile').mockImplementation(async (uri: string) => {
        if (uri.includes('broken.js')) {
          throw new Error('EIO: read failed');
        }
        return originalRead(uri);
      });
      const result = await finder.find({ symbol: 'foo' });
      const broken = result.files.find(f => f.relativePath === 'broken.js');
      expect(broken?.skipped).toBe(true);
      expect(broken?.skipReason).toBe('readError');
      expect(result.errors.some(e => e.path.includes('broken.js'))).toBe(true);
      // Other files still examined.
      expect(result.files.find(f => f.relativePath === 'a.js')?.referenceCount).toBeGreaterThan(0);
      (vfs.readFile as any).mockRestore();
    });

    it('does not log source content (no content in result)', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain('const foo = 1');
      expect(resultJson).not.toContain('SECRET=1');
    });
  });

  describe('invalid symbol queries', () => {
    it('rejects an empty symbol', async () => {
      await expectToolError(finder.find({ symbol: '' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol starting with a digit', async () => {
      await expectToolError(finder.find({ symbol: '123' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol containing non-identifier characters', async () => {
      await expectToolError(finder.find({ symbol: 'foo.bar' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
      await expectToolError(finder.find({ symbol: 'foo()' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
      await expectToolError(finder.find({ symbol: 'foo-bar' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol exceeding maxSymbolLength', async () => {
      const f = createFinder(vfs, 'file:///root', { maxSymbolLength: 5 });
      await expectToolError(f.find({ symbol: 'foobar' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('accepts the maximum-length symbol', async () => {
      const f = createFinder(vfs, 'file:///root', { maxSymbolLength: 3 });
      const result = await f.find({ symbol: 'foo' });
      expect(result.metadata.completed).toBe(true);
    });
  });

  describe('enableLexicalFallback', () => {
    it('returns no matches when lexical fallback is disabled', async () => {
      const f = createFinder(vfs, 'file:///root', { enableLexicalFallback: false });
      const result = await f.find({ symbol: 'foo' });
      expect(result.metadata.completed).toBe(true);
      expect(result.files.length).toBe(0);
      expect(result.metadata.totalReferences).toBe(0);
    });
  });

  describe('factory', () => {
    it('createLexicalFinder returns a LexicalFinder', () => {
      const f = createLexicalFinder({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(f).toBeInstanceOf(LexicalFinder);
    });
  });
});
