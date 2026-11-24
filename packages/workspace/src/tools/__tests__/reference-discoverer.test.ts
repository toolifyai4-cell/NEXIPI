import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ReferenceDiscoverer,
  createReferenceDiscoverer,
  type ReferenceDiscovererOptions,
} from '../reference-discoverer.js';
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
    const parts = k.split('/');
    const name = parts.pop()!;
    const parentDir = parts.join('/') || '/';
    if (!this.dirs.has(parentDir)) {
      this.dirs.set(parentDir, []);
    }
    const parentEntries = this.dirs.get(parentDir)!;
    if (!parentEntries.some(e => e.name === name && e.type === 'directory')) {
      parentEntries.push({ name, type: 'directory' });
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

  private ensureDir(filePath: string): void {
    const parts = filePath.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/';
      const isNew = !this.dirs.has(dir);
      if (isNew) {
        this.dirs.set(dir, []);
        if (i >= 2) {
          const parent = parts.slice(0, i - 1).join('/') || '/';
          const name = parts[i - 1];
          const parentEntries = this.dirs.get(parent);
          if (
            parentEntries &&
            !parentEntries.some(e => e.name === name && e.type === 'directory')
          ) {
            parentEntries.push({ name, type: 'directory' });
          }
        }
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

function createDiscoverer(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Parameters<typeof createReferenceDiscoverer>[0]['config']
) {
  return createReferenceDiscoverer({
    fileSystem: vfs,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    config,
  });
}

function buildTree(vfs: VirtualFileSystem): void {
  vfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
  vfs.addFile('/root/b.ts', 'export const foo = 2;\nimport { foo } from "./x";\nfoo.bar();\n');
  vfs.addFile('/root/c.py', 'def foo():\n    return foo\nfoo_ = 1\n_foo = 2\n');
  vfs.addFile('/root/d.java', 'public class Foo { void foo() { foo(); } }\n');
  vfs.addFile('/root/e.go', 'package main\nfunc foo() {}\nfoo();\n');
  vfs.addDir('/root/sub', [{ name: 'f.rb', type: 'file' }]);
  vfs.addFile('/root/sub/f.rb', 'def foo\n  puts foo\nend\n');
  vfs.addFile('/root/unknown.xyz', 'foo\n');
  vfs.addFile('/root/broken.js', 'function foo( { invalid syntax');
  vfs.addFile('/root/valid.js', 'function validFunc() { return foo; }\n');
  vfs.addFile('/root/ignored.ts', 'export const ignored = 1;\n');
  vfs.addDir('/root/.git', [{ name: 'config', type: 'file' }]);
  vfs.addFile('/root/.git/config', '[core]\n');
  vfs.addDir('/root/node_modules', [{ name: 'pkg', type: 'directory' }]);
  vfs.addFile('/root/node_modules/pkg/index.js', 'module.exports = {}\n');
  vfs.addFile('/root/.env', 'SECRET=1\n');
  vfs.addFile('/root/id_rsa', 'private key\n');
  vfs.addFile('/root/data.bin', '\x00\x01\x02binary');
  vfs.addSymlink('/root/link.js');
}

function expectToolError(promise: Promise<unknown>, code: ToolErrorCode): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'ToolError',
    code,
  } as ToolError);
}

function fileByPath(result: { files: readonly { readonly relativePath: string }[] }, relativePath: string) {
  return result.files.find(f => f.relativePath === relativePath);
}

