import { createLogger, type Logger, defaultEngineConfig } from '@nexipi/core';
import type { FileSystemProvider } from '../discovery/workspace-provider.js';
import { ManifestRegistry, type ParsedManifest } from './manifest-registry.js';
import type {
  ProjectRoot,
  ProjectManifest,
  ProjectType,
  ManifestType,
  MonorepoInfo,
  MonorepoType,
  WorkspaceConfig,
} from '../types.js';
import type { ProjectAnalysisConfig } from '../config.js';
import { createProjectRoot, createMonorepoInfo } from '../types.js';

export interface ProjectAnalyzerOptions {
  fileSystem: FileSystemProvider;
  manifestRegistry?: ManifestRegistry;
  config?: Partial<ProjectAnalysisConfig>;
  logger?: Logger;
}

export class ProjectAnalyzer {
  private readonly fileSystem: FileSystemProvider;
  private readonly manifestRegistry: ManifestRegistry;
  private readonly config: ProjectAnalysisConfig;
  private readonly logger: Logger;

  constructor(options: ProjectAnalyzerOptions) {
    this.fileSystem = options.fileSystem;
    this.manifestRegistry = options.manifestRegistry ?? new ManifestRegistry();
    this.config = {
      enabled: true,
      maxDepth: 5,
      detectLanguages: true,
      detectFrameworks: true,
      detectMonorepos: true,
      parseManifests: true,
      includeRawManifestData: false,
      ...options.config,
    };
    this.logger = options.logger ?? createLogger({
      ...defaultEngineConfig,
      name: 'project-analyzer',
      version: '0.0.1',
      logLevel: 'info',
    });
  }

  async analyzeProjectRoots(rootPaths: readonly string[]): Promise<readonly ProjectRoot[]> {
    const results: ProjectRoot[] = [];

    for (const rootPath of rootPaths) {
      try {
        const projectRoots = await this.analyzeSingleRoot(rootPath);
        results.push(...projectRoots);
      } catch (error) {
        this.logger.error('Failed to analyze project root', {
          rootPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  private async analyzeSingleRoot(rootPath: string): Promise<ProjectRoot[]> {
    if (!this.config.enabled) {
      return [];
    }

    const manifests = await this.manifestRegistry.discoverManifests(
      rootPath,
      this.fileSystem,
      this.config.maxDepth
    );

    const rootGroups = this.groupManifestsByRoot(manifests, rootPath);
    const projectRoots: ProjectRoot[] = [];

    for (const [groupRoot, groupManifests] of rootGroups) {
      const projectRoot = this.buildProjectRoot(groupRoot, groupManifests);
      projectRoots.push(projectRoot);
    }

    return projectRoots;
  }

  private groupManifestsByRoot(
    manifests: readonly ProjectManifest[],
    rootPath: string
  ): Map<string, ProjectManifest[]> {
    const groups = new Map<string, ProjectManifest[]>();

    for (const manifest of manifests) {
      const manifestRoot = this.findManifestRoot(manifest.path, rootPath);
      const existing = groups.get(manifestRoot) ?? [];
      existing.push(manifest);
      groups.set(manifestRoot, existing);
    }

    return groups;
  }

  private findManifestRoot(manifestPath: string, rootPath: string): string {
    const relative = manifestPath.slice(rootPath.length + 1);
    const parts = relative.split('/');
    if (parts.length <= 1) {
      return rootPath;
    }
    return `${rootPath}/${parts[0]}`;
  }

  private buildProjectRoot(rootPath: string, manifests: ProjectManifest[]): ProjectRoot {
    const primaryManifest = this.selectPrimaryManifest(manifests);
    const projectType = primaryManifest ? this.inferProjectType(primaryManifest.type) : 'unknown';
    const name = this.inferProjectName(rootPath, primaryManifest);
    const languages = this.config.detectLanguages ? this.detectLanguages(manifests) : [];
    const frameworks = this.config.detectFrameworks ? this.detectFrameworks(manifests) : [];
const monorepoInfo = this.config.detectMonorepos ? this.detectMonorepo(manifests, rootPath) : undefined;

    return createProjectRoot({
      path: rootPath,
      name,
      type: projectType,
      manifests,
      languages,
      frameworks,
      isMonorepoRoot: monorepoInfo !== undefined,
      ...(monorepoInfo !== undefined ? { monorepoInfo } : {}),
    });
  }

  private selectPrimaryManifest(manifests: ProjectManifest[]): ProjectManifest | undefined {
    const priority: ManifestType[] = [
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-workspace.yml',
      'yarn.workspaces',
      'lerna.json',
      'nx.json',
      'turbo.json',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'composer.json',
      'Gemfile',
      'csproj',
      'sln',
      'requirements.txt',
      'setup.py',
      'setup.cfg',
    ];

    for (const type of priority) {
      const found = manifests.find((m) => m.type === type);
      if (found) {
        return found;
      }
    }
    return manifests[0];
  }

  private inferProjectType(manifestType: ManifestType): ProjectType {
    const typeMap: Record<ManifestType, ProjectType> = {
      'package.json': 'npm',
      'pnpm-workspace.yaml': 'pnpm',
      'pnpm-workspace.yml': 'pnpm',
      'yarn.workspaces': 'yarn',
      'lerna.json': 'npm',
      'nx.json': 'npm',
      'turbo.json': 'npm',
      'Cargo.toml': 'cargo',
      'go.mod': 'go',
      'pyproject.toml': 'poetry',
      'requirements.txt': 'pip',
      'setup.py': 'pip',
      'setup.cfg': 'pip',
      'pom.xml': 'maven',
      'build.gradle': 'gradle',
      'build.gradle.kts': 'gradle',
      'composer.json': 'composer',
      'Gemfile': 'bundler',
      'csproj': 'dotnet',
      'sln': 'dotnet',
    };
    return typeMap[manifestType] ?? 'unknown';
  }

  private inferProjectName(rootPath: string, primaryManifest?: ProjectManifest): string {
    if (primaryManifest?.name) {
      return primaryManifest.name;
    }
    const parts = rootPath.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'unknown';
  }

  private detectLanguages(manifests: readonly ProjectManifest[]): string[] {
    const languages = new Set<string>();

    for (const manifest of manifests) {
      const detected = this.languagesForManifest(manifest);
      for (const lang of detected) {
        languages.add(lang);
      }
    }

    return Array.from(languages).sort();
  }

  private languagesForManifest(manifest: ProjectManifest): string[] {
    const typeLanguages: Record<ManifestType, string[]> = {
      'package.json': ['javascript', 'typescript'],
      'pnpm-workspace.yaml': ['javascript', 'typescript'],
      'pnpm-workspace.yml': ['javascript', 'typescript'],
      'yarn.workspaces': ['javascript', 'typescript'],
      'lerna.json': ['javascript', 'typescript'],
      'nx.json': ['javascript', 'typescript'],
      'turbo.json': ['javascript', 'typescript'],
      'Cargo.toml': ['rust'],
      'go.mod': ['go'],
      'pyproject.toml': ['python'],
      'requirements.txt': ['python'],
      'setup.py': ['python'],
      'setup.cfg': ['python'],
      'pom.xml': ['java'],
      'build.gradle': ['java', 'kotlin'],
      'build.gradle.kts': ['kotlin', 'java'],
      'composer.json': ['php'],
      'Gemfile': ['ruby'],
      'csproj': ['csharp'],
      'sln': ['csharp'],
    };
    return typeLanguages[manifest.type] ?? [];
  }

  private detectFrameworks(manifests: readonly ProjectManifest[]): string[] {
    const frameworks = new Set<string>();

    for (const manifest of manifests) {
      const detected = this.frameworksForManifest(manifest);
      for (const fw of detected) {
        frameworks.add(fw);
      }
    }

    return Array.from(frameworks).sort();
  }

  private frameworksForManifest(manifest: ProjectManifest): string[] {
    const allDeps = this.getAllDependencies(manifest);
    if (allDeps.size === 0) {
      return [];
    }

    const frameworkIndicators: Record<string, string[]> = {
      react: ['react', 'react-dom', '@types/react'],
      nextjs: ['next'],
      vue: ['vue', '@vue/'],
      nuxt: ['nuxt'],
      svelte: ['svelte'],
      sveltekit: ['@sveltejs/kit'],
      angular: ['@angular/core'],
      express: ['express'],
      fastify: ['fastify'],
      nestjs: ['@nestjs/core'],
      koa: ['koa'],
      hapi: ['@hapi/hapi'],
      electron: ['electron'],
      tauri: ['@tauri-apps/'],
      vite: ['vite'],
      webpack: ['webpack'],
      rollup: ['rollup'],
      jest: ['jest'],
      vitest: ['vitest'],
      cypress: ['cypress'],
      playwright: ['@playwright/test'],
      testingLibrary: ['@testing-library/'],
      tailwind: ['tailwindcss'],
      prisma: ['@prisma/client'],
      typeorm: ['typeorm'],
      sequelize: ['sequelize'],
      mongoose: ['mongoose'],
      graphql: ['graphql', 'apollo-server'],
      trpc: ['@trpc/server'],
      zod: ['zod'],
      rxjs: ['rxjs'],
      redux: ['@reduxjs/toolkit', 'redux'],
      zustand: ['zustand'],
      jotai: ['jotai'],
      recoil: ['recoil'],
      solid: ['solid-js'],
      qwik: ['@builder.io/qwik'],
      astro: ['astro'],
      remix: ['@remix-run/'],
      gatsby: ['gatsby'],
      docusaurus: ['@docusaurus/'],
      storybook: ['@storybook/'],
      eslint: ['eslint'],
      prettier: ['prettier'],
      typescript: ['typescript'],
    };

    const detected: string[] = [];
    for (const [framework, indicators] of Object.entries(frameworkIndicators)) {
      for (const indicator of indicators) {
        for (const dep of allDeps) {
          if (dep.startsWith(indicator)) {
            detected.push(framework);
            break;
          }
        }
      }
    }

    return detected;
  }

  private getAllDependencies(manifest: ProjectManifest): Set<string> {
    const deps = new Set<string>();
    const parsed = manifest.rawData as ParsedManifest | undefined;

    if (parsed) {
      if (parsed.dependencies) {
        for (const dep of Object.keys(parsed.dependencies)) {
          deps.add(dep);
        }
      }
      if (parsed.devDependencies) {
        for (const dep of Object.keys(parsed.devDependencies)) {
          deps.add(dep);
        }
      }
      if (parsed.peerDependencies) {
        for (const dep of Object.keys(parsed.peerDependencies)) {
          deps.add(dep);
        }
      }
      if (parsed.optionalDependencies) {
        for (const dep of Object.keys(parsed.optionalDependencies)) {
          deps.add(dep);
        }
      }
    }

    return deps;
  }

  private detectMonorepo(manifests: readonly ProjectManifest[], rootPath: string): MonorepoInfo | undefined {
    const monorepoManifests = manifests.filter((m) =>
      ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json', 'yarn.workspaces'].includes(m.type)
    );

    if (monorepoManifests.length === 0) {
      const packageJson = manifests.find((m) => m.type === 'package.json');
      if (packageJson?.rawData) {
        const raw = packageJson.rawData as { workspaces?: string[] | { packages?: string[] } } | undefined;
        const workspacePackages =
          raw?.workspaces === undefined || raw?.workspaces === null
            ? undefined
            : Array.isArray(raw.workspaces)
            ? raw.workspaces
            : raw.workspaces.packages;
        if (workspacePackages) {
          return createMonorepoInfo({
            type: 'npm',
            rootPath,
            config: { packages: workspacePackages },
            manifestPaths: [packageJson.path],
          });
        }
      }
      return undefined;
    }

    const types = new Set<MonorepoType>();
    const manifestPaths: string[] = [];
    let config: WorkspaceConfig | undefined;

    for (const manifest of monorepoManifests) {
      manifestPaths.push(manifest.path);
      const raw = manifest.rawData as { workspaces?: { packages?: string[] }; packages?: string[] } | undefined;

      if (manifest.type.startsWith('pnpm-workspace')) {
        types.add('pnpm');
        if (raw?.workspaces?.packages) {
          config = { packages: raw.workspaces.packages };
        }
      } else if (manifest.type === 'lerna.json') {
        types.add('lerna');
        if (raw?.packages) {
          config = { packages: raw.packages };
        }
      } else if (manifest.type === 'nx.json') {
        types.add('nx');
      } else if (manifest.type === 'turbo.json') {
        types.add('turbo');
      } else if (manifest.type === 'yarn.workspaces') {
        types.add('yarn');
      }
    }

    const primaryType = this.selectPrimaryMonorepoType(types);
    return createMonorepoInfo({
      type: primaryType,
      rootPath,
      manifestPaths,
      ...(config !== undefined ? { config } : {}),
    });
  }

  private selectPrimaryMonorepoType(types: Set<MonorepoType>): MonorepoType {
    const priority: MonorepoType[] = ['pnpm', 'npm', 'yarn', 'turbo', 'nx', 'lerna'];
    for (const type of priority) {
      if (types.has(type)) {
        return type;
      }
    }
    return types.values().next().value ?? 'npm';
  }
}

export function createProjectAnalyzer(options: ProjectAnalyzerOptions): ProjectAnalyzer {
  return new ProjectAnalyzer(options);
}