import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManifestRegistry } from '../manifest-registry.js';
import type { FileSystemProvider } from '../../discovery/workspace-provider.js';

function createMockFileSystem(files: Map<string, string> = new Map(), dirs: Map<string, string[]> = new Map()) {
  return {
    readFile: vi.fn((uri: string) => Promise.resolve(files.get(uri) ?? '')),
    readDirectory: vi.fn((uri: string) => {
      const entries = dirs.get(uri) ?? [];
      return Promise.resolve(entries.map((name) => ({ name, type: 'file' as const })));
    }),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtime: Date.now(), ctime: Date.now() }),
    exists: vi.fn((uri: string) => Promise.resolve(files.has(uri))),
  };
}

describe('ManifestRegistry', () => {
  let mockFileSystem: ReturnType<typeof createMockFileSystem>;
  let registry: ManifestRegistry;

  beforeEach(() => {
    mockFileSystem = createMockFileSystem();
    registry = new ManifestRegistry();
  });

  it('should have all default parsers registered', () => {
    const types = registry.getAllManifestTypes();
    expect(types).toContain('package.json');
    expect(types).toContain('pnpm-workspace.yaml');
    expect(types).toContain('lerna.json');
    expect(types).toContain('nx.json');
    expect(types).toContain('turbo.json');
    expect(types).toContain('Cargo.toml');
    expect(types).toContain('go.mod');
    expect(types).toContain('pyproject.toml');
    expect(types).toContain('requirements.txt');
    expect(types).toContain('pom.xml');
    expect(types).toContain('build.gradle');
    expect(types).toContain('build.gradle.kts');
    expect(types).toContain('composer.json');
    expect(types).toContain('Gemfile');
    expect(types).toContain('csproj');
    expect(types).toContain('sln');
  });

  it('should discover manifests in directory', async () => {
    const packageJson = JSON.stringify({ name: 'test' });
    const cargoToml = '[package]\nname = "rust-test"';

    mockFileSystem = createMockFileSystem(
      new Map([
        ['/project/package.json', packageJson],
        ['/project/Cargo.toml', cargoToml],
      ]),
      new Map([['/project', ['package.json', 'Cargo.toml']]])
    );

    const manifests = await registry.discoverManifests('/project', mockFileSystem, 3);

    expect(manifests).toHaveLength(2);
    expect(manifests.find((m) => m.type === 'package.json')).toBeDefined();
    expect(manifests.find((m) => m.type === 'Cargo.toml')).toBeDefined();
  });

  it('should skip excluded directories', async () => {
    const packageJson = JSON.stringify({ name: 'test' });
    const nestedPackageJson = JSON.stringify({ name: 'nested' });

    mockFileSystem = createMockFileSystem(
      new Map([
        ['/project/package.json', packageJson],
        ['/project/node_modules/some-package/package.json', nestedPackageJson],
      ]),
      new Map([
        ['/project', ['package.json', 'node_modules']],
        ['/project/node_modules', ['some-package']],
        ['/project/node_modules/some-package', ['package.json']],
      ])
    );

    const manifests = await registry.discoverManifests('/project', mockFileSystem, 3);

    expect(manifests).toHaveLength(1);
    expect(manifests[0].path).toBe('/project/package.json');
  });

  it('should respect maxDepth', async () => {
    const packageJson = JSON.stringify({ name: 'test' });

    const dirs = new Map<string, string[]>();
    let current = '/deep';
    for (let i = 0; i < 5; i++) {
      dirs.set(current, i === 4 ? ['package.json'] : [`level${i + 1}`]);
      current = `${current}/level${i + 1}`;
    }

    const files = new Map<string, string>();
    current = '/deep';
    for (let i = 0; i < 5; i++) {
      current = `${current}/level${i + 1}`;
    }
    files.set(`${current}/package.json`, packageJson);

    mockFileSystem = createMockFileSystem(files, dirs);

    const manifests = await registry.discoverManifests('/deep', mockFileSystem, 3);

    expect(manifests).toHaveLength(0);
  });

  it('should parse package.json with workspace config', async () => {
    const packageJson = JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: { packages: ['packages/*', 'apps/*'] },
      catalogs: { react: '18.2.0' },
    });

    mockFileSystem = createMockFileSystem(
      new Map([['/ws/package.json', packageJson]]),
      new Map([['/ws', ['package.json']]])
    );

    const manifests = await registry.discoverManifests('/ws', mockFileSystem, 3);
    const manifest = manifests.find((m) => m.type === 'package.json');

    expect(manifest).toBeDefined();
    expect(manifest?.rawData).toBeDefined();
    const rawData = manifest?.rawData as { workspaces?: { packages?: string[] }; catalogs?: Record<string, string> };
    expect(rawData.workspaces?.packages).toEqual(['packages/*', 'apps/*']);
    expect(rawData.catalogs?.react).toBe('18.2.0');
  });

  it('should allow custom parser registration', () => {
    const customParser = {
      type: 'custom.manifest' as const,
      projectType: 'custom' as const,
      parse: vi.fn().mockReturnValue({ name: 'custom' }),
    };

    registry.register(customParser);

    expect(registry.hasParser('custom.manifest')).toBe(true);
    expect(registry.getParser('custom.manifest')).toBe(customParser);
  });
});