import { z } from 'zod';

export const EngineConfigSchema = z.object({
  name: z.string().min(1).default('nexipi'),
  version: z.string().min(1).default('0.0.1'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  maxConcurrentTasks: z.number().int().positive().default(10),
  taskTimeoutMs: z.number().int().positive().default(30000),
  shutdownTimeoutMs: z.number().int().positive().default(10000),
  enableTelemetry: z.boolean().default(false),
});

export type EngineConfig = z.infer<typeof EngineConfigSchema>;

export const defaultEngineConfig: EngineConfig = {
  name: 'nexipi',
  version: '0.0.1',
  logLevel: 'info',
  maxConcurrentTasks: 10,
  taskTimeoutMs: 30000,
  shutdownTimeoutMs: 10000,
  enableTelemetry: false,
};

export function validateEngineConfig(config: unknown): EngineConfig {
  return EngineConfigSchema.parse(config);
}

export function safeValidateEngineConfig(
  config: unknown
): { success: true; data: EngineConfig } | { success: false; error: z.ZodError } {
  const result = EngineConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export function mergeEngineConfig(
  base: EngineConfig,
  override: Partial<EngineConfig>
): EngineConfig {
  return EngineConfigSchema.parse({ ...base, ...override });
}

export type { LogLevel } from '@nexipi/shared';
