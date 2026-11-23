import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IgnoreEngine } from '../ignore-engine.js';
import type { FileSystemProvider, DirectoryEntry } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';

function makeEntry(name: string, type: DirectoryEntry['type']): DirectoryEntry {
  return { name, type };
}

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
  private dirs = new Map<string, DirectoryEntry[]>();
  private stats = new Map<string, { type: 'file' | 'directory' | 'symbolicLink'; size: number; mtime: number }>();
  private readonly rootPath: string;

  constructor(tree: Record<string, unknown>, rootPath: string) {
    this.rootPath = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
    this.build(tree, this.rootPath);
  }

  private build(node: Record<string, unknown>, prefix: string): void {
    const entries: DirectoryEntry[] = [];
    for (const [key, value] of Object.entries(node)) {
      const full = `${prefix}/${key}`;
      if (typeof value === 'string') {
        entries.push(makeEntry(key, 'file'));
        this.files.set(full, value);
        this.stats.set(full, { type: 'file', size: value.length, mtime: Date.now() });
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        entries.push(makeEntry(key, 'directory'));
        this.stats.set(full, { type: 'directory', size: 0, mtime: Date.now() });
        this.build(value as Record<string, unknown>, full);
      }
    }
    this.dirs.set(prefix, entries);
  }

  setStat(path: string, stat: { type: 'file' | 'directory' | 'symbolicLink'; size: number; mtime: number }): void {
    const key = path.replace(/\\/g, '/').replace(/\/+$/, '');
    this.stats.set(key, stat);
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.dirs.get(key) ?? [];
  }

  async stat(uri: string): Promise<{ type: 'file' | 'directory' | 'symbolicLink'; size: number; mtime: number; ctime: number }> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    const stat = this.stats.get(key);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory, stat '${uri}'`);
    }
    return { ...stat, ctime: stat.mtime };
  }

  async lstat(uri: string): Promise<{ type: 'file' | 'directory' | 'symbolicLink'; size: number; mtime: number; ctime: number }> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    const stat = this.stats.get(key);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory, lstat '${uri}'`);
    }
    return { ...stat, ctime: stat.mtime };
  }

  async readFile(uri: string): Promise<string> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    const content = this.files.get(key);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, read '${uri}'`);
    }
    return content;
  }

  async exists(uri: string): Promise<boolean> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.files.has(key) || this.stats.has(key);
  }
}

function createIgnoreEngine(vfs: VirtualFileSystem, root: string, opts?: Parameters<typeof IgnoreEngine>[0]['config']) {
  return new IgnoreEngine({
    fileSystem: vfs as unknown as FileSystemProvider,
    workspaceFolder: makeWorkspaceFolder(`file://${root}`, 'root'),
    root,
    config: opts,
  });
}

function makeVfs(tree: Record<string, unknown>, root: string = '/root'): VirtualFileSystem {
  return new VirtualFileSystem(tree, root);
}

