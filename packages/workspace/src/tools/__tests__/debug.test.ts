import { describe, it } from 'vitest';
import { createLexicalFinder } from '../lexical-finder.js';
import type { WorkspaceFolder } from '../../types.js';
import { IgnoreEngine } from '../../ignore/ignore-engine.js';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return { id: 'w', uri, name, index: 0 };
}

class VFS {
  private files = new Map<string, string>();
  private stats = new Map<string, any>();
  private dirs = new Map<string, any[]>();
  private key(p: string): string {
    return p.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/\/+$/, '');
  }
  addFile(p: string, content: string): void {
    const k = this.key(p);
    this.files.set(k, content);
    this.stats.set(k, { type: 'file', size: Buffer.byteLength(content, 'utf8'), mtime: 0, ctime: 0 });
    const parts = k.split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/';
      if (!this.dirs.has(dir)) this.dirs.set(dir, []);
      if (!this.stats.has(dir)) this.stats.set(dir, { type: 'directory', size: 0, mtime: 0, ctime: 0 });
    }
    const p2 = k.split('/');
    const name = p2.pop()!;
    const parent = p2.join('/') || '/';
    const entries = this.dirs.get(parent)!;
    if (!entries.some((e: any) => e.name === name && e.type === 'file')) entries.push({ name, type: 'file' });
  }
  async readDirectory(uri: string) {
    const k = this.key(uri);
    const base = this.dirs.get(k);
    if (base === undefined) throw new Error('ENOENT dir ' + uri);
    return [...base];
  }
  async stat(uri: string) {
    const k = this.key(uri);
    const s = this.stats.get(k);
    if (!s) throw new Error('ENOENT stat ' + uri);
    return { ...s };
  }
  async lstat(uri: string) {
    const k = this.key(uri);
    const s = this.stats.get(k);
    if (!s) throw new Error('ENOENT lstat ' + uri);
    return { ...s };
  }
  async readFile(uri: string) {
    const k = this.key(uri);
    const c = this.files.get(k);
    if (c === undefined) throw new Error('ENOENT read ' + uri);
    return c;
  }
  async exists(uri: string) { return true; }
}

describe('debug', () => {
  it('dump', async () => {
    const vfs = new VFS();
    vfs.addFile('/root/a.js', 'foo()\nconst foo = 1;\nbar.foo\n');
    vfs.addFile('/root/b.ts', 'export const foo = 2;\n');
    vfs.addFile('/root/c.py', 'def foo():\n    return foo\n');
    vfs.addFile('/root/d.java', 'public class Foo { void foo() { foo(); } }\n');
    vfs.addFile('/root/e.go', 'package main\nfunc foo() {}\n');
    vfs.addFile('/root/sub/f.rb', 'def foo\n  puts foo\nend\n');
    vfs.addFile('/root/.env', 'SECRET=1\n');
    const ignoreEngine = new IgnoreEngine({
      fileSystem: vfs,
      workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      root: '/root',
      config: { enableMandatorySafetyExclusions: true, enableDefaultExclusions: true, userExclusions: [], caseSensitive: false },
    });
    await ignoreEngine.loadGitignore('/root');
    console.log('EXCLUDED .env:', ignoreEngine.isExcluded('.env', { isDirectory: false }).ignored);
    console.log('EXCLUDED sub/f.rb:', ignoreEngine.isExcluded('sub/f.rb', { isDirectory: false }).ignored);
    console.log('EXCLUDED sub (dir):', ignoreEngine.isExcluded('sub', { isDirectory: true }).ignored);
    const finder = createLexicalFinder({
      fileSystem: vfs,
      workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
    });
    const candidates = await (finder as any).searcher.getCandidates({});
    console.log('CANDIDATES:', candidates.candidates.map((c: any) => c.relPath), 'truncated=', candidates.truncated);
    console.log('READDIR /root:', JSON.stringify(await vfs.readDirectory('/root')));
    const result = await finder.find({ symbol: 'foo' });
    console.log('FILES:');
    for (const f of result.files) {
      console.log(f.relativePath, 'lang=', f.language, 'skipped=', f.skipped, 'reason=', f.skipReason, 'count=', f.referenceCount);
    }
    console.log('META:', JSON.stringify(result.metadata));
  });
});
