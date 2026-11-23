import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonorepoDetector } from '../monorepo-detector.js';
import { ManifestRegistry } from '../manifest-registry.js';
import type { FileSystemProvider } from '../../discovery/workspace-provider.js';

function createMockFileSystem(files: Map<string, string> = new Map(), dirs: Map<string, { name: string; type: 'file' | 'directory' }[]> = new Map()) {
  return {
    readFile: vi.fn((uri: string) => Promise.resolve(files.get(uri) ?? '')),
    readDirectory: vi.fn((uri: string) => {
      const entries = dirs.get(uri) ?? [];
      return Promise.resolve(entries);
    }),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtime: Date.now(), ctime: Date.now() }),
    exists: vi.fn((uri: string) => Promise.resolve(files.has(uri))),
  };
}

function createDirMap(entries: [string, { name: string; type: 'file' | 'directory' }[]][]): Map<string, { name: string; type: 'file' | 'directory' }[]> {
  const map = new Map<string, { name: string; type: 'file' | 'directory' }[]>();
  for (const [key, value] of entries) {
    map.set(key, value);
  }
  return map;
}

function createFileMap(entries: [string, string][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of entries) {
    map.set(key, value);
  }
  return map;
}

describe('MonorepoDetector', () => {
  let mockFileSystem: ReturnType<typeof createMockFileSystem>;
  let manifestRegistry: ManifestRegistry;
  let detector: MonorepoDetector;

  beforeEach(() => {
    manifestRegistry = new ManifestRegistry();
    mockFileSystem = createMockFileSystem();
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry, maxDepth: 5 });
  });

  it('should detect pnpm workspace', async () => {
    const pnpmWorkspace = `packages:
  - packages/*
  - apps/*`;

    mockFileSystem = createMockFileSystem(
      new Map([['/pnpm-mono/pnpm-workspace.yaml', pnpmWorkspace]]),
      new Map([['/pnpm-mono', [{ name: 'pnpm-workspace.yaml', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/pnpm-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('pnpm');
    expect(result.monorepoInfo?.config?.packages).toEqual(['packages/*', 'apps/*']);
    expect(result.allDetectedTypes).toContain('pnpm');
  });

  it('should detect lerna monorepo', async () => {
    const lernaJson = JSON.stringify({
      packages: ['packages/*'],
      version: 'independent',
    });

    mockFileSystem = createMockFileSystem(
      new Map([['/lerna-mono/lerna.json', lernaJson]]),
      new Map([['/lerna-mono', [{ name: 'lerna.json', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/lerna-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('lerna');
    expect(result.allDetectedTypes).toContain('lerna');
  });

  it('should detect nx workspace', async () => {
    const nxJson = JSON.stringify({ namedInputs: { default: ['{projectRoot}/**/*'] } });

    mockFileSystem = createMockFileSystem(
      new Map([['/nx-mono/nx.json', nxJson]]),
      new Map([['/nx-mono', [{ name: 'nx.json', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/nx-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('nx');
    expect(result.allDetectedTypes).toContain('nx');
  });

  it('should detect turborepo', async () => {
    const turboJson = JSON.stringify({ pipeline: { build: { dependsOn: ['^build'] } } });

    mockFileSystem = createMockFileSystem(
      new Map([['/turbo-mono/turbo.json', turboJson]]),
      new Map([['/turbo-mono', [{ name: 'turbo.json', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/turbo-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('turbo');
    expect(result.allDetectedTypes).toContain('turbo');
  });

  it('should detect yarn workspaces', async () => {
    const packageJson = JSON.stringify({
      name: 'yarn-mono',
      private: true,
      workspaces: ['packages/*'],
    });
    const yarnWorkspaces = `packages:
  - packages/*`;

    mockFileSystem = createMockFileSystem(
      new Map([
        ['/yarn-mono/package.json', packageJson],
        ['/yarn-mono/yarn.workspaces', yarnWorkspaces],
      ]),
      new Map([['/yarn-mono', [{ name: 'package.json', type: 'file' }, { name: 'yarn.workspaces', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/yarn-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('yarn');
    expect(result.allDetectedTypes).toContain('yarn');
  });

  it('should detect npm workspaces from package.json', async () => {
    const packageJson = JSON.stringify({
      name: 'npm-mono',
      private: true,
      workspaces: ['packages/*'],
    });

    mockFileSystem = createMockFileSystem(
      new Map([['/npm-mono/package.json', packageJson]]),
      new Map([['/npm-mono', [{ name: 'package.json', type: 'file' }]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/npm-mono');

    expect(result.detected).toBe(true);
    expect(result.monorepoInfo?.type).toBe('npm');
    expect(result.allDetectedTypes).toContain('npm');
  });

  it('should detect multiple monorepo tools simultaneously', async () => {
    const pnpmWorkspace = `packages:
  - packages/*`;
    const turboJson = JSON.stringify({ pipeline: { build: {} } });
    const nxJson = JSON.stringify({});

    mockFileSystem = createMockFileSystem(
      new Map([
        ['/multi/pnpm-workspace.yaml', pnpmWorkspace],
        ['/multi/turbo.json', turboJson],
        ['/multi/nx.json', nxJson],
      ]),
      new Map([['/multi', ['pnpm-workspace.yaml', 'turbo.json', 'nx.json']]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/multi');

    expect(result.detected).toBe(true);
    expect(result.allDetectedTypes).toContain('pnpm');
    expect(result.allDetectedTypes).toContain('turbo');
    expect(result.allDetectedTypes).toContain('nx');
    expect(result.monorepoInfo?.type).toBe('pnpm');
  });

  it('should return not detected for regular project', async () => {
    const packageJson = JSON.stringify({ name: 'regular-project', version: '1.0.0' });

    mockFileSystem = createMockFileSystem(
      new Map([['/regular/package.json', packageJson]]),
      new Map([['/regular', ['package.json']]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/regular');

    expect(result.detected).toBe(false);
    expect(result.allDetectedTypes).toHaveLength(0);
  });

  it('should detect multiple roots', async () => {
    const pnpmWorkspace = `packages:
  - packages/*`;
    const turboJson = JSON.stringify({ pipeline: {} });

    mockFileSystem = createMockFileSystem(
      new Map([
        ['/root1/pnpm-workspace.yaml', pnpmWorkspace],
        ['/root2/turbo.json', turboJson],
      ]),
      new Map([
        ['/root1', ['pnpm-workspace.yaml']],
        ['/root2', ['turbo.json']],
      ])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const results = await detector.detectMultiple(['/root1', '/root2']);

    expect(results.size).toBe(2);
    expect(results.get('/root1')?.detected).toBe(true);
    expect(results.get('/root1')?.monorepoInfo?.type).toBe('pnpm');
    expect(results.get('/root2')?.detected).toBe(true);
    expect(results.get('/root2')?.monorepoInfo?.type).toBe('turbo');
  });

  it('should handle missing root gracefully', async () => {
    mockFileSystem = createMockFileSystem(new Map(), new Map());
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/nonexistent');

    expect(result.detected).toBe(false);
  });

  it('should include manifest paths in result', async () => {
    const pnpmWorkspace = `packages: []`;

    mockFileSystem = createMockFileSystem(
      new Map([['/mono/pnpm-workspace.yaml', pnpmWorkspace]]),
      new Map([['/mono', ['pnpm-workspace.yaml']]])
    );
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry });

    const result = await detector.detect('/mono');

    expect(result.manifestPaths).toContain('/mono/pnpm-workspace.yaml');
  });

  it('should respect maxDepth', async () => {
    const pnpmWorkspace = `packages: []`;

    const dirs = new Map<string, string[]>();
    let current = '/deep';
    for (let i = 0; i < 10; i++) {
      dirs.set(current, i === 9 ? ['pnpm-workspace.yaml'] : [`level${i + 1}`]);
      current = `${current}/level${i + 1}`;
    }

    const files = new Map<string, string>();
    current = '/deep';
    for (let i = 0; i < 10; i++) {
      current = `${current}/level${i + 1}`;
    }
    files.set(`${current}/pnpm-workspace.yaml`, pnpmWorkspace);

    mockFileSystem = createMockFileSystem(files, dirs);
    detector = new MonorepoDetector({ fileSystem: mockFileSystem, manifestRegistry, maxDepth: 3 });

    const result = await detector.detect('/deep');

    expect(result.detected).toBe(false);
  });
});