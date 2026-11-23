import { z } from 'zod';

export type WorkspaceFolderId = string & { readonly __brand: unique symbol };

export function createWorkspaceFolderId(id: string): WorkspaceFolderId {
  return id as WorkspaceFolderId;
}

export interface WorkspaceFolder {
  readonly id: WorkspaceFolderId;
  readonly uri: string;
  readonly name: string;
  readonly index: number;
}

export const WorkspaceFolderSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
});

export type WorkspaceFolderInput = z.input<typeof WorkspaceFolderSchema>;
export type WorkspaceFolderOutput = z.output<typeof WorkspaceFolderSchema>;

export interface Workspace {
  readonly folders: readonly WorkspaceFolder[];
  readonly isMultiRoot: boolean;
  readonly id: string;
  readonly timestamp: number;
}

export const WorkspaceSchema = z.object({
  folders: z.array(WorkspaceFolderSchema),
  isMultiRoot: z.boolean(),
  id: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
});

export type WorkspaceInput = z.input<typeof WorkspaceSchema>;
export type WorkspaceOutput = z.output<typeof WorkspaceSchema>;

export type ProjectType =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'cargo'
  | 'go'
  | 'maven'
  | 'gradle'
  | 'dotnet'
  | 'composer'
  | 'bundler'
  | 'pip'
  | 'poetry'
  | 'unknown';

export type ManifestType =
  | 'package.json'
  | 'pnpm-workspace.yaml'
  | 'pnpm-workspace.yml'
  | 'yarn.workspaces'
  | 'lerna.json'
  | 'nx.json'
  | 'turbo.json'
  | 'Cargo.toml'
  | 'go.mod'
  | 'pyproject.toml'
  | 'requirements.txt'
  | 'setup.py'
  | 'setup.cfg'
  | 'pom.xml'
  | 'build.gradle'
  | 'build.gradle.kts'
  | 'composer.json'
  | 'Gemfile'
  | 'csproj'
  | 'sln';

export interface ProjectManifest {
  readonly path: string;
  readonly type: ManifestType;
  readonly name?: string;
  readonly version?: string;
  readonly rawData?: Record<string, unknown>;
}

export function createProjectManifest(params: {
  path: string;
  type: ManifestType;
  name?: string;
  version?: string;
  rawData?: Record<string, unknown>;
}): ProjectManifest {
  return {
    path: params.path,
    type: params.type,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.version !== undefined ? { version: params.version } : {}),
    ...(params.rawData !== undefined ? { rawData: params.rawData } : {}),
  };
}

export const ProjectManifestSchema = z.object({
  path: z.string().min(1),
  type: z.enum([
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
    'requirements.txt',
    'setup.py',
    'setup.cfg',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'Gemfile',
    'csproj',
    'sln',
  ]),
  name: z.string().optional(),
  version: z.string().optional(),
  rawData: z.record(z.unknown()).optional(),
});

export type ProjectManifestInput = z.input<typeof ProjectManifestSchema>;
export type ProjectManifestOutput = z.output<typeof ProjectManifestSchema>;

export interface WorkspaceConfig {
  readonly packages?: readonly string[];
  readonly catalogs?: Record<string, unknown>;
}

export const WorkspaceConfigSchema = z.object({
  packages: z.array(z.string()).optional(),
  catalogs: z.record(z.unknown()).optional(),
});

export type WorkspaceConfigInput = z.input<typeof WorkspaceConfigSchema>;
export type WorkspaceConfigOutput = z.output<typeof WorkspaceConfigSchema>;

export type MonorepoType = 'pnpm' | 'npm' | 'yarn' | 'turbo' | 'nx' | 'lerna';

export interface MonorepoInfo {
  readonly type: MonorepoType;
  readonly rootPath: string;
  readonly config?: WorkspaceConfig;
  readonly manifestPaths: readonly string[];
}

export function createMonorepoInfo(params: {
  type: MonorepoType;
  rootPath: string;
  manifestPaths: readonly string[];
  config?: WorkspaceConfig;
}): MonorepoInfo {
  return {
    type: params.type,
    rootPath: params.rootPath,
    manifestPaths: params.manifestPaths,
    ...(params.config !== undefined ? { config: params.config } : {}),
  };
}

export const MonorepoInfoSchema = z.object({
  type: z.enum(['pnpm', 'npm', 'yarn', 'turbo', 'nx', 'lerna']),
  rootPath: z.string().min(1),
  config: WorkspaceConfigSchema.optional(),
  manifestPaths: z.array(z.string()),
});

export type MonorepoInfoInput = z.input<typeof MonorepoInfoSchema>;
export type MonorepoInfoOutput = z.output<typeof MonorepoInfoSchema>;

export interface ProjectRoot {
  readonly path: string;
  readonly name: string;
  readonly type: ProjectType;
  readonly manifests: readonly ProjectManifest[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly isMonorepoRoot: boolean;
  readonly monorepoInfo?: MonorepoInfo;
}

export function createProjectRoot(params: {
  path: string;
  name: string;
  type: ProjectType;
  manifests: readonly ProjectManifest[];
  languages: readonly string[];
  frameworks: readonly string[];
  isMonorepoRoot: boolean;
  monorepoInfo?: MonorepoInfo;
}): ProjectRoot {
  return {
    path: params.path,
    name: params.name,
    type: params.type,
    manifests: params.manifests,
    languages: params.languages,
    frameworks: params.frameworks,
    isMonorepoRoot: params.isMonorepoRoot,
    ...(params.monorepoInfo !== undefined ? { monorepoInfo: params.monorepoInfo } : {}),
  };
}

export const ProjectRootSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  type: z.enum([
    'npm',
    'pnpm',
    'yarn',
    'cargo',
    'go',
    'maven',
    'gradle',
    'dotnet',
    'composer',
    'bundler',
    'pip',
    'poetry',
    'unknown',
  ]),
  manifests: z.array(ProjectManifestSchema),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  isMonorepoRoot: z.boolean(),
  monorepoInfo: MonorepoInfoSchema.optional(),
});

export type ProjectRootInput = z.input<typeof ProjectRootSchema>;
export type ProjectRootOutput = z.output<typeof ProjectRootSchema>;

export interface WorkspaceIdentity {
  readonly id: string;
  readonly folderUris: readonly string[];
}

export interface WorkspaceChangeEvent {
  readonly type: 'added' | 'removed' | 'changed';
  readonly folder: WorkspaceFolder;
  readonly previousFolder?: WorkspaceFolder;
  readonly timestamp: number;
}

export const WorkspaceChangeEventSchema = z.object({
  type: z.enum(['added', 'removed', 'changed']),
  folder: WorkspaceFolderSchema,
  previousFolder: WorkspaceFolderSchema.optional(),
  timestamp: z.number().int().nonnegative(),
});

export type WorkspaceChangeEventInput = z.input<typeof WorkspaceChangeEventSchema>;
export type WorkspaceChangeEventOutput = z.output<typeof WorkspaceChangeEventSchema>;