import { z } from 'zod';

export const WorkspaceDiscoveryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxDepth: z.number().int().positive().default(3),
  includeHidden: z.boolean().default(false),
  followSymlinks: z.boolean().default(false),
  workspaceLessMode: z.enum(['error', 'temporary', 'none']).default('temporary'),
});

export type WorkspaceDiscoveryConfig = z.infer<typeof WorkspaceDiscoveryConfigSchema>;

export const defaultWorkspaceDiscoveryConfig: WorkspaceDiscoveryConfig = {
  enabled: true,
  maxDepth: 3,
  includeHidden: false,
  followSymlinks: false,
  workspaceLessMode: 'temporary',
};

export function validateWorkspaceDiscoveryConfig(config: unknown): WorkspaceDiscoveryConfig {
  return WorkspaceDiscoveryConfigSchema.parse(config);
}

export function safeValidateWorkspaceDiscoveryConfig(
  config: unknown
): { success: true; data: WorkspaceDiscoveryConfig } | { success: false; error: z.ZodError } {
  const result = WorkspaceDiscoveryConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export const ProjectAnalysisConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxDepth: z.number().int().positive().default(5),
  detectLanguages: z.boolean().default(true),
  detectFrameworks: z.boolean().default(true),
  detectMonorepos: z.boolean().default(true),
  parseManifests: z.boolean().default(true),
  includeRawManifestData: z.boolean().default(false),
});

export type ProjectAnalysisConfig = z.infer<typeof ProjectAnalysisConfigSchema>;

export const defaultProjectAnalysisConfig: ProjectAnalysisConfig = {
  enabled: true,
  maxDepth: 5,
  detectLanguages: true,
  detectFrameworks: true,
  detectMonorepos: true,
  parseManifests: true,
  includeRawManifestData: false,
};

export function validateProjectAnalysisConfig(config: unknown): ProjectAnalysisConfig {
  return ProjectAnalysisConfigSchema.parse(config);
}

