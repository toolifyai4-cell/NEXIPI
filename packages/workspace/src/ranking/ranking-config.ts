import { z } from 'zod';
import type { ContextSelectionOptions } from './ranking-types.js';

const RankingWeightsSchema = z.object({
  filename: z.number().min(0).max(1).default(0.20),
  relativePath: z.number().min(0).max(1).default(0.15),
  directory: z.number().min(0).max(1).default(0.10),
  extensionLanguage: z.number().min(0).max(1).default(0.10),
  projectManifestConfig: z.number().min(0).max(1).default(0.10),
  testFile: z.number().min(0).max(1).default(0.10),
  entryPoint: z.number().min(0).max(1).default(0.05),
  taskType: z.number().min(0).max(1).default(0.10),
  explicitMention: z.number().min(0).max(1).default(0.15),
  classificationSafety: z.number().min(0).max(1).default(0.05),
});

export type RankingWeightsConfig = z.infer<typeof RankingWeightsSchema>;

export const defaultRankingWeightsConfig: RankingWeightsConfig = {
  filename: 0.20,
  relativePath: 0.15,
  directory: 0.10,
  extensionLanguage: 0.08,
  projectManifestConfig: 0.06,
  testFile: 0.08,
  entryPoint: 0.08,
  taskType: 0.08,
  explicitMention: 0.10,
  classificationSafety: 0.07,
};

export function validateRankingWeights(config: unknown): RankingWeightsConfig {
  return RankingWeightsSchema.parse(config);
}

export function safeValidateRankingWeights(
  config: unknown
): { success: true; data: RankingWeightsConfig } | { success: false; error: z.ZodError } {
  const result = RankingWeightsSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

const RankingConfigSchema = z.object({
  minRelevanceScore: z.number().min(0).max(1).default(0.1),
  maxFileCount: z.number().int().positive().default(20),
  maxBudget: z.number().int().positive().default(100000),
  perFileBaseCost: z.number().int().nonnegative().default(512),
  perByteCost: z.number().min(0).max(1).default(0.001),
  enableDiversity: z.boolean().default(true),
  maxPerDirectory: z.number().int().positive().default(3),
  maxPerProject: z.number().int().positive().default(10),
  weights: RankingWeightsSchema.default(defaultRankingWeightsConfig),
});

export type RankingConfig = z.infer<typeof RankingConfigSchema>;

export const defaultRankingConfig: RankingConfig = {
  minRelevanceScore: 0.1,
  maxFileCount: 20,
  maxBudget: 100000,
  perFileBaseCost: 512,
  perByteCost: 0.001,
  enableDiversity: true,
  maxPerDirectory: 3,
  maxPerProject: 10,
  weights: defaultRankingWeightsConfig,
};

export function validateRankingConfig(config: unknown): RankingConfig {
  return RankingConfigSchema.parse(config);
}

export function safeValidateRankingConfig(
  config: unknown
): { success: true; data: RankingConfig } | { success: false; error: z.ZodError } {
  const result = RankingConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function toContextSelectionOptions(
  config: RankingConfig,
  overrides: Partial<ContextSelectionOptions> = {}
): ContextSelectionOptions {
  const base: ContextSelectionOptions = {
    maxFileCount: config.maxFileCount,
    maxBudget: config.maxBudget,
    minRelevanceScore: config.minRelevanceScore,
    enableDiversity: config.enableDiversity,
    maxPerDirectory: config.maxPerDirectory,
    maxPerProject: config.maxPerProject,
  };
  return {
    ...base,
    ...(overrides.priorityMentions !== undefined
      ? { priorityMentions: overrides.priorityMentions }
      : {}),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}
