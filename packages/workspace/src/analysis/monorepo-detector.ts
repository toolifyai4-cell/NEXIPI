import type { FileSystemProvider } from '../discovery/workspace-provider.js';
import { ManifestRegistry } from './manifest-registry.js';
import type { MonorepoInfo, MonorepoType, WorkspaceConfig, ProjectManifest } from '../types.js';
import { createMonorepoInfo } from '../types.js';

export interface MonorepoDetectionResult {
  readonly detected: boolean;
  readonly monorepoInfo?: MonorepoInfo;
  readonly allDetectedTypes: readonly MonorepoType[];
  readonly manifestPaths: readonly string[];
}

export interface MonorepoDetectorOptions {
  fileSystem: FileSystemProvider;
  manifestRegistry?: ManifestRegistry;
  maxDepth?: number;
}

export class MonorepoDetector {
  private readonly fileSystem: FileSystemProvider;
  private readonly manifestRegistry: ManifestRegistry;
  private readonly maxDepth: number;

  constructor(options: MonorepoDetectorOptions) {
    this.fileSystem = options.fileSystem;
    this.manifestRegistry = options.manifestRegistry ?? new ManifestRegistry();
    this.maxDepth = options.maxDepth ?? 5;
  }

  async detect(rootPath: string): Promise<MonorepoDetectionResult> {
    const manifests = await this.manifestRegistry.discoverManifests(rootPath, this.fileSystem, this.maxDepth);
    return this.analyzeManifestsForMonorepo(manifests, rootPath);
  }

  async detectMultiple(rootPaths: readonly string[]): Promise<Map<string, MonorepoDetectionResult>> {
    const results = new Map<string, MonorepoDetectionResult>();

    for (const rootPath of rootPaths) {
      try {
        results.set(rootPath, await this.detect(rootPath));
      } catch {
        results.set(rootPath, {
          detected: false,
          allDetectedTypes: [],
          manifestPaths: [],
        });
      }
    }

    return results;
  }

  private analyzeManifestsForMonorepo(
    manifests: readonly ProjectManifest[],
    rootPath: string
  ): MonorepoDetectionResult {
    const monorepoManifests = manifests.filter((m) =>
      this.isMonorepoManifestType(m.type)
    );

    if (monorepoManifests.length === 0) {
      const packageJson = manifests.find((m) => m.type === 'package.json');
      if (packageJson?.rawData) {
        const data = packageJson.rawData as { workspaces?: { packages?: string[] }; catalogs?: Record<string, unknown> };
        if (data.workspaces) {
          return {
            detected: true,
            monorepoInfo: this.buildMonorepoInfo('npm', rootPath, packageJson.path, data),
            allDetectedTypes: ['npm'],
            manifestPaths: [packageJson.path],
          };
        }
      }
      return {
        detected: false,
        allDetectedTypes: [],
        manifestPaths: [],
      };
    }

    const types = new Set<MonorepoType>();
    const manifestPaths: string[] = [];
    let config: WorkspaceConfig | undefined;

    for (const manifest of monorepoManifests) {
      manifestPaths.push(manifest.path);
      const parsed = manifest.rawData as { workspaces?: { packages?: string[] }; catalogs?: Record<string, unknown> } | undefined;

      if (manifest.type.startsWith('pnpm-workspace')) {
        types.add('pnpm');
        if (parsed?.workspaces?.packages) {
          config = { packages: parsed.workspaces.packages, catalogs: parsed.catalogs ?? {} };
        }
      } else if (manifest.type === 'lerna.json') {
        types.add('lerna');
        if (parsed?.workspaces?.packages) {
          config = { packages: parsed.workspaces.packages };
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
    const allTypes = Array.from(types);

    const info = createMonorepoInfo({
      type: primaryType,
      rootPath,
      manifestPaths,
      ...(config !== undefined ? { config } : {}),
    });

    return {
      detected: true,
      monorepoInfo: info,
      allDetectedTypes: allTypes,
      manifestPaths,
    };
  }

  private isMonorepoManifestType(type: string): boolean {
    return [
      'pnpm-workspace.yaml',
      'pnpm-workspace.yml',
      'lerna.json',
      'nx.json',
      'turbo.json',
      'yarn.workspaces',
    ].includes(type);
  }

  private buildMonorepoInfo(
    type: MonorepoType,
    rootPath: string,
    manifestPath: string,
    data: { workspaces?: { packages?: string[] }; catalogs?: Record<string, unknown> }
  ): MonorepoInfo {
    return createMonorepoInfo({
      type,
      rootPath,
      manifestPaths: [manifestPath],
      ...(data.workspaces?.packages ? { config: { packages: data.workspaces.packages, catalogs: data.catalogs ?? {} } } : {}),
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

export function createMonorepoDetector(options: MonorepoDetectorOptions): MonorepoDetector {
  return new MonorepoDetector(options);
}