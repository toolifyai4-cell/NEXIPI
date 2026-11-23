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

export type FileCategory = 'source' | 'config' | 'manifest' | 'binary' | 'sensitive' | 'other';

export interface DiscoveredFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly projectId?: string;
}

export interface FileMetadata {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly projectId?: string;
  readonly absolutePath: string;
  readonly uri: string;
  readonly relativePath: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly mtime: number | null;
  readonly language: string | null;
  readonly category: FileCategory;
  readonly isHidden: boolean;
  readonly isManifest: boolean;
  readonly isConfig: boolean;
  readonly isBinary: boolean;
  readonly isSensitive: boolean;
  readonly sourceExcluded: boolean;
}

export function createFileMetadata(params: {
  id: string;
  workspaceId: string;
  workspaceFolderId: WorkspaceFolderId;
  projectId?: string;
  absolutePath: string;
  uri: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  mtime: number | null;
  language: string | null;
  category: FileCategory;
  isHidden: boolean;
  isManifest: boolean;
  isConfig: boolean;
  isBinary: boolean;
  isSensitive: boolean;
}): FileMetadata {
  return {
    id: params.id,
    workspaceId: params.workspaceId,
    workspaceFolderId: params.workspaceFolderId,
    ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
    absolutePath: params.absolutePath,
    uri: params.uri,
    relativePath: params.relativePath,
    name: params.name,
    extension: params.extension,
    size: params.size,
    mtime: params.mtime,
    language: params.language,
    category: params.category,
    isHidden: params.isHidden,
    isManifest: params.isManifest,
    isConfig: params.isConfig,
    isBinary: params.isBinary,
    isSensitive: params.isSensitive,
    sourceExcluded: params.isSensitive || params.isBinary,
  };
}

export const FileMetadataSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceFolderId: z.string().min(1),
  projectId: z.string().optional(),
  absolutePath: z.string().min(1),
  uri: z.string().min(1),
  relativePath: z.string().min(1),
  name: z.string().min(1),
  extension: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().nullable(),
  language: z.string().nullable(),
  category: z.enum(['source', 'config', 'manifest', 'binary', 'sensitive', 'other']),
  isHidden: z.boolean(),
  isManifest: z.boolean(),
  isConfig: z.boolean(),
  isBinary: z.boolean(),
  isSensitive: z.boolean(),
  sourceExcluded: z.boolean(),
});

export type FileMetadataInput = z.input<typeof FileMetadataSchema>;
export type FileMetadataOutput = z.output<typeof FileMetadataSchema>;

export interface FileDiscoveryResult {
  readonly workspaceId: string;
  readonly files: readonly FileMetadata[];
  readonly count: number;
  readonly truncated: boolean;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly errors: readonly DiscoveryError[];
}

export interface DiscoveryError {
  readonly path: string;
  readonly message: string;
  readonly isFatal: boolean;
}

export type FileDiscoveryResultOutput = FileDiscoveryResult;

export interface ExclusionPrecedence {
  readonly mandatorySafety: readonly string[];
  readonly defaults: readonly string[];
  readonly gitignore: readonly string[];
  readonly user: readonly string[];
}

export function createDefaultExclusionPrecedence(): ExclusionPrecedence {
  return {
    mandatorySafety: [],
    defaults: [],
    gitignore: [],
    user: [],
  };
}

export interface MonorepoPackagePattern {
  readonly pattern: string;
  readonly source: 'package.json' | 'pnpm-workspace' | 'yarn-workspaces' | 'lerna' | 'nx' | 'turbo';
}

export interface ExpandedPackage {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
  readonly matchedPattern: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly projectId?: string;
}

export interface SensitiveFileRule {
  readonly name: string;
  readonly patterns: readonly string[];
  readonly description: string;
}