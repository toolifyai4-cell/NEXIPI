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

export const WorkspaceConfigSchema = z.object({
  discovery: WorkspaceDiscoveryConfigSchema.optional(),
  analysis: ProjectAnalysisConfigSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const defaultWorkspaceConfig: WorkspaceConfig = {
  discovery: defaultWorkspaceDiscoveryConfig,
  analysis: defaultProjectAnalysisConfig,
};

export function validateWorkspaceConfig(config: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(config);
}

export function safeValidateWorkspaceConfig(
  config: unknown
): { success: true; data: WorkspaceConfig } | { success: false; error: z.ZodError } {
  const result = WorkspaceConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}