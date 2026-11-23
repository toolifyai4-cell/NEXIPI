import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectAnalyzer } from '../project-analyzer.js';
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

describe('ProjectAnalyzer', () => {
  let mockFileSystem: ReturnType<typeof createMockFileSystem>;
  let manifestRegistry: ManifestRegistry;
  let analyzer: ProjectAnalyzer;

  beforeEach(() => {
    manifestRegistry = new ManifestRegistry();
    mockFileSystem = createMockFileSystem();
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
      config: { enabled: true, maxDepth: 5, detectLanguages: true, detectFrameworks: true, detectMonorepos: true, parseManifests: true, includeRawManifestData: false },
    });
  });

  it('should analyze Node.js project with package.json', async () => {
    const packageJson = JSON.stringify({
      name: 'my-node-project',
      version: '1.0.0',
      dependencies: { express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0' },
    });

    mockFileSystem = createMockFileSystem(
      createFileMap([['/project/package.json', packageJson]]),
      createDirMap([['/project', [{ name: 'package.json', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/project']);

    expect(roots).toHaveLength(1);
    expect(roots[0].path).toBe('/project');
    expect(roots[0].name).toBe('my-node-project');
    expect(roots[0].type).toBe('npm');
    expect(roots[0].languages).toContain('javascript');
    expect(roots[0].languages).toContain('typescript');
    expect(roots[0].frameworks).toContain('express');
  });

  it('should analyze pnpm monorepo', async () => {
    const pnpmWorkspace = `packages:
  - packages/*
  - apps/*`;
    const packageJson = JSON.stringify({ name: 'monorepo-root', private: true });

    mockFileSystem = createMockFileSystem(
      createFileMap([
        ['/monorepo/pnpm-workspace.yaml', pnpmWorkspace],
        ['/monorepo/package.json', packageJson],
      ]),
      createDirMap([['/monorepo', [{ name: 'pnpm-workspace.yaml', type: 'file' }, { name: 'package.json', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/monorepo']);

    expect(roots).toHaveLength(1);
    expect(roots[0].isMonorepoRoot).toBe(true);
    expect(roots[0].monorepoInfo?.type).toBe('pnpm');
    expect(roots[0].monorepoInfo?.config?.packages).toEqual(['packages/*', 'apps/*']);
  });

  it('should analyze Turborepo project', async () => {
    const turboJson = JSON.stringify({
      pipeline: { build: { dependsOn: ['^build'] } },
    });
    const packageJson = JSON.stringify({ name: 'turbo-root', private: true });

    mockFileSystem = createMockFileSystem(
      createFileMap([
        ['/turbo/turbo.json', turboJson],
        ['/turbo/package.json', packageJson],
      ]),
      createDirMap([['/turbo', [{ name: 'turbo.json', type: 'file' }, { name: 'package.json', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/turbo']);

    expect(roots).toHaveLength(1);
    expect(roots[0].isMonorepoRoot).toBe(true);
    expect(roots[0].monorepoInfo?.type).toBe('turbo');
  });

  it('should analyze Nx project', async () => {
    const nxJson = JSON.stringify({ namedInputs: { default: ['{projectRoot}/**/*'] } });
    const packageJson = JSON.stringify({ name: 'nx-root', private: true });

    mockFileSystem = createMockFileSystem(
      createFileMap([
        ['/nx/nx.json', nxJson],
        ['/nx/package.json', packageJson],
      ]),
      createDirMap([['/nx', [{ name: 'nx.json', type: 'file' }, { name: 'package.json', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/nx']);

    expect(roots).toHaveLength(1);
    expect(roots[0].isMonorepoRoot).toBe(true);
    expect(roots[0].monorepoInfo?.type).toBe('nx');
  });

  it('should analyze Python project with pyproject.toml', async () => {
    const pyproject = `[project]
name = "my-python-project"
version = "1.0.0"
dependencies = ["requests"]`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/python/pyproject.toml', pyproject]]),
      createDirMap([['/python', [{ name: 'pyproject.toml', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/python']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('poetry');
    expect(roots[0].languages).toContain('python');
  });

  it('should analyze Rust project with Cargo.toml', async () => {
    const cargoToml = `[package]
name = "my-rust-project"
version = "0.1.0"
edition = "2021"`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/rust/Cargo.toml', cargoToml]]),
      createDirMap([['/rust', [{ name: 'Cargo.toml', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/rust']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('cargo');
    expect(roots[0].languages).toContain('rust');
    expect(roots[0].name).toBe('my-rust-project');
  });

  it('should analyze Go project with go.mod', async () => {
    const goMod = `module github.com/user/my-go-project

go 1.21`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/go/go.mod', goMod]]),
      createDirMap([['/go', [{ name: 'go.mod', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/go']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('go');
    expect(roots[0].languages).toContain('go');
    expect(roots[0].name).toBe('github.com/user/my-go-project');
  });

  it('should analyze Java project with pom.xml', async () => {
    const pomXml = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>my-java-project</artifactId>
  <version>1.0.0</version>
</project>`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/java/pom.xml', pomXml]]),
      createDirMap([['/java', [{ name: 'pom.xml', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/java']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('maven');
    expect(roots[0].languages).toContain('java');
    expect(roots[0].name).toBe('my-java-project');
  });

  it('should analyze Gradle project with build.gradle.kts', async () => {
    const buildGradle = `rootProject.name = "my-gradle-project"

plugins {
  id("java")
}`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/gradle/build.gradle.kts', buildGradle]]),
      createDirMap([['/gradle', [{ name: 'build.gradle.kts', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/gradle']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('gradle');
    expect(roots[0].languages).toContain('kotlin');
    expect(roots[0].languages).toContain('java');
    expect(roots[0].name).toBe('my-gradle-project');
  });

  it('should analyze .NET project with csproj', async () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>MyDotNetProject</AssemblyName>
  </PropertyGroup>
</Project>`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/dotnet/MyDotNetProject.csproj', csproj]]),
      createDirMap([['/dotnet', [{ name: 'MyDotNetProject.csproj', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/dotnet']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('dotnet');
    expect(roots[0].languages).toContain('csharp');
    expect(roots[0].name).toBe('MyDotNetProject');
  });

  it('should analyze PHP project with composer.json', async () => {
    const composerJson = JSON.stringify({
      name: 'vendor/my-php-project',
      version: '1.0.0',
      require: { 'monolog/monolog': '^2.0' },
    });

    mockFileSystem = createMockFileSystem(
      createFileMap([['/php/composer.json', composerJson]]),
      createDirMap([['/php', [{ name: 'composer.json', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/php']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('composer');
    expect(roots[0].languages).toContain('php');
    expect(roots[0].name).toBe('vendor/my-php-project');
  });

  it('should analyze Ruby project with Gemfile', async () => {
    const gemfile = `source 'https://rubygems.org'
gem 'rails', '~> 7.0'`;

    mockFileSystem = createMockFileSystem(
      createFileMap([['/ruby/Gemfile', gemfile]]),
      createDirMap([['/ruby', [{ name: 'Gemfile', type: 'file' }]]])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/ruby']);

    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('bundler');
    expect(roots[0].languages).toContain('ruby');
  });

  it('should handle nested project roots', async () => {
    const rootPackageJson = JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] });
    const childPackageJson = JSON.stringify({ name: 'child-package', version: '1.0.0' });

    mockFileSystem = createMockFileSystem(
      createFileMap([
        ['/monorepo/package.json', rootPackageJson],
        ['/monorepo/packages/child/package.json', childPackageJson],
      ]),
      createDirMap([
        ['/monorepo', [{ name: 'package.json', type: 'file' }, { name: 'packages', type: 'directory' }]],
        ['/monorepo/packages', [{ name: 'child', type: 'directory' }]],
        ['/monorepo/packages/child', [{ name: 'package.json', type: 'file' }]],
      ])
    );
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/monorepo']);

    expect(roots.length).toBeGreaterThanOrEqual(1);
    const rootProject = roots.find((r) => r.path === '/monorepo');
    expect(rootProject?.isMonorepoRoot).toBe(true);
  });

  it('should handle missing manifests gracefully', async () => {
    const emptyDirs = new Map<string, { name: string; type: 'file' | 'directory' }[]>();
    emptyDirs.set('/empty', [{ name: 'README.md', type: 'file' }]);
    mockFileSystem = createMockFileSystem(new Map(), emptyDirs);
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/empty']);

    expect(roots).toHaveLength(0);
  });

  it('should handle malformed JSON gracefully', async () => {
    const badFiles = new Map<string, string>();
    badFiles.set('/bad/package.json', '{ invalid json }');
    const badDirs = new Map<string, { name: string; type: 'file' | 'directory' }[]>();
    badDirs.set('/bad', [{ name: 'package.json', type: 'file' }]);
    mockFileSystem = createMockFileSystem(badFiles, badDirs);
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/bad']);

    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('bad');
  });

  it('should detect frameworks from dependencies', async () => {
    const packageJson = JSON.stringify({
      name: 'react-app',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', next: '^13.0.0' },
      devDependencies: { typescript: '^5.0.0', jest: '^29.0.0', tailwindcss: '^3.0.0' },
    });

    const reactFiles = new Map<string, string>();
    reactFiles.set('/react-app/package.json', packageJson);
    const reactDirs = new Map<string, { name: string; type: 'file' | 'directory' }[]>();
    reactDirs.set('/react-app', [{ name: 'package.json', type: 'file' }]);
    mockFileSystem = createMockFileSystem(reactFiles, reactDirs);
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
    });

    const roots = await analyzer.analyzeProjectRoots(['/react-app']);

    expect(roots[0].frameworks).toContain('react');
    expect(roots[0].frameworks).toContain('nextjs');
    expect(roots[0].frameworks).toContain('typescript');
    expect(roots[0].frameworks).toContain('jest');
    expect(roots[0].frameworks).toContain('tailwind');
  });

  it('should respect maxDepth configuration', async () => {
    const deepPackageJson = JSON.stringify({ name: 'deep-project' });

    const dirs = new Map<string, { name: string; type: 'file' | 'directory' }[]>();
    let current = '/deep';
    for (let i = 0; i < 10; i++) {
      dirs.set(current, [{ name: 'package.json', type: 'file' }, { name: `level${i + 1}`, type: 'directory' }]);
      current = `${current}/level${i + 1}`;
    }
    dirs.set(current, [{ name: 'package.json', type: 'file' }]);

    const files = new Map<string, string>();
    current = '/deep';
    for (let i = 0; i < 10; i++) {
      files.set(`${current}/package.json`, deepPackageJson);
      current = `${current}/level${i + 1}`;
    }
    files.set(`${current}/package.json`, deepPackageJson);

    mockFileSystem = createMockFileSystem(files, dirs);
    analyzer = new ProjectAnalyzer({
      fileSystem: mockFileSystem,
      manifestRegistry,
      config: { maxDepth: 3 },
    });

    const roots = await analyzer.analyzeProjectRoots(['/deep']);

    expect(roots.length).toBeLessThanOrEqual(4);
  });
});