describe('ReferenceDiscoverer', () => {
  let vfs: VirtualFileSystem;
  let discoverer: ReturnType<typeof createDiscoverer>;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    buildTree(vfs);
    discoverer = createDiscoverer(vfs);
  });

  describe('finder selection by language', () => {
    it('javascript file selects AST discovery', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const ajs = fileByPath(result, 'a.js')!;
      expect(ajs.skipped).toBe(false);
      for (const r of ajs.references) {
        expect(r.confidence).toBe('medium');
        expect(r.classification).not.toBe('textual_match');
      }
    });

    it('typescript file selects AST discovery', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const bts = fileByPath(result, 'b.ts')!;
      expect(bts.skipped).toBe(false);
      for (const r of bts.references) {
        expect(r.confidence).toBe('medium');
        expect(r.classification).not.toBe('textual_match');
      }
    });

    it('python file selects lexical discovery', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const cpy = fileByPath(result, 'c.py')!;
      expect(cpy.skipped).toBe(false);
      for (const r of cpy.references) {
        expect(r.classification).toBe('textual_match');
        expect(r.confidence).toBe('low');
      }
    });

    it('other supported language selects lexical discovery', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const djava = fileByPath(result, 'd.java')!;
      const ego = fileByPath(result, 'e.go')!;
      const frb = fileByPath(result, 'sub/f.rb')!;
      for (const f of [djava, ego, frb]) {
        if (!f.skipped) {
          for (const r of f.references) {
            expect(r.classification).toBe('textual_match');
            expect(r.confidence).toBe('low');
          }
        }
      }
    });

    it('unsupported language is not passed to either finder', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const unknown = fileByPath(result, 'unknown.xyz');
      expect(unknown?.skipped).toBe(true);
      expect(unknown?.skipReason).toBe('unsupportedLanguage');
      expect(unknown?.referenceCount).toBe(0);
      expect(result.errors.some(e => e.path.includes('unknown.xyz'))).toBe(false);
    });

    it('mixed-language workspace uses the correct finder per file', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const byLang: Record<string, 'ast' | 'lexical'> = {};
      for (const f of result.files) {
        if (f.skipped) continue;
        for (const r of f.references) {
          const kind = r.confidence === 'medium' ? 'ast' : 'lexical';
          byLang[f.language] = kind;
        }
      }
      expect(byLang['javascript']).toBe('ast');
      expect(byLang['typescript']).toBe('ast');
      expect(byLang['python']).toBe('lexical');
      expect(byLang['java']).toBe('lexical');
      expect(byLang['go']).toBe('lexical');
      expect(byLang['ruby']).toBe('lexical');
    });

    it('no file is processed by both finders', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      for (const f of result.files) {
        if (f.skipped) continue;
        const confidences = new Set(f.references.map(r => r.confidence));
        if (f.language === 'javascript' || f.language === 'typescript') {
          expect(confidences.has('low')).toBe(false);
          for (const r of f.references) {
            expect(r.classification).not.toBe('textual_match');
          }
        } else {
          expect(confidences.has('medium')).toBe(false);
          for (const r of f.references) {
            expect(r.classification).toBe('textual_match');
          }
        }
      }
    });
  });

  describe('duplicate prevention', () => {
    it('does not introduce duplicate occurrences through orchestration', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const ajs = fileByPath(result, 'a.js')!;
      const locations = ajs.references.map(r => `${r.lineNumber}:${r.startColumn}:${r.classification}`);
      expect(locations.length).toBe(new Set(locations).size);
    });

    it('preserves legitimate repeated references at different positions', async () => {
      vfs.addFile('/root/repeat.js', 'foo\nfoo\nfoo\n');
      const d = createDiscoverer(vfs);
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const rep = fileByPath(result, 'repeat.js')!;
      expect(rep.referenceCount).toBe(3);
      expect(rep.references.map(r => r.lineNumber)).toEqual([1, 2, 3]);
    });
  });

  describe('confidence and classification preservation', () => {
    it('AST confidence remains medium', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      for (const f of result.files) {
        if (f.language === 'javascript' || f.language === 'typescript') {
          for (const r of f.references) {
            expect(r.confidence).toBe('medium');
          }
        }
      }
    });

    it('lexical confidence remains low', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      for (const f of result.files) {
        if (f.language === 'python' || f.language === 'java' || f.language === 'go' || f.language === 'ruby') {
          for (const r of f.references) {
            expect(r.confidence).toBe('low');
          }
        }
      }
    });

    it('AST classifications remain unchanged', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const ajs = fileByPath(result, 'a.js')!;
      const decl = ajs.references.find(r => r.lineNumber === 2 && r.classification === 'declaration');
      const call = ajs.references.find(r => r.lineNumber === 1 && r.classification === 'call');
      expect(decl).toBeDefined();
      expect(call).toBeDefined();
    });

    it('lexical classifications remain textual_match', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const cpy = fileByPath(result, 'c.py')!;
      for (const r of cpy.references) {
        expect(r.classification).toBe('textual_match');
      }
    });
  });

  describe('error isolation', () => {
    it('malformed AST file does not prevent other files from being processed', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const valid = fileByPath(result, 'valid.js')!;
      expect(valid.skipped).toBe(false);
      expect(valid.referenceCount).toBeGreaterThan(0);
    });

    it('per-file errors remain visible', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const broken = fileByPath(result, 'broken.js');
      // ts.createSourceFile recovers from syntax errors, so broken.js is examined
      // (not skipped) and its parse diagnostics are reported as non-fatal errors.
      expect(broken?.skipped).toBe(false);
      expect(result.errors.some(e => e.path.includes('broken.js') && !e.isFatal)).toBe(true);
    });

    it('unsupported-language reporting is distinguishable from parser errors', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const unknown = fileByPath(result, 'unknown.xyz');
      expect(unknown?.skipped).toBe(true);
      expect(unknown?.skipReason).toBe('unsupportedLanguage');
      const brokenErrors = result.errors.filter(e => e.path.includes('broken.js'));
      expect(brokenErrors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.path.includes('unknown.xyz'))).toBe(false);
    });
  });

  describe('global limits', () => {
    it('respects global maximum file count', async () => {
      const d = createDiscoverer(vfs, 'file:///root', { maxFilesExamined: 2 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      // Only files actually scanned count; skipped files do not consume the budget.
      expect(result.metadata.filesExamined).toBe(2);
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxFilesExamined');
      expect(result.metadata.completed).toBe(false);
    });

    it('respects global total bytes read', async () => {
      const d = createDiscoverer(vfs, 'file:///root', { maxTotalBytesRead: 10 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalBytesRead');
      expect(result.metadata.completed).toBe(false);
    });

    it('tracks exact byte consumption via maxTotalBytesRead', async () => {
      // a.js: 'foo()\nconst foo = 1;\nbar.foo\n' = 29 UTF-8 bytes
      // c.py: 'def foo():\n    return foo\n'             = 26 UTF-8 bytes
      const byteVfs = new VirtualFileSystem();
      byteVfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
      byteVfs.addFile('/root/c.py', 'def foo():\n    return foo\n');
      const d = createDiscoverer(byteVfs, 'file:///root', { maxTotalBytesRead: 29 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      // a.js (29 bytes) fits the budget exactly; c.py (26 bytes) would exceed it
      expect(result.metadata.filesExamined).toBe(1);
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalBytesRead');
      expect(result.metadata.completed).toBe(false);
    });

    it('enforces maxTotalBytesRead with multibyte UTF-8 fixtures', async () => {
      // 'café\n' = 6 UTF-8 bytes (é is 2 bytes); '中\n' = 4 UTF-8 bytes (中 is 3 bytes).
      expect(Buffer.byteLength('café\n', 'utf8')).toBe(6);
      expect(Buffer.byteLength('中\n', 'utf8')).toBe(4);
      const byteVfs = new VirtualFileSystem();
      byteVfs.addFile('/root/unicode.js', 'café\n');
      byteVfs.addFile('/root/unicode.py', '中\n');
      const d = createDiscoverer(byteVfs, 'file:///root', { maxTotalBytesRead: 6 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      // unicode.js (6 bytes) fits the remaining budget exactly and is scanned
      expect(result.metadata.filesExamined).toBe(1);
      const js = fileByPath(result, 'unicode.js')!;
      expect(js.skipped).toBe(false);
      // unicode.py (4 bytes) would exceed the remaining budget and is rejected before scanning
      const py = fileByPath(result, 'unicode.py');
      expect(py?.skipped).toBe(true);
      expect(py?.skipReason).toBe('tooLarge');
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalBytesRead');
      expect(result.metadata.completed).toBe(false);
    });

    it('respects global maximum references per file', async () => {
      vfs.addFile('/root/many.js', 'foo\nfoo\nfoo\nfoo\nfoo\n');
      const d = createDiscoverer(vfs, 'file:///root', { maxReferencesPerFile: 2 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const many = fileByPath(result, 'many.js')!;
      expect(many.referenceCount).toBe(2);
      expect(many.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxReferencesPerFile');
    });

    it('respects global maximum total references', async () => {
      // maxReferencesPerFile is left high so per-file truncation is not the
      // binding limit; maxTotalReferences is the first global limit reached.
      const d = createDiscoverer(vfs, 'file:///root', { maxTotalReferences: 1, maxReferencesPerFile: 100 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.totalReferences).toBeGreaterThanOrEqual(1);
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalReferences');
      expect(result.metadata.completed).toBe(false);
    });

    it('shares maxTotalReferences across AST and lexical files', async () => {
      // a.js (AST): exactly 2 discoverable references ('foo()' call, 'const foo = 1'
      // declaration; 'bar.foo' is a property name and is skipped by the AST finder).
      // c.py (lexical): 4 discoverable whole-word 'foo' references, but only 2 fit
      // in the remaining global budget after a.js consumes 2 of the 4-reference limit.
      const crossVfs = new VirtualFileSystem();
      crossVfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
      crossVfs.addFile('/root/c.py', 'foo\nfoo\nfoo\nfoo\n');
      const d = createDiscoverer(crossVfs, 'file:///root', { maxTotalReferences: 4, maxReferencesPerFile: 100 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      // Global shared budget: 4 total references across both finders.
      expect(result.metadata.totalReferences).toBe(4);
      // No more than four references are returned.
      expect(result.metadata.totalReferences).toBeLessThanOrEqual(4);
      expect(result.metadata.truncated).toBe(true);
      // c.py has additional discoverable references that were omitted.
      expect(result.metadata.limitReached).toBe('maxTotalReferences');
      expect(result.metadata.completed).toBe(false);

      const ajs = fileByPath(result, 'a.js')!;
      const cpy = fileByPath(result, 'c.py')!;
      // a.js scanned first (alphabetical), consumes 2 of the 4-reference budget
      expect(ajs.referenceCount).toBe(2);
      // c.py receives only the remaining 2 references although it has 4 discoverable;
      // this proves the lexical scanner is constrained by the remaining global budget,
      // not merely that two files happen to contain four references in total.
      expect(cpy.referenceCount).toBe(2);
      expect(cpy.referenceCount).toBeLessThan(4);
      expect(ajs.referenceCount + cpy.referenceCount).toBe(4);
    });

    it('exact limit with complete discovery: all candidates examined, none omitted', async () => {
      // maxTotalReferences = 4 and the workspace contains exactly 4 discoverable
      // references (2 AST in a.js, 2 lexical in c.py) with no further matches
      // anywhere. All candidates are examined and no reference is omitted.
      const completeVfs = new VirtualFileSystem();
      completeVfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
      completeVfs.addFile('/root/c.py', 'foo\nfoo\n');
      const d = createDiscoverer(completeVfs, 'file:///root', { maxTotalReferences: 4, maxReferencesPerFile: 100 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.totalReferences).toBe(4);
      expect(result.metadata.filesExamined).toBe(2);
      // Contract ambiguity: nothing was truncated (all results returned, all
      // candidates examined), so completed:true / truncated:false is defensible.
      // The implementation instead terminates via the post-file limit check and
      // reports truncated:true / completed:false / limitReached:'maxTotalReferences',
      // indistinguishable from the omitted-results case at the break point.
      // This test captures current behavior; see the final report for the
      // recommended decision.
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.completed).toBe(false);
      expect(result.metadata.limitReached).toBe('maxTotalReferences');
    });

    it('exact limit with additional results omitted', async () => {
      // maxTotalReferences = 4 but the workspace contains more than 4 discoverable
      // references (2 AST in a.js, 4 lexical in c.py), so the limit prevents
      // further discovery.
      const omittedVfs = new VirtualFileSystem();
      omittedVfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
      omittedVfs.addFile('/root/c.py', 'foo\nfoo\nfoo\nfoo\n');
      const d = createDiscoverer(omittedVfs, 'file:///root', { maxTotalReferences: 4, maxReferencesPerFile: 100 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.totalReferences).toBe(4);
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalReferences');
      expect(result.metadata.completed).toBe(false);
    });

    it('stops scanning when remaining global reference budget is zero', async () => {
      // a.js (AST): 2 matches exhausts a maxTotalReferences of 2
      const crossVfs = new VirtualFileSystem();
      crossVfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
      crossVfs.addFile('/root/c.py', 'def foo():\n    return foo\n');
      const d = createDiscoverer(crossVfs, 'file:///root', { maxTotalReferences: 2, maxReferencesPerFile: 100 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.totalReferences).toBe(2);
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxTotalReferences');
      expect(result.metadata.completed).toBe(false);
      // Zero remaining budget prevents scanning the second file entirely
      expect(result.metadata.filesExamined).toBe(1);
      expect(fileByPath(result, 'c.py')).toBeUndefined();
    });

    it('respects global maximum output size', async () => {
      const d = createDiscoverer(vfs, 'file:///root', { maxOutputSize: 1 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBe('maxOutputSize');
      expect(result.metadata.completed).toBe(false);
    });

    it('reports truncation and limitReached metadata consistently', async () => {
      const d = createDiscoverer(vfs, 'file:///root', { maxTotalReferences: 1, maxReferencesPerFile: 1 });
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.metadata.truncated).toBe(true);
      expect(result.metadata.limitReached).toBeDefined();
      expect(result.metadata.completed).toBe(false);
      expect(result.metadata.cancelled).toBe(false);
    });
  });

  describe('cancellation', () => {
    it('throws TOOL_CANCELLED when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expectToolError(
        discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root'), signal: controller.signal }),
        ToolErrorCode.TOOL_CANCELLED
      );
    });

    it('throws TOOL_CANCELLED when aborted during discovery', async () => {
      vfs.setReadDelay(150);
      const controller = new AbortController();
      const promise = discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root'), signal: controller.signal });
      setTimeout(() => controller.abort(), 40);
      await expectToolError(promise, ToolErrorCode.TOOL_CANCELLED);
    });
  });

  describe('ordering', () => {
    it('orders files and occurrences deterministically', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
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
  });

  describe('filters', () => {
    it('honors include patterns', async () => {
      const result = await discoverer.find({
        symbol: 'foo',
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        includePatterns: ['*.js'],
      });
      for (const f of result.files) {
        if (!f.skipped) {
          expect(f.language).toBe('javascript');
        }
      }
    });

    it('honors exclude patterns', async () => {
      const result = await discoverer.find({
        symbol: 'foo',
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        excludePatterns: ['a.js'],
      });
      expect(fileByPath(result, 'a.js')).toBeUndefined();
    });
  });

  describe('security protections', () => {
    it('excludes sensitive, ignored, binary, symlink, and out-of-workspace files', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.files.find(f => f.relativePath.startsWith('node_modules/'))).toBeUndefined();
      expect(result.files.find(f => f.relativePath.startsWith('.git/'))).toBeUndefined();
      expect(result.files.find(f => f.relativePath === '.env')).toBeUndefined();
      const idRsa = fileByPath(result, 'id_rsa');
      expect(idRsa?.skipped).toBe(true);
      expect(idRsa?.skipReason).toBe('sensitive');
      const bin = fileByPath(result, 'data.bin');
      expect(bin?.skipped).toBe(true);
      expect(bin?.skipReason).toBe('binary');
      expect(fileByPath(result, 'link.js')).toBeUndefined();
    });

    it('does not log source content in results', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const json = JSON.stringify(result);
      expect(json).not.toContain('SECRET=1');
      expect(json).not.toContain('const foo = 1');
    });
  });

  describe('language-scoped queries', () => {
    it('handles an empty workspace with no candidates', async () => {
      const emptyVfs = new VirtualFileSystem();
      emptyVfs.addDir('/root', []);
      const d = createDiscoverer(emptyVfs);
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      expect(result.files).toEqual([]);
      expect(result.metadata.filesExamined).toBe(0);
      expect(result.metadata.completed).toBe(true);
    });

    it('query with only JavaScript/TypeScript files uses AST discovery', async () => {
      const onlyVfs = new VirtualFileSystem();
      onlyVfs.addFile('/root/a.js', 'foo()\n');
      onlyVfs.addFile('/root/b.ts', 'export const foo = 2;\n');
      const d = createDiscoverer(onlyVfs);
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      for (const f of result.files) {
        if (!f.skipped) {
          for (const r of f.references) {
            expect(r.confidence).toBe('medium');
          }
        }
      }
    });

    it('query with only lexical-language files uses lexical discovery', async () => {
      const onlyVfs = new VirtualFileSystem();
      onlyVfs.addFile('/root/c.py', 'def foo():\n    return foo\n');
      onlyVfs.addFile('/root/d.java', 'void foo() { foo(); }\n');
      const d = createDiscoverer(onlyVfs);
      const result = await d.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      for (const f of result.files) {
        if (!f.skipped) {
          for (const r of f.references) {
            expect(r.classification).toBe('textual_match');
            expect(r.confidence).toBe('low');
          }
        }
      }
    });

    it('query with mixed AST and lexical results returns both', async () => {
      const result = await discoverer.find({ symbol: 'foo', workspaceFolder: makeWorkspaceFolder('file:///root', 'root') });
      const hasAst = result.files.some(f => (f.language === 'javascript' || f.language === 'typescript') && f.references.length > 0);
      const hasLexical = result.files.some(f => f.language === 'python' && f.references.length > 0);
      expect(hasAst).toBe(true);
      expect(hasLexical).toBe(true);
    });
  });

  describe('factory', () => {
    it('createReferenceDiscoverer returns a ReferenceDiscoverer', () => {
      const d = createReferenceDiscoverer({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(d).toBeInstanceOf(ReferenceDiscoverer);
    });

    it('exposes the validated config', () => {
      const d = createReferenceDiscoverer({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
        config: { maxFilesExamined: 10 },
      });
      expect(d.getConfig().maxFilesExamined).toBe(10);
      expect(d.getConfig().maxSymbolLength).toBe(256);
    });
  });
});
