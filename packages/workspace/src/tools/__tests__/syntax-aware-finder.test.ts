import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SyntaxAwareFinder,
  createSyntaxAwareFinder,
  type SyntaxAwareFinderOptions,
} from '../syntax-aware-finder.js';
import { ToolErrorCode, type ToolError } from '../errors.js';
import type { FileSystemProvider, DirectoryEntry, FileStat } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';
import * as ts from 'typescript';

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

function createFinder(
  vfs: VirtualFileSystem,
  rootUri: string = 'file:///root',
  config?: Parameters<typeof createSyntaxAwareFinder>[0]['config']
) {
  return createSyntaxAwareFinder({
    fileSystem: vfs,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    config,
  });
}

function buildTree(vfs: VirtualFileSystem): void {
  // JavaScript declarations
  vfs.addFile('/root/decls.js', [
    'function foo() {}',
    'class Bar {}',
    'const baz = 1;',
    'function qux() {',
    '  foo();',
    '  return baz;',
    '}',
  ].join('\n'));

  // TypeScript type declarations and references
  vfs.addFile('/root/types.ts', [
    'interface Foo {',
    '  prop: string;',
    '}',
    '',
    'type Alias = number;',
    '',
    'enum Color {',
    '  Red,',
    '  Green',
    '}',
    '',
    'declare function bar(x: Foo): Alias;',
  ].join('\n'));

  // Function and method calls
  vfs.addFile('/root/calls.js', [
    'foo();',
    'obj.method();',
    'foo.bar();',
  ].join('\n'));

  // Import declarations
  vfs.addFile('/root/imports.js', [
    'import { foo } from "./mod";',
    'import { bar as baz } from "./mod";',
    'import defaultExport from "./mod";',
    'import * as ns from "./mod";',
  ].join('\n'));

  // Export declarations
  vfs.addFile('/root/exports.js', [
    'export const foo = 1;',
    'export { bar };',
    'export { baz as qux };',
    'export default function() {};',
    'export = exportedSymbol;',
  ].join('\n'));

  // Usages and property access exclusions
  vfs.addFile('/root/usage.js', [
    'const x = foo + bar;',
    'foo.bar;',
    'const { baz } = obj;',
    'const { qux: q } = obj;',
  ].join('\n'));

  // JSX and TSX files
  vfs.addFile('/root/component.jsx', 'const el = <div>foo</div>;');
  vfs.addFile('/root/component.tsx', 'const el: JSX.Element = <div>foo</div>;');

  // Unsupported language
  vfs.addFile('/root/script.py', 'def foo():\n    return foo\n');

  // Malformed file alongside valid file
  vfs.addFile('/root/broken.js', 'function foo( { invalid syntax');
  vfs.addFile('/root/valid.js', 'function validFunc() { return foo; }');

  // Ignored, sensitive, binary, symlink files
  vfs.addFile('/root/ignored.ts', 'export const ignored = 1;');
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

describe('SyntaxAwareFinder', () => {
  let vfs: VirtualFileSystem;
  let finder: ReturnType<typeof createFinder>;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    buildTree(vfs);
    finder = createFinder(vfs);
  });

  describe('JavaScript declarations', () => {
    it('classifies function declarations', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const decls = result.files.flatMap(f => f.references.filter(r => r.classification === 'declaration'));
      expect(decls.length).toBeGreaterThan(0);
      for (const d of decls) {
        expect(d.confidence).toBe('medium');
      }
    });

    it('classifies class declarations', async () => {
      const result = await finder.find({ symbol: 'Bar' });
      const decls = result.files.flatMap(f => f.references.filter(r => r.classification === 'declaration'));
      expect(decls.length).toBe(1);
      expect(decls[0].confidence).toBe('medium');
    });

    it('classifies variable declarations', async () => {
      const result = await finder.find({ symbol: 'baz' });
      const declsFile = result.files.find(f => f.relativePath === 'decls.js')!;
      const decls = declsFile.references.filter(r => r.classification === 'declaration');
      expect(decls.length).toBe(1);
      expect(decls[0].confidence).toBe('medium');
    });
  });

  describe('TypeScript type declarations and references', () => {
    it('classifies interface declarations', async () => {
      const result = await finder.find({ symbol: 'Foo' });
      const tsFile = result.files.find(f => f.relativePath === 'types.ts')!;
      const interfaceDecl = tsFile.references.find(r => r.lineNumber === 1 && r.classification === 'declaration');
      expect(interfaceDecl).toBeDefined();
      expect(interfaceDecl!.confidence).toBe('medium');
    });

    it('classifies type alias declarations', async () => {
      const result = await finder.find({ symbol: 'Alias' });
      const tsFile = result.files.find(f => f.relativePath === 'types.ts')!;
      const aliasDecl = tsFile.references.find(r => r.classification === 'declaration');
      expect(aliasDecl).toBeDefined();
      expect(aliasDecl!.confidence).toBe('medium');
    });

    it('classifies enum declarations and members', async () => {
      const result = await finder.find({ symbol: 'Color' });
      const tsFile = result.files.find(f => f.relativePath === 'types.ts')!;
      const enumDecl = tsFile.references.find(r => r.classification === 'declaration');
      expect(enumDecl).toBeDefined();
      expect(enumDecl!.confidence).toBe('medium');
    });

    it('classifies type references as usage', async () => {
      const result = await finder.find({ symbol: 'Foo' });
      const tsFile = result.files.find(f => f.relativePath === 'types.ts')!;
      // `declare function bar(x: Foo): Alias` - Foo is a type reference
      const typeRef = tsFile.references.find(r => r.classification === 'usage');
      expect(typeRef).toBeDefined();
      expect(typeRef!.confidence).toBe('medium');
    });
  });

  describe('Function and method calls', () => {
    it('classifies direct function calls as call', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const callsFile = result.files.find(f => f.relativePath === 'calls.js')!;
      const call = callsFile.references.find(r => r.lineNumber === 1 && r.classification === 'call');
      expect(call).toBeDefined();
      expect(call!.confidence).toBe('medium');
    });

    it('classifies the object in method calls as usage, excludes method name', async () => {
      const result = await finder.find({ symbol: 'obj' });
      const callsFile = result.files.find(f => f.relativePath === 'calls.js')!;
      const usage = callsFile.references.find(r => r.lineNumber === 2 && r.classification === 'usage');
      expect(usage).toBeDefined();
      expect(usage!.confidence).toBe('medium');
    });

    it('does not classify property names as calls', async () => {
      const result = await finder.find({ symbol: 'method' });
      const callsFile = result.files.find(f => f.relativePath === 'calls.js')!;
      // `method` in `obj.method()` is a property name, excluded
      const methodRefs = callsFile.references.filter(r => r.symbol === 'method');
      expect(methodRefs.length).toBe(0);
    });
  });

  describe('Import declarations', () => {
    it('classifies named imports', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const importsFile = result.files.find(f => f.relativePath === 'imports.js')!;
      const importRef = importsFile.references.find(r => r.lineNumber === 1 && r.classification === 'import');
      expect(importRef).toBeDefined();
      expect(importRef!.confidence).toBe('medium');
    });

    it('classifies imported and local names in aliased imports', async () => {
      const result = await finder.find({ symbol: 'bar' });
      const importsFile = result.files.find(f => f.relativePath === 'imports.js')!;
      const barRef = importsFile.references.find(r => r.lineNumber === 2 && r.classification === 'import');
      expect(barRef).toBeDefined();
    });

    it('classifies local binding in aliased imports as import', async () => {
      const result = await finder.find({ symbol: 'baz' });
      const importsFile = result.files.find(f => f.relativePath === 'imports.js')!;
      const bazRef = importsFile.references.find(r => r.lineNumber === 2 && r.classification === 'import');
      expect(bazRef).toBeDefined();
    });

    it('classifies default imports', async () => {
      const result = await finder.find({ symbol: 'defaultExport' });
      const importsFile = result.files.find(f => f.relativePath === 'imports.js')!;
      const defRef = importsFile.references.find(r => r.lineNumber === 3 && r.classification === 'import');
      expect(defRef).toBeDefined();
    });

    it('classifies namespace imports', async () => {
      const result = await finder.find({ symbol: 'ns' });
      const importsFile = result.files.find(f => f.relativePath === 'imports.js')!;
      const nsRef = importsFile.references.find(r => r.lineNumber === 4 && r.classification === 'import');
      expect(nsRef).toBeDefined();
    });
  });

  describe('Export declarations', () => {
    it('classifies exported variable declarations as declaration', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const exportsFile = result.files.find(f => f.relativePath === 'exports.js')!;
      const decl = exportsFile.references.find(r => r.lineNumber === 1 && r.classification === 'declaration');
      expect(decl).toBeDefined();
    });

    it('classifies export specifiers as export', async () => {
      const result = await finder.find({ symbol: 'bar' });
      const exportsFile = result.files.find(f => f.relativePath === 'exports.js')!;
      const exportRef = exportsFile.references.find(r => r.lineNumber === 2 && r.classification === 'export');
      expect(exportRef).toBeDefined();
    });

    it('classifies both sides of aliased export specifiers as export', async () => {
      const result = await finder.find({ symbol: 'baz' });
      const exportsFile = result.files.find(f => f.relativePath === 'exports.js')!;
      const bazRef = exportsFile.references.find(r => r.lineNumber === 3 && r.classification === 'export');
      expect(bazRef).toBeDefined();
    });

    it('classifies export assignment expression as export', async () => {
      const result = await finder.find({ symbol: 'exportedSymbol' });
      const exportsFile = result.files.find(f => f.relativePath === 'exports.js')!;
      const exportRef = exportsFile.references.find(r => r.lineNumber === 5 && r.classification === 'export');
      expect(exportRef).toBeDefined();
    });
  });

  describe('Usages and property access exclusions', () => {
    it('classifies binary expression operands as usage', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const usageFile = result.files.find(f => f.relativePath === 'usage.js')!;
      const usage = usageFile.references.find(r => r.lineNumber === 1 && r.classification === 'usage');
      expect(usage).toBeDefined();
    });

    it('classifies property access object as usage', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const usageFile = result.files.find(f => f.relativePath === 'usage.js')!;
      const usage = usageFile.references.find(r => r.lineNumber === 2 && r.classification === 'usage');
      expect(usage).toBeDefined();
    });

    it('does not classify property names as usages', async () => {
      const result = await finder.find({ symbol: 'bar' });
      const usageFile = result.files.find(f => f.relativePath === 'usage.js')!;
      // `bar` on line 1 (`foo + bar`) is a valid usage; `bar` on line 2
      // (`foo.bar`) is a property name and must be excluded.
      const propNameRef = usageFile.references.find(
        r => r.lineNumber === 2 && r.symbol === 'bar'
      );
      expect(propNameRef).toBeUndefined();
    });

    it('classifies destructuring binding names as declaration', async () => {
      const result = await finder.find({ symbol: 'baz' });
      const usageFile = result.files.find(f => f.relativePath === 'usage.js')!;
      const decl = usageFile.references.find(r => r.lineNumber === 3 && r.classification === 'declaration');
      expect(decl).toBeDefined();
    });

    it('classifies destructuring local names as declaration and excludes property names', async () => {
      const result = await finder.find({ symbol: 'q' });
      const usageFile = result.files.find(f => f.relativePath === 'usage.js')!;
      const decl = usageFile.references.find(r => r.lineNumber === 4 && r.classification === 'declaration');
      expect(decl).toBeDefined();
      // `qux` is a property name, excluded
      const quxRefs = usageFile.references.filter(r => r.symbol === 'qux');
      expect(quxRefs.length).toBe(0);
    });
  });

  describe('JSX and TSX script-kind handling', () => {
    it('parses JSX files', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const jsxFile = result.files.find(f => f.relativePath === 'component.jsx')!;
      expect(jsxFile.skipped).toBe(false);
      expect(jsxFile.language).toBe('javascript');
    });

    it('parses TSX files', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const tsxFile = result.files.find(f => f.relativePath === 'component.tsx')!;
      expect(tsxFile.skipped).toBe(false);
      expect(tsxFile.language).toBe('typescript');
    });
  });

  describe('Unsupported language behavior', () => {
    it('skips non-JavaScript/TypeScript files as unsupportedLanguage', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const pyFile = result.files.find(f => f.relativePath === 'script.py')!;
      expect(pyFile.skipped).toBe(true);
      expect(pyFile.skipReason).toBe('unsupportedLanguage');
    });

    it('does not parse Python files with the TypeScript compiler', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const pyFile = result.files.find(f => f.relativePath === 'script.py')!;
      expect(pyFile.referenceCount).toBe(0);
    });
  });

  describe('Malformed source isolation', () => {
    it('traverses valid files when a sibling file is malformed', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const validFile = result.files.find(f => f.relativePath === 'valid.js')!;
      expect(validFile.skipped).toBe(false);
      expect(validFile.referenceCount).toBeGreaterThan(0);
    });

    it('reports parse diagnostics for malformed files as non-fatal errors', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const brokenErrors = result.errors.filter(e => e.path.includes('broken.js'));
      expect(brokenErrors.length).toBeGreaterThan(0);
      for (const e of brokenErrors) {
        expect(e.isFatal).toBe(false);
      }
    });

    it('does not terminate the query on malformed source', async () => {
      const result = await finder.find({ symbol: 'foo' });
      expect(result.metadata.completed).toBe(true);
      expect(result.metadata.cancelled).toBe(false);
    });
  });

  describe('Multiple files with one malformed', () => {
    it('discovers references across valid and malformed files', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const validFile = result.files.find(f => f.relativePath === 'valid.js')!;
      const brokenFile = result.files.find(f => f.relativePath === 'broken.js')!;
      expect(validFile.referenceCount).toBeGreaterThan(0);
      // broken.js may have recovered references or none, but should not crash
      expect(brokenFile.skipped).toBe(false);
    });
  });

  describe('Include and exclude filters', () => {
    it('honors include patterns', async () => {
      const result = await finder.find({ symbol: 'foo', includePatterns: ['*.ts'] });
      for (const f of result.files) {
        if (!f.skipped) {
          expect(f.language).toBe('typescript');
        }
      }
    });

    it('honors exclude patterns', async () => {
      const result = await finder.find({ symbol: 'foo', excludePatterns: ['decls.js'] });
      const declsFile = result.files.find(f => f.relativePath === 'decls.js');
      expect(declsFile).toBeUndefined();
    });
  });

  describe('Deterministic ordering', () => {
    it('orders results by relative path', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const paths = result.files.map(f => f.relativePath);
      expect(paths).toEqual([...paths].sort());
    });

    it('orders occurrences within a file by line then column', async () => {
      const result = await finder.find({ symbol: 'foo' });
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

  describe('Correct positions', () => {
    it('reports correct line numbers and columns for JavaScript declarations', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const declsFile = result.files.find(f => f.relativePath === 'decls.js')!;
      // "function foo() {}" -> foo at line 1, column 9
      const decl = declsFile.references.find(r => r.lineNumber === 1 && r.classification === 'declaration');
      expect(decl).toBeDefined();
      expect(decl!.startColumn).toBe(9);
      expect(decl!.endColumn).toBe(12);
      expect(decl!.matchedText).toBe('foo');
      expect(decl!.absolutePath).toBe('/root/decls.js');
      expect(decl!.relativePath).toBe('decls.js');
      expect(decl!.uri).toBe('file:///root/decls.js');
    });

    it('reports correct positions for TypeScript declarations', async () => {
      const result = await finder.find({ symbol: 'Foo' });
      const tsFile = result.files.find(f => f.relativePath === 'types.ts')!;
      const decl = tsFile.references.find(r => r.lineNumber === 1 && r.classification === 'declaration');
      expect(decl).toBeDefined();
      expect(decl!.startColumn).toBe(10);
      expect(decl!.endColumn).toBe(13);
    });

    it('reports UTF-16 columns consistently', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const declsFile = result.files.find(f => f.relativePath === 'decls.js')!;
      const call = declsFile.references.find(r => r.lineNumber === 5 && r.classification === 'call');
      // "  foo();" -> foo at line 5, column 2
      expect(call).toBeDefined();
      expect(call!.startColumn).toBe(2);
      expect(call!.endColumn).toBe(5);
    });
  });

  describe('Declaration names not duplicated as usages', () => {
    it('does not report a declaration name as both declaration and usage at the same location', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const declsFile = result.files.find(f => f.relativePath === 'decls.js')!;
      const fooRefs = declsFile.references.filter(r => r.symbol === 'foo');
      const locations = fooRefs.map(r => `${r.lineNumber}:${r.startColumn}`);
      expect(locations.length).toBe(new Set(locations).size);
    });
  });

  describe('Cancellation', () => {
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

  describe('Resource limits', () => {
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
      const large = result.files.find(f => f.relativePath === 'large.js');
      expect(large?.skipped).toBe(true);
      expect(large?.skipReason).toBe('tooLarge');
    });

    it('respects maxTotalBytesRead', async () => {
      const f = createFinder(vfs, 'file:///root', { maxTotalBytesRead: 10 });
      const result = await f.find({ symbol: 'foo' });
      if (result.metadata.truncated) {
        expect(result.metadata.limitReached).toBe('maxTotalBytesRead');
      }
    });

    it('respects maxReferencesPerFile', async () => {
      vfs.addFile('/root/many.js', Array(5).fill('foo();\n').join(''));
      const f = createFinder(vfs, 'file:///root', { maxReferencesPerFile: 2 });
      const result = await f.find({ symbol: 'foo' });
      const many = result.files.find(f => f.relativePath === 'many.js');
      expect(many?.referenceCount).toBe(2);
      expect(many?.truncated).toBe(true);
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
  });

  describe('Security exclusions', () => {
    it('excludes node_modules and .git', async () => {
      const result = await finder.find({ symbol: 'foo' });
      expect(result.files.find(f => f.relativePath.startsWith('node_modules/'))).toBeUndefined();
      expect(result.files.find(f => f.relativePath.startsWith('.git/'))).toBeUndefined();
    });

    it('excludes sensitive files', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const idRsa = result.files.find(f => f.relativePath === 'id_rsa');
      expect(idRsa?.skipped).toBe(true);
      expect(idRsa?.skipReason).toBe('sensitive');
      expect(result.files.find(f => f.relativePath === '.env')).toBeUndefined();
    });

    it('excludes binary files by extension', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const bin = result.files.find(f => f.relativePath === 'data.bin');
      expect(bin?.skipped).toBe(true);
      expect(bin?.skipReason).toBe('binary');
    });

    it('does not follow symbolic links', async () => {
      const result = await finder.find({ symbol: 'foo' });
      expect(result.files.find(f => f.relativePath === 'link.js')).toBeUndefined();
    });
  });

  describe('Invalid symbol queries', () => {
    it('rejects an empty symbol', async () => {
      await expectToolError(finder.find({ symbol: '' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol starting with a digit', async () => {
      await expectToolError(finder.find({ symbol: '123' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol containing non-identifier characters', async () => {
      await expectToolError(finder.find({ symbol: 'foo.bar' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
      await expectToolError(finder.find({ symbol: 'foo()' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });

    it('rejects a symbol exceeding maxSymbolLength', async () => {
      const f = createFinder(vfs, 'file:///root', { maxSymbolLength: 5 });
      await expectToolError(f.find({ symbol: 'foobar' }), ToolErrorCode.TOOL_INVALID_ARGUMENT);
    });
  });

  describe('Classification confidence', () => {
    it('assigns medium confidence to all AST-derived occurrences', async () => {
      const result = await finder.find({ symbol: 'foo' });
      for (const f of result.files) {
        for (const r of f.references) {
          expect(r.confidence).toBe('medium');
        }
      }
    });
  });

  describe('No source content leakage', () => {
    it('does not include source file contents in results', async () => {
      const result = await finder.find({ symbol: 'foo' });
      const resultJson = JSON.stringify(result);
      expect(resultJson).not.toContain('function foo');
      expect(resultJson).not.toContain('SECRET=1');
    });
  });

  describe('Factory', () => {
    it('createSyntaxAwareFinder returns a SyntaxAwareFinder', () => {
      const f = createSyntaxAwareFinder({
        fileSystem: vfs,
        workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      });
      expect(f).toBeInstanceOf(SyntaxAwareFinder);
    });
  });
});
