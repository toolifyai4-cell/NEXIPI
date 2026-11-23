import { describe, it, expect, vi } from 'vitest';
import { MonorepoPackageExpander } from '../monorepo-package-expander.js';
import type { FileSystemProvider, DirectoryEntry } from '../../discovery/workspace-provider.js';
import { IgnoreEngine } from '../../ignore/ignore-engine.js';
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

  constructor(tree: Record<string, unknown>, rootPath: string) {
    this.build(tree, rootPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  }

  private build(node: Record<string, unknown>, prefix: string): void {
    const entries: DirectoryEntry[] = [];
    for (const [key, value] of Object.entries(node)) {
      const full = `${prefix}/${key}`;
      if (typeof value === 'string') {
        entries.push(makeEntry(key, 'file'));
        this.files.set(full, value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        entries.push(makeEntry(key, 'directory'));
        this.build(value as Record<string, unknown>, full);
      }
    }
    this.dirs.set(prefix, entries);
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const key = uri.replace(/\\/g, '/').replace(/\/+$/, '');
    return this.dirs.get(key) ?? [];
  }

  async stat(): Promise<{ type: 'file' | 'directory' | 'symbolicLink'; size: number; mtime: number; ctime: number }> {
    return { type: 'file', size: 0, mtime: Date.now(), ctime: Date.now() };
  }

  async readFile(): Promise<string> {
    return '{}';
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

function makeVfs(tree: Record<string, unknown>, rootUri: string = 'file:///root'): VirtualFileSystem {
  return new VirtualFileSystem(tree, rootUri.replace(/^file:\/\//, '').replace(/\/+$/, ''));
}

function createExpander(
  vfs: VirtualFileSystem,
  rootUri: string,
  patterns: string[],
  opts?: { signal?: AbortSignal; ignoreEngine?: IgnoreEngine },
) {
  return new MonorepoPackageExpander({
    fileSystem: vfs as unknown as FileSystemProvider,
    workspaceFolder: makeWorkspaceFolder(rootUri, 'root'),
    monorepoRootPath: rootUri.replace(/^file:\/\//, ''),
    patterns,
    ignoreEngine: opts?.ignoreEngine,
    signal: opts?.signal,
  });
}

describe('MonorepoPackageExpander', () => {
  it('should expand pnpm workspace patterns', async () => {
    const vfs = makeVfs({
      packages: { 'pkg-a': { 'package.json': '{}' }, 'pkg-b': { 'package.json': '{}' } },
      apps: { 'web': { 'package.json': '{}' } },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/*', 'apps/*']);
    const result = await expander.expand();
    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.count).toBe(3);
    const paths = result.packages.map((p) => p.relativePath).sort();
    expect(paths).toEqual(['apps/web', 'packages/pkg-a', 'packages/pkg-b']);
  });

  it('should expand npm/yarn workspace patterns', async () => {
    const vfs = makeVfs({
      packages: { 'core': { 'package.json': '{}' }, 'ui': { 'package.json': '{}' } },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/*']);
    const result = await expander.expand();
    expect(result.count).toBe(2);
    expect(result.packages.map((p) => p.name)).toEqual(['core', 'ui']);
  });

  it('should expand nested packages with **', async () => {
    const vfs = makeVfs({
      packages: {
        'scope': { 'pkg-a': { 'package.json': '{}' } },
        'pkg-b': { 'package.json': '{}' },
      },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/**']);
    const result = await expander.expand();
    const paths = result.packages.map((p) => p.relativePath).sort();
    expect(paths).toEqual([
      'packages',
      'packages/pkg-b',
      'packages/scope',
      'packages/scope/pkg-a',
    ]);
  });

  it('should expand multiple package patterns', async () => {
    const vfs = makeVfs({
      packages: { 'a': { 'package.json': '{}' } },
      apps: { 'b': { 'package.json': '{}' } },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/*', 'apps/*']);
    const result = await expander.expand();
    expect(result.count).toBe(2);
  });

  it('should respect excluded package directories via ignore', async () => {
    const vfs = makeVfs({
      packages: { 'a': { 'package.json': '{}' }, 'node_modules': { 'x': { 'package.json': '{}' } } },
    });
    const ignoreEngine = new IgnoreEngine({
      fileSystem: vfs as unknown as FileSystemProvider,
      workspaceFolder: makeWorkspaceFolder('file:///root', 'root'),
      root: '/root',
      config: { enableMandatorySafetyExclusions: false, enableDefaultExclusions: false, userExclusions: ['node_modules/'] },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/*'], { ignoreEngine });
    const result = await expander.expand();
    expect(result.count).toBe(1);
    expect(result.packages[0].relativePath).toBe('packages/a');
  });

  it('should handle missing package directories safely', async () => {
    const vfs = makeVfs({});
    const expander = createExpander(vfs, 'file:///root', ['packages/*', 'apps/*']);
    const result = await expander.expand();
    expect(result.count).toBe(0);
    expect(result.completed).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should avoid duplicate matches', async () => {
    const vfs = makeVfs({
      packages: { 'a': { 'package.json': '{}' } },
    });
    const expander = createExpander(vfs, 'file:///root', ['packages/*', 'packages/*']);
    const result = await expander.expand();
    expect(result.count).toBe(1);
  });

  it('should reject invalid path traversal patterns', async () => {
    const vfs = makeVfs({ 'src': { 'main.ts': 'x' } });
    const expander = createExpander(vfs, 'file:///root', ['../outside/*']);
    const result = await expander.expand();
    expect(result.count).toBe(0);
    expect(result.errors.some((e) => e.message.includes('escapes'))).toBe(true);
  });

  it('should support cancellation', async () => {
    const tree: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      tree[`pkg${i}`] = { 'package.json': '{}' };
    }
    const vfs = makeVfs(tree);
    const controller = new AbortController();
    controller.abort();
    const expander = createExpander(vfs, 'file:///root', ['*'], { signal: controller.signal });
    const result = await expander.expand();
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
  });

  it('should preserve workspace and project relationships', async () => {
    const vfs = makeVfs({ 'packages': { 'a': { 'package.json': '{}' } } });
    const expander = createExpander(vfs, 'file:///root', ['packages/*']);
    const result = await expander.expand();
    expect(result.packages[0].workspaceFolderId).toBeDefined();
    expect(result.packages[0].matchedPattern).toBe('packages/*');
  });
});