describe('IgnoreEngine', () => {
  it('should exclude root .git directory (mandatory safety)', () => {
    const vfs = makeVfs({ '.git': { HEAD: 'ref' }, 'src': { 'main.ts': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root');
    expect(engine.isIgnored('.git', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('.git/HEAD')).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should exclude node_modules by default', () => {
    const vfs = makeVfs({ 'node_modules': { 'pkg': { 'index.js': 'x' } }, 'src': { 'main.ts': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root');
    expect(engine.isIgnored('node_modules', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('node_modules/pkg/index.js')).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should support user-defined exclusions', () => {
    const vfs = makeVfs({ 'secret': { 'key.txt': 'x' }, 'src': { 'main.ts': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root', { userExclusions: ['secret/'] });
    expect(engine.isIgnored('secret', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should load root .gitignore patterns', async () => {
    const vfs = makeVfs({
      '.gitignore': '*.log\ndist/\n!important.log',
      'app.log': 'log',
      'important.log': 'log',
      'dist': { 'bundle.js': 'x' },
      'src': { 'main.ts': 'x' },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    await engine.loadGitignore('/root');
    expect(engine.isIgnored('app.log')).toBe(true);
    expect(engine.isIgnored('important.log')).toBe(false);
    expect(engine.isIgnored('dist', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('dist/bundle.js')).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should apply nested .gitignore rules relative to their containing directory', async () => {
    const vfs = makeVfs({
      '.gitignore': 'ignored-by-root.txt\n',
      'sub': {
        '.gitignore': 'sub-only.log\n',
        'ignored-by-root.txt': 'x',
        'sub-only.log': 'x',
        'keep.log': 'x',
      },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    await engine.loadGitignore('/root');
    await engine.loadGitignore('/root/sub');
    // Root pattern applies at root and to descendants.
    expect(engine.isIgnored('ignored-by-root.txt')).toBe(true);
    expect(engine.isIgnored('sub/ignored-by-root.txt')).toBe(true);
    // Nested pattern applies relative to its directory.
    expect(engine.isIgnored('sub/sub-only.log')).toBe(true);
    // Nested pattern does not match other files in its directory.
    expect(engine.isIgnored('sub/keep.log')).toBe(false);
    // Unmatched files at root are not ignored.
    expect(engine.isIgnored('keep.log')).toBe(false);
  });

  it('should support negation patterns', () => {
    const vfs = makeVfs({
      'docs': { 'a.txt': 'a', 'b.txt': 'b', 'keep.txt': 'k' },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    engine.addUserExclusions(['docs/*.txt', '!docs/keep.txt']);
    expect(engine.isIgnored('docs/a.txt')).toBe(true);
    expect(engine.isIgnored('docs/b.txt')).toBe(true);
    expect(engine.isIgnored('docs/keep.txt')).toBe(false);
  });

  it('should support anchored patterns', () => {
    const vfs = makeVfs({
      'anchored.txt': 'x',
      'sub': { 'anchored.txt': 'x' },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    engine.addUserExclusions(['/anchored.txt']);
    expect(engine.isIgnored('anchored.txt')).toBe(true);
    expect(engine.isIgnored('sub/anchored.txt')).toBe(false);
  });

  it('should support directory-only patterns', () => {
    const vfs = makeVfs({
      'temp': { 'file.txt': 'x' },
      'temp.bak': 'y',
    });
    const engine = createIgnoreEngine(vfs, '/root');
    engine.addUserExclusions(['temp/']);
    expect(engine.isIgnored('temp', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('temp/file.txt')).toBe(true);
    expect(engine.isIgnored('temp.bak')).toBe(false);
  });

  it('should support wildcard and recursive patterns', () => {
    const vfs = makeVfs({
      'secrets': { 'key.pem': 'k' },
      'a': { 'secrets': { 'key.pem': 'k' } },
      'src': { 'main.ts': 'x' },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    engine.addUserExclusions(['**/secrets/']);
    expect(engine.isIgnored('secrets', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('secrets/key.pem')).toBe(true);
    expect(engine.isIgnored('a/secrets', { isDirectory: true })).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should treat excluded parent directory as excluding children', () => {
    const vfs = makeVfs({
      'node_modules': { 'pkg': { 'deep': { 'file.js': 'x' } } },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    expect(engine.isIgnored('node_modules/pkg/deep/file.js')).toBe(true);
  });

  it('should not crash on malformed ignore file content', async () => {
    const vfs = makeVfs({
      '.gitignore': '',
      'src': { 'main.ts': 'x' },
    });
    const engine = createIgnoreEngine(vfs, '/root');
    const loaded = await engine.loadGitignore('/root');
    expect(loaded).toBe(true);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should handle unreadable ignore file without aborting', async () => {
    const vfs = makeVfs({ 'src': { 'main.ts': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root');
    const loaded = await engine.loadGitignore('/root');
    expect(loaded).toBe(false);
    expect(engine.isIgnored('src/main.ts')).toBe(false);
  });

  it('should support multiple workspace roots with independent rules', () => {
    const rootA = createIgnoreEngine(
      makeVfs({ 'node_modules': { 'x.js': 'x' }, 'secret': { 'key.txt': 'x' } }),
      '/rootA',
      { userExclusions: ['secret/'] }
    );
    const rootB = createIgnoreEngine(
      makeVfs({ 'src': { 'main.ts': 'x' }, 'secret': { 'key.txt': 'x' } }),
      '/rootB'
    );
    // Default exclusions apply to both engines.
    expect(rootA.isIgnored('node_modules', { isDirectory: true })).toBe(true);
    expect(rootB.isIgnored('node_modules', { isDirectory: true })).toBe(true);
    // User exclusions are independent per workspace root.
    expect(rootA.isIgnored('secret', { isDirectory: true })).toBe(true);
    expect(rootB.isIgnored('secret', { isDirectory: true })).toBe(false);
    expect(rootB.isIgnored('src/main.ts')).toBe(false);
  });

  it('should report exclusion reason and precedence', () => {
    const vfs = makeVfs({ '.env': 'secret', 'src': { 'main.ts': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root', { userExclusions: ['.env'] });
    const result = engine.isExcluded('.env');
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe('user');
  });

  it('should give mandatory safety exclusions precedence over user re-inclusion', () => {
    const vfs = makeVfs({ '.git': { 'config': 'x' } });
    const engine = createIgnoreEngine(vfs, '/root', { userExclusions: ['!/.git'] });
    const result = engine.isExcluded('.git', { isDirectory: true });
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe('mandatory');
  });

  it('should give default exclusions precedence over user re-inclusion', () => {
    const vfs = makeVfs({ 'node_modules': { 'pkg': { 'index.js': 'x' } } });
    const engine = createIgnoreEngine(vfs, '/root', { userExclusions: ['!node_modules/'] });
    const result = engine.isExcluded('node_modules', { isDirectory: true });
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe('default');
  });

  it('should give gitignore exclusions precedence over user re-inclusion', async () => {
    const vfs = makeVfs({
      '.gitignore': '*.log\n',
      'app.log': 'log',
    });
    const engine = createIgnoreEngine(vfs, '/root', { userExclusions: ['!app.log'] });
    await engine.loadGitignore('/root');
    const result = engine.isExcluded('app.log');
    expect(result.ignored).toBe(true);
    expect(result.reason).toBe('gitignore');
  });

  it('should enforce full precedence chain mandatory > default > gitignore > user', async () => {
    const vfs = makeVfs({
      '.gitignore': 'secret.txt\n',
      'secret.txt': 's',
      'node_modules': { 'pkg': { 'index.js': 'x' } },
    });
    const engine = createIgnoreEngine(vfs, '/root', {
      userExclusions: ['!secret.txt', '!node_modules/'],
    });
    await engine.loadGitignore('/root');

    // User cannot re-include a gitignore-excluded file.
    expect(engine.isExcluded('secret.txt').ignored).toBe(true);
    expect(engine.isExcluded('secret.txt').reason).toBe('gitignore');

    // User cannot re-include a default-excluded directory.
    expect(engine.isExcluded('node_modules', { isDirectory: true }).ignored).toBe(true);
    expect(engine.isExcluded('node_modules', { isDirectory: true }).reason).toBe('default');

    // Mandatory safety still wins over everything.
    expect(engine.isExcluded('.git', { isDirectory: true }).ignored).toBe(true);
    expect(engine.isExcluded('.git', { isDirectory: true }).reason).toBe('mandatory');
  });
});