export function safeValidateProjectAnalysisConfig(
  config: unknown
): { success: true; data: ProjectAnalysisConfig } | { success: false; error: z.ZodError } {
  const result = ProjectAnalysisConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export const WorkspaceIntelligenceConfigSchema = z.object({
  discovery: WorkspaceDiscoveryConfigSchema.optional(),
  analysis: ProjectAnalysisConfigSchema.optional(),
});

export type WorkspaceIntelligenceConfig = z.infer<typeof WorkspaceIntelligenceConfigSchema>;

export const defaultWorkspaceIntelligenceConfig: WorkspaceIntelligenceConfig = {
  discovery: defaultWorkspaceDiscoveryConfig,
  analysis: defaultProjectAnalysisConfig,
};

export function validateWorkspaceIntelligenceConfig(config: unknown): WorkspaceIntelligenceConfig {
  return WorkspaceIntelligenceConfigSchema.parse(config);
}

export function safeValidateWorkspaceIntelligenceConfig(
  config: unknown
): { success: true; data: WorkspaceIntelligenceConfig } | { success: false; error: z.ZodError } {
  const result = WorkspaceIntelligenceConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export const MandatorySafetyExclusions = [
  '.git',
] as const;

export const DefaultDirectoryExclusions = [
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.nx',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
] as const;

export type DefaultExclusionName = (typeof DefaultDirectoryExclusions)[number];

export interface DefaultExclusionConfig {
  readonly mandatory: readonly string[];
  readonly defaults: readonly string[];
}

export const defaultExclusionConfig: DefaultExclusionConfig = {
  mandatory: MandatorySafetyExclusions,
  defaults: DefaultDirectoryExclusions,
};

export const SensitiveFilePatterns = [
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.ppk',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.crt',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
] as const;

export const BinaryFileExtensions = [
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'o',
  'obj',
  'class',
  'jar',
  'war',
  'ear',
  'zip',
  'tar',
  'gz',
  'bz2',
  '7z',
  'rar',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'svg',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'mp3',
  'mp4',
  'wav',
  'avi',
  'mov',
  'wmv',
  'flv',
  'iso',
  'dmg',
] as const;

export const ManifestFileNames = [
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
  '*.csproj',
  '*.sln',
] as const;

export const ConfigFileNames = [
  'tsconfig.json',
  'tsconfig.build.json',
  'jsconfig.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc.js',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  'prettier.config.js',
  'babel.config.js',
  'babel.config.json',
  '.babelrc',
  '.babelrc.json',
  'webpack.config.js',
  'webpack.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'rollup.config.js',
  'rollup.config.ts',
  'nest-cli.json',
  'ng.config.json',
  'angular.json',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.gitignore',
  '.dockerignore',
  '.nvimrc',
  '.vimrc',
  '.bashrc',
  '.zshrc',
] as const;

export const FileDiscoveryConfigSchema = z.object({
  maxDepth: z.number().int().positive().default(24),
  maxFileCount: z.number().int().nonnegative().default(100000),
  includeHidden: z.boolean().default(false),
  followSymlinks: z.boolean().default(false),
  enableDefaultExclusions: z.boolean().default(true),
  enableMandatorySafetyExclusions: z.boolean().default(true),
  userExclusions: z.array(z.string()).default([]),
  additionalBinaryExtensions: z.array(z.string()).default([]),
  additionalSensitivePatterns: z.array(z.string()).default([]),
});

export type FileDiscoveryConfig = z.infer<typeof FileDiscoveryConfigSchema>;

export const defaultFileDiscoveryConfig: FileDiscoveryConfig = {
  maxDepth: 24,
  maxFileCount: 100000,
  includeHidden: false,
  followSymlinks: false,
  enableDefaultExclusions: true,
  enableMandatorySafetyExclusions: true,
  userExclusions: [],
  additionalBinaryExtensions: [],
  additionalSensitivePatterns: [],
};

export function validateFileDiscoveryConfig(config: unknown): FileDiscoveryConfig {
  return FileDiscoveryConfigSchema.parse(config);
}

export function safeValidateFileDiscoveryConfig(
  config: unknown
): { success: true; data: FileDiscoveryConfig } | { success: false; error: z.ZodError } {
  const result = FileDiscoveryConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export interface IgnoreEngineConfig {
  readonly caseSensitive: boolean;
}

export const defaultIgnoreEngineConfig: IgnoreEngineConfig = {
  caseSensitive: false,
};

export type ScanConcurrencyPolicy = 'cancel-previous' | 'queue' | 'allow-all';

export const ScanConcurrencyPolicySchema = z.enum([
  'cancel-previous',
  'queue',
  'allow-all',
]);

export type DuplicateScanBehavior = 'reject' | 'allow' | 'cancel-existing';

export const DuplicateScanBehaviorSchema = z.enum(['reject', 'allow', 'cancel-existing']);

export interface WorkspaceScanConfig {
  readonly concurrencyPolicy: ScanConcurrencyPolicy;
  readonly maxConcurrentScans: number;
  readonly maxQueuedScans: number;
  readonly duplicateScanBehavior: DuplicateScanBehavior;
  readonly progressEventFrequency: number;
  readonly incrementalRefresh: {
    readonly enabled: boolean;
    readonly maxChangesPerBatch: number;
  };
}

export const WorkspaceScanConfigSchema = z.object({
  concurrencyPolicy: ScanConcurrencyPolicySchema.default('queue'),
  maxConcurrentScans: z.number().int().positive().default(1),
  maxQueuedScans: z.number().int().nonnegative().default(10),
  duplicateScanBehavior: DuplicateScanBehaviorSchema.default('reject'),
  progressEventFrequency: z.number().int().positive().default(100),
  incrementalRefresh: z
    .object({
      enabled: z.boolean().default(true),
      maxChangesPerBatch: z.number().int().positive().default(100),
    })
    .default({ enabled: true, maxChangesPerBatch: 100 }),
});

export type WorkspaceScanConfigInput = z.input<typeof WorkspaceScanConfigSchema>;
export type WorkspaceScanConfigOutput = z.output<typeof WorkspaceScanConfigSchema>;

export const defaultWorkspaceScanConfig: WorkspaceScanConfig = {
  concurrencyPolicy: 'queue',
  maxConcurrentScans: 1,
  maxQueuedScans: 10,
  duplicateScanBehavior: 'reject',
  progressEventFrequency: 100,
  incrementalRefresh: {
    enabled: true,
    maxChangesPerBatch: 100,
  },
};

export function validateWorkspaceScanConfig(config: unknown): WorkspaceScanConfig {
  return WorkspaceScanConfigSchema.parse(config);
}

export function safeValidateWorkspaceScanConfig(
  config: unknown
): { success: true; data: WorkspaceScanConfig } | { success: false; error: z.ZodError } {
  const result = WorkspaceScanConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}