import type { FileSystemProvider } from '../discovery/workspace-provider.js';
import type { ManifestType, ProjectManifest, ProjectType, WorkspaceConfig } from '../types.js';
import { createProjectManifest } from '../types.js';

interface PackageJson {
  name?: string;
  version?: string;
  workspaces?: {
    packages?: string[];
    catalogs?: Record<string, unknown>;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface ManifestParser {
  readonly type: ManifestType;
  readonly projectType: ProjectType;
  parse(content: string, path: string): ParsedManifest;
}

export interface ParsedManifest {
  name: string | undefined;
  version: string | undefined;
  workspaceConfig: WorkspaceConfig | undefined;
  dependencies: Record<string, string> | undefined;
  devDependencies: Record<string, string> | undefined;
  peerDependencies: Record<string, string> | undefined;
  optionalDependencies: Record<string, string> | undefined;
  rawData: Record<string, unknown> | undefined;
}

export class ManifestRegistry {
  private readonly parsers: Map<ManifestType, ManifestParser> = new Map();

  constructor() {
    this.registerDefaultParsers();
  }

  private registerDefaultParsers(): void {
    this.register({
      type: 'package.json',
      projectType: 'npm',
      parse: (content, path) => this.parsePackageJson(content, path),
    });

    this.register({
      type: 'pnpm-workspace.yaml',
      projectType: 'pnpm',
      parse: (content, path) => this.parseYamlWorkspace(content, path),
    });

    this.register({
      type: 'pnpm-workspace.yml',
      projectType: 'pnpm',
      parse: (content, path) => this.parseYamlWorkspace(content, path),
    });

    this.register({
      type: 'yarn.workspaces',
      projectType: 'yarn',
      parse: (content, path) => this.parsePackageJson(content, path),
    });

    this.register({
      type: 'lerna.json',
      projectType: 'npm',
      parse: (content, path) => this.parseLernaJson(content, path),
    });

    this.register({
      type: 'nx.json',
      projectType: 'npm',
      parse: (content, path) => this.parseNxJson(content, path),
    });

    this.register({
      type: 'turbo.json',
      projectType: 'npm',
      parse: (content, path) => this.parseTurboJson(content, path),
    });

    this.register({
      type: 'Cargo.toml',
      projectType: 'cargo',
      parse: (content, path) => this.parseCargoToml(content, path),
    });

    this.register({
      type: 'go.mod',
      projectType: 'go',
      parse: (content, path) => this.parseGoMod(content, path),
    });

    this.register({
      type: 'pyproject.toml',
      projectType: 'poetry',
      parse: (content, path) => this.parsePyProjectToml(content, path),
    });

    this.register({
      type: 'requirements.txt',
      projectType: 'pip',
      parse: (content, path) => this.parseRequirementsTxt(content, path),
    });

    this.register({
      type: 'setup.py',
      projectType: 'pip',
      parse: (content, path) => this.parseSetupPy(content, path),
    });

    this.register({
      type: 'setup.cfg',
      projectType: 'pip',
      parse: (content, path) => this.parseSetupCfg(content, path),
    });

    this.register({
      type: 'pom.xml',
      projectType: 'maven',
      parse: (content, path) => this.parsePomXml(content, path),
    });

    this.register({
      type: 'build.gradle',
      projectType: 'gradle',
      parse: (content, path) => this.parseGradle(content, path),
    });

    this.register({
      type: 'build.gradle.kts',
      projectType: 'gradle',
      parse: (content, path) => this.parseGradle(content, path),
    });

    this.register({
      type: 'composer.json',
      projectType: 'composer',
      parse: (content, path) => this.parseComposerJson(content, path),
    });

    this.register({
      type: 'Gemfile',
      projectType: 'bundler',
      parse: (content, path) => this.parseGemfile(content, path),
    });

    this.register({
      type: 'csproj',
      projectType: 'dotnet',
      parse: (content, path) => this.parseCsproj(content, path),
    });

    this.register({
      type: 'sln',
      projectType: 'dotnet',
      parse: (content, path) => this.parseSln(content, path),
    });
  }

  register(parser: ManifestParser): void {
    this.parsers.set(parser.type, parser);
  }

  getParser(type: ManifestType): ManifestParser | undefined {
    return this.parsers.get(type);
  }

  hasParser(type: ManifestType): boolean {
    return this.parsers.has(type);
  }

  getAllManifestTypes(): readonly ManifestType[] {
    return Array.from(this.parsers.keys());
  }

  async discoverManifests(
    rootPath: string,
    fileSystem: FileSystemProvider,
    maxDepth: number = 5
  ): Promise<readonly ProjectManifest[]> {
    const manifests: ProjectManifest[] = [];
    await this.traverseForManifests(rootPath, fileSystem, manifests, 0, maxDepth);
    return manifests;
  }

  private async traverseForManifests(
    currentPath: string,
    fileSystem: FileSystemProvider,
    manifests: ProjectManifest[],
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    try {
      const entries = await fileSystem.readDirectory(currentPath);
      for (const entry of entries) {
        if (entry.type !== 'file') {
          if (entry.type === 'directory' && depth < maxDepth) {
            const fullPath = `${currentPath}/${entry.name}`;
            if (!this.shouldSkipDirectory(entry.name)) {
              await this.traverseForManifests(fullPath, fileSystem, manifests, depth + 1, maxDepth);
            }
          }
          continue;
        }

        const parser = this.findParserForFile(entry.name);
        if (parser) {
          try {
            const fullPath = `${currentPath}/${entry.name}`;
            const content = await fileSystem.readFile(fullPath);
            const parsed = parser.parse(content, fullPath);
            const manifest = createProjectManifest({
              path: fullPath,
              type: parser.type,
              name: parsed.name ?? '',
              version: parsed.version ?? '',
              ...(parsed.rawData !== undefined ? { rawData: parsed.rawData } : {}),
            });
            manifests.push(manifest);
          } catch {
            // Ignore parse errors, continue discovery
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  private findParserForFile(fileName: string): ManifestParser | undefined {
    for (const [type, parser] of this.parsers) {
      if (this.matchesManifestType(fileName, type)) {
        return parser;
      }
    }
    return undefined;
  }

  private matchesManifestType(fileName: string, manifestType: ManifestType): boolean {
    if (manifestType === 'csproj' || manifestType === 'sln') {
      return fileName.endsWith(`.${manifestType}`);
    }
    return fileName === manifestType;
  }

  private shouldSkipDirectory(dirName: string): boolean {
    const skipDirs = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      'target',
      '.gradle',
      'vendor',
      'Pods',
      'Carthage',
      '.build',
      'bin',
      'obj',
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.idea',
      '.vscode',
      '.turbo',
      '.vercel',
      '.next',
      '.nuxt',
      '.svelte-kit',
    ]);
    return skipDirs.has(dirName) || dirName.startsWith('.');
  }

  private parsePackageJson(_content: string, _path: string): ParsedManifest {
    try {
      const data = JSON.parse(_content) as PackageJson;
      const workspaceConfig = data.workspaces
        ? {
            packages: data.workspaces.packages ?? [],
            ...(data.workspaces.catalogs !== undefined ? { catalogs: data.workspaces.catalogs } : {}),
          }
        : undefined;
      return {
        name: data.name,
        version: data.version,
        workspaceConfig,
        dependencies: data.dependencies,
        devDependencies: data.devDependencies,
        peerDependencies: data.peerDependencies,
        optionalDependencies: data.optionalDependencies,
        rawData: data,
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseYamlWorkspace(content: string, _path: string): ParsedManifest {
    try {
      const lines = content.split('\n');
      const packages: string[] = [];
      let inPackages = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'packages:') {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          if (trimmed.startsWith('- ')) {
            packages.push(trimmed.slice(2).trim());
          } else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
            inPackages = false;
          }
        }
      }

      return {
        name: undefined,
        version: undefined,
        workspaceConfig: { packages },
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { workspaces: { packages } },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseLernaJson(content: string, path: string): ParsedManifest {
    try {
      const data = JSON.parse(content);
      return {
        name: data.name,
        version: data.version,
        workspaceConfig: data.packages
          ? { packages: Array.isArray(data.packages) ? data.packages : [data.packages] }
          : undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: data,
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseNxJson(content: string, path: string): ParsedManifest {
    try {
      const data = JSON.parse(content);
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: data,
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseTurboJson(content: string, path: string): ParsedManifest {
    try {
      const data = JSON.parse(content);
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: data,
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseCargoToml(content: string, path: string): ParsedManifest {
    try {
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
      return {
        name: nameMatch?.[1],
        version: versionMatch?.[1],
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseGoMod(content: string, path: string): ParsedManifest {
    try {
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      return {
        name: moduleMatch?.[1],
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parsePyProjectToml(content: string, path: string): ParsedManifest {
    try {
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
      return {
        name: nameMatch?.[1],
        version: versionMatch?.[1],
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseRequirementsTxt(content: string, path: string): ParsedManifest {
    return {
      name: undefined,
      version: undefined,
      workspaceConfig: undefined,
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
      rawData: { content: content.slice(0, 500) },
    };
  }

  private parseSetupPy(content: string, path: string): ParsedManifest {
    return {
      name: undefined,
      version: undefined,
      workspaceConfig: undefined,
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
      rawData: { content: content.slice(0, 500) },
    };
  }

  private parseSetupCfg(content: string, path: string): ParsedManifest {
    return {
      name: undefined,
      version: undefined,
      workspaceConfig: undefined,
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
      rawData: { content: content.slice(0, 500) },
    };
  }

  private parsePomXml(content: string, path: string): ParsedManifest {
    try {
      const artifactIdMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
      const versionMatch = content.match(/<version>([^<]+)<\/version>/);
      return {
        name: artifactIdMatch?.[1],
        version: versionMatch?.[1],
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseGradle(content: string, path: string): ParsedManifest {
    try {
      const nameMatch = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
      return {
        name: nameMatch?.[1],
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseComposerJson(content: string, path: string): ParsedManifest {
    try {
      const data = JSON.parse(content);
      return {
        name: data.name,
        version: data.version,
        workspaceConfig: undefined,
        dependencies: data.require,
        devDependencies: data['require-dev'],
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: data,
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseGemfile(content: string, path: string): ParsedManifest {
    return {
      name: undefined,
      version: undefined,
      workspaceConfig: undefined,
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
      rawData: { content: content.slice(0, 500) },
    };
  }

  private parseCsproj(content: string, path: string): ParsedManifest {
    try {
      const nameMatch = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/) ||
                        content.match(/<ProjectName>([^<]+)<\/ProjectName>/) ||
                        content.match(/<Name>([^<]+)<\/Name>/);
      return {
        name: nameMatch?.[1],
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: { content: content.slice(0, 500) },
      };
    } catch {
      return {
        name: undefined,
        version: undefined,
        workspaceConfig: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        rawData: undefined,
      };
    }
  }

  private parseSln(content: string, path: string): ParsedManifest {
    return {
      name: undefined,
      version: undefined,
      workspaceConfig: undefined,
      dependencies: undefined,
      devDependencies: undefined,
      peerDependencies: undefined,
      optionalDependencies: undefined,
      rawData: { content: content.slice(0, 500) },
    };
  }
}

export function createManifestRegistry(): ManifestRegistry {
  return new ManifestRegistry();
}