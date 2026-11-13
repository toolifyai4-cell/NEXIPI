import { describe, it, expect } from 'vitest';
import {
  EngineConfigSchema,
  defaultEngineConfig,
  validateEngineConfig,
  safeValidateEngineConfig,
  mergeEngineConfig,
  type EngineConfig,
  type LogLevel,
} from './config.js';

describe('config', () => {
  describe('EngineConfigSchema', () => {
    it('should validate default config', () => {
      const result = EngineConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data).toEqual(defaultEngineConfig);
    });

    it('should accept valid custom config', () => {
      const customConfig: Partial<EngineConfig> = {
        name: 'custom',
        version: '1.0.0',
        logLevel: 'debug',
        maxConcurrentTasks: 5,
        taskTimeoutMs: 5000,
        enableTelemetry: true,
      };
      const result = EngineConfigSchema.safeParse(customConfig);
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('custom');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.logLevel).toBe('debug');
      expect(result.data.maxConcurrentTasks).toBe(5);
      expect(result.data.taskTimeoutMs).toBe(5000);
      expect(result.data.enableTelemetry).toBe(true);
    });

    it('should reject empty name', () => {
      const result = EngineConfigSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject empty version', () => {
      const result = EngineConfigSchema.safeParse({ version: '' });
      expect(result.success).toBe(false);
    });

    it('should reject invalid logLevel', () => {
      const result = EngineConfigSchema.safeParse({ logLevel: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject non-positive maxConcurrentTasks', () => {
      const result = EngineConfigSchema.safeParse({ maxConcurrentTasks: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject non-positive taskTimeoutMs', () => {
      const result = EngineConfigSchema.safeParse({ taskTimeoutMs: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject non-boolean enableTelemetry', () => {
      const result = EngineConfigSchema.safeParse({ enableTelemetry: 'yes' });
      expect(result.success).toBe(false);
    });
  });

  describe('validateEngineConfig', () => {
    it('should return parsed config on success', () => {
      const config = validateEngineConfig({ name: 'test', version: '1.0.0' });
      expect(config.name).toBe('test');
      expect(config.version).toBe('1.0.0');
    });

    it('should throw on invalid config', () => {
      expect(() => validateEngineConfig({ name: '' })).toThrow();
    });
  });

  describe('safeValidateEngineConfig', () => {
    it('should return success with data on valid config', () => {
      const result = safeValidateEngineConfig({ name: 'test', version: '1.0.0' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('test');
      }
    });

    it('should return failure with error on invalid config', () => {
      const result = safeValidateEngineConfig({ name: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });

  describe('mergeEngineConfig', () => {
    it('should merge override with base config', () => {
      const base: EngineConfig = { ...defaultEngineConfig, name: 'base', maxConcurrentTasks: 3 };
      const merged = mergeEngineConfig(base, { name: 'override', logLevel: 'debug' });
      expect(merged.name).toBe('override');
      expect(merged.maxConcurrentTasks).toBe(3);
      expect(merged.logLevel).toBe('debug');
    });

    it('should validate merged config', () => {
      const base: EngineConfig = defaultEngineConfig;
      expect(() => mergeEngineConfig(base, { name: '' })).toThrow();
    });
  });

  describe('defaultEngineConfig', () => {
    it('should have correct defaults', () => {
      expect(defaultEngineConfig.name).toBe('nexipi');
      expect(defaultEngineConfig.version).toBe('0.0.1');
      expect(defaultEngineConfig.logLevel).toBe('info');
      expect(defaultEngineConfig.maxConcurrentTasks).toBe(10);
      expect(defaultEngineConfig.taskTimeoutMs).toBe(30000);
      expect(defaultEngineConfig.enableTelemetry).toBe(false);
    });
  });
});