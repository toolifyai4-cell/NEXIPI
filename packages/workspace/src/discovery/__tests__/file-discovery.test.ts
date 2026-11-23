import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileDiscoveryService } from '../file-discovery.js';
import type { FileSystemProvider, DirectoryEntry, FileStat } from '../../discovery/workspace-provider.js';
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

interface StatLike {
  type: 'file' | 'directory' | 'symbolicLink';
  size: number;
  mtime: number;
}

class VirtualFileSystem implements FileSystemProvider {
  private files = new Map<string, string>();
  private dirs = new Map<string, DirectoryEntry[]>();
  private stats = new Map<string, StatLike & { ctime: number }>();
  private symlinks = new Set<string>();
  private readonly rootPath: string;

  constructor(tree: Record<string, unknown>, rootPath: string) {
    this.rootPath = rootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    this.build(tree, this.rootPath);
  }

  private build(node: Record<string, unknown>, prefix: string): void {
    const entries: DirectoryEntry[] = [];
    for (const [key, value] of Object.entries(node)) {
      const full = `${prefix}/${key}`;
      if (typeof value === 'string') {
        entries.push(makeEntry(key, 'file'));
        this.files.set(full, value);
        this.stats.set(full, { type: 'file', size: value.length, mtime: Date.now(), ctime: Date.now() });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const type = this.symlinks.has(full) ? 'symbolicLink' : 'directory';
        entries.push(makeEntry(key, type));
        this.stats.set(full, { type, size: 0, mtime: Date.now(), ctime: Date.now() });
        if (type !== 'symbolicLink') {
          this.build(value as Record<string, unknown>, full);
        }
      }
    }
    this.dirs.set(prefix, entries);
  }

  setStat(path: string, stat: StatLike): void {
    const key = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    this.stats.set(key, { ...stat, ctime: stat.mtime });
    if (stat.type === 'symbolicLink') {
      this.symlinks.add(key);
    } else {
      this.symlinks.delete(key);
    }
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const base = this.dirs.get(key) ?? [];
    if (base.length === 0 && !this.dirs.has(key)) {
      return [];
    }
    return base.map((e) => {
      const full = key ? `${key}/${e.name}` : e.name;
      if (this.symlinks.has(full)) {
        return { ...e, type: 'symbolicLink' as DirectoryEntry['type'] };
      }
      return e;
    });
  }

  async stat(uri: string): Promise<FileStat> {
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const stat = this.stats.get(key);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory, stat '${uri}'`);
    }
    return { ...stat };
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

function createService(
  vfs: VirtualFileSystem,
  rootUri: string,
  opts?: { maxDepth?: number; maxFileCount?: number; followSymlinks?: boolean; includeHidden?: boolean; signal?: AbortSignal },
) {
  return new FileDiscoveryService({
    fileSystem: vfs as unknown as FileSystemProvider,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    config: opts,
    signal: opts?.signal,
  });
}

function makeVfs(tree: Record<string, unknown>, rootUri: string = 'file:///root'): VirtualFileSystem {
  return new VirtualFileSystem(tree, rootUri.replace(/^file:\/\//, '').replace(/^\/+/, '').replace(/\/+$/, ''));
}

describe('FileDiscoveryService', () => {
  it('should discover empty workspace', async () => {
    const vfs = makeVfs({});
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.files).toHaveLength(0);
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('should discover empty folder', async () => {
    const vfs = makeVfs({ 'emptydir': {} });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.files).toHaveLength(0);
    expect(result.completed).toBe(true);
  });

  it('should discover single-root files', async () => {
    const vfs = makeVfs({
      'src': { 'main.ts': 'x', 'utils.ts': 'y' },
      'README.md': 'readme',
    });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.files.length).toBe(3);
    const paths = result.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(['README.md', 'src/main.ts', 'src/utils.ts']);
  });

  it('should preserve workspace folder relationship', async () => {
    const vfs = makeVfs({ 'src': { 'main.ts': 'x' } });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    for (const f of result.files) {
      expect(f.workspaceFolderId).toBe(service['workspaceFolder'].id);
      expect(f.workspaceId).toBe(result.workspaceId);
      expect(f.absolutePath.startsWith('/root/')).toBe(true);
    }
  });

  it('should discover multi-root files independently', async () => {
    const vfsA = makeVfs({ 'a.ts': 'x' }, 'file:///rootA');
    const vfsB = makeVfs({ 'b.ts': 'y' }, 'file:///rootB');
    const serviceA = createService(vfsA, 'file:///rootA');
    const serviceB = createService(vfsB, 'file:///rootB');
    const resultA = await serviceA.discover();
    const resultB = await serviceB.discover();
    expect(resultA.files.map((f) => f.relativePath)).toEqual(['a.ts']);
    expect(resultB.files.map((f) => f.relativePath)).toEqual(['b.ts']);
    expect(resultA.workspaceId).not.toBe(resultB.workspaceId);
  });

  it('should respect maximum depth', async () => {
    const tree: Record<string, unknown> = {};
    let cur: Record<string, unknown> = tree;
    for (let i = 1; i <= 5; i++) {
      cur[`level${i}`] = {};
      cur = cur[`level${i}`] as Record<string, unknown>;
    }
    (cur as Record<string, unknown>)['deep.txt'] = 'deep';
    const vfs = makeVfs(tree);
    const service = createService(vfs, 'file:///root', { maxDepth: 2 });
    const result = await service.discover();
    // maxDepth 2: root->level1 (depth1), level1->level2 (depth2). level2->level3 would be depth3 > 2.
    const depths = result.files.map((f) => f.relativePath.split('/').length);
    expect(Math.max(...depths, 0)).toBeLessThanOrEqual(2);
  });

  it('should respect maximum file count', async () => {
    const tree: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      tree[`file${i}.txt`] = 'x';
    }
    const vfs = makeVfs(tree);
    const service = createService(vfs, 'file:///root', { maxFileCount: 5 });
    const result = await service.discover();
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('should prevent duplicate paths', async () => {
    const vfs = makeVfs({
      'dup': { 'file.txt': 'x' },
      'file.txt': 'y',
    });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    const paths = result.files.map((f) => f.relativePath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('dup/file.txt');
    expect(paths).toContain('file.txt');
  });

  it('should handle inaccessible directories without aborting', async () => {
    const vfs = makeVfs({
      'good': { 'file.txt': 'x' },
      'bad': { 'secret.txt': 'x' },
    });
    // Make readDirectory for 'bad' throw by removing it after construction is not supported;
    // instead simulate via a custom fs.
    const customFs: FileSystemProvider = {
      readDirectory: vi.fn(async (uri: string) => {
        if (uri.includes('/bad')) {
          throw new Error('EACCES: permission denied');
        }
        return vfs.readDirectory(uri);
      }),
      stat: vi.fn(async (uri: string) => vfs.stat(uri)),
      readFile: vi.fn(async (uri: string) => vfs.readFile(uri)),
      exists: vi.fn(async (uri: string) => vfs.exists(uri)),
    };
    const service = new FileDiscoveryService({
      fileSystem: customFs,
      workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
    });
    const result = await service.discover();
    expect(result.completed).toBe(true);
    expect(result.files.some((f) => f.relativePath === 'good/file.txt')).toBe(true);
    expect(result.errors.some((e) => e.path.includes('bad'))).toBe(true);
  });

  it('should support cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const tree: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      tree[`file${i}.txt`] = 'x';
    }
    const vfs = makeVfs(tree);
    controller.abort();
    const service = createService(vfs, 'file:///root', { signal: controller.signal });
    const result = await service.discover();
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
  });

  it('should not follow symbolic links by default', async () => {
    const vfs = makeVfs({
      'link': { 'target.txt': 'x' },
      'src': { 'main.ts': 'x' },
    });
    vfs.setStat('/root/link', { type: 'symbolicLink', size: 0, mtime: Date.now() });
    const service = createService(vfs, 'file:///root', { followSymlinks: false });
    const result = await service.discover();
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).not.toContain('link/target.txt');
    expect(paths).toContain('src/main.ts');
  });

  it('should protect workspace boundary (no traversal outside root)', async () => {
    const vfs = makeVfs({ 'src': { 'main.ts': 'x' } });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.completed).toBe(true);
    for (const f of result.files) {
      expect(f.absolutePath.startsWith('/root')).toBe(true);
    }
  });

  it('should produce deterministic ordering', async () => {
    const vfs = makeVfs({
      'z.txt': 'z',
      'a.txt': 'a',
      'm': { 'b.txt': 'b', 'a.txt': 'a' },
    });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).toEqual([...paths].sort());
  });

  it('should handle unknown file extensions safely', async () => {
    const vfs = makeVfs({ 'weird.xyz': 'x', 'noext': 'y' });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.files.length).toBe(2);
    for (const f of result.files) {
      expect(f.extension).toBeDefined();
      expect(f.category).toBeDefined();
    }
  });

  it('should handle nested directories', async () => {
    const vfs = makeVfs({
      'src': { 'components': { 'Button.ts': 'x', 'Input.ts': 'y' }, 'main.ts': 'z' },
    });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.files.length).toBe(3);
    expect(result.files.map((f) => f.relativePath).sort()).toEqual([
      'src/components/Button.ts',
      'src/components/Input.ts',
      'src/main.ts',
    ]);
  });

  it('should handle folders containing no eligible files', async () => {
    const vfs = makeVfs({
      'emptydir': {},
      'src': { 'main.ts': 'x' },
    });
    const service = createService(vfs, 'file:///root');
    const result = await service.discover();
    expect(result.files.length).toBe(1);
    expect(result.completed).toBe(true);
  });
});
