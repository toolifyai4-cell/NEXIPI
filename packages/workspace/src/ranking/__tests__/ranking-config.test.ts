import { describe, it, expect } from 'vitest';
import {
  validateRankingConfig,
  safeValidateRankingConfig,
  defaultRankingConfig,
  defaultRankingWeightsConfig,
  validateRankingWeights,
  toContextSelectionOptions,
  type RankingConfig,
} from '../ranking-config.js';

describe('RankingConfig', () => {
  describe('defaults', () => {
    it('has sensible default values', () => {
      expect(defaultRankingConfig.minRelevanceScore).toBe(0.1);
      expect(defaultRankingConfig.maxFileCount).toBe(20);
      expect(defaultRankingConfig.maxBudget).toBe(100000);
      expect(defaultRankingConfig.perFileBaseCost).toBe(512);
      expect(defaultRankingConfig.perByteCost).toBe(0.001);
      expect(defaultRankingConfig.enableDiversity).toBe(true);
      expect(defaultRankingConfig.maxPerDirectory).toBe(3);
      expect(defaultRankingConfig.maxPerProject).toBe(10);
    });

    it('has default weights that sum to 1.0', () => {
      const w = defaultRankingWeightsConfig;
      const sum = w.filename + w.relativePath + w.directory + w.extensionLanguage +
        w.projectManifestConfig + w.testFile + w.entryPoint + w.taskType +
        w.explicitMention + w.classificationSafety;
      expect(sum).toBeCloseTo(1.0, 2);
    });
  });

  describe('validateRankingConfig', () => {
    it('accepts valid config', () => {
      const result = validateRankingConfig({});
      expect(result).toEqual(defaultRankingConfig);
    });

    it('accepts partial config with defaults applied', () => {
      const result = validateRankingConfig({ maxFileCount: 50 });
      expect(result.maxFileCount).toBe(50);
      expect(result.minRelevanceScore).toBe(defaultRankingConfig.minRelevanceScore);
    });

    it('rejects minRelevanceScore below 0', () => {
      expect(() => validateRankingConfig({ minRelevanceScore: -0.1 })).toThrow();
    });

    it('rejects minRelevanceScore above 1', () => {
      expect(() => validateRankingConfig({ minRelevanceScore: 1.1 })).toThrow();
    });

    it('rejects non-positive maxFileCount', () => {
      expect(() => validateRankingConfig({ maxFileCount: 0 })).toThrow();
      expect(() => validateRankingConfig({ maxFileCount: -1 })).toThrow();
    });

    it('rejects non-positive maxBudget', () => {
      expect(() => validateRankingConfig({ maxBudget: 0 })).toThrow();
    });

    it('rejects non-positive perFileBaseCost', () => {
      expect(() => validateRankingConfig({ perFileBaseCost: -1 })).toThrow();
    });

    it('rejects perByteCost outside 0-1', () => {
      expect(() => validateRankingConfig({ perByteCost: -0.1 })).toThrow();
      expect(() => validateRankingConfig({ perByteCost: 1.1 })).toThrow();
    });

    it('rejects non-positive maxPerDirectory', () => {
      expect(() => validateRankingConfig({ maxPerDirectory: 0 })).toThrow();
    });

    it('rejects non-positive maxPerProject', () => {
      expect(() => validateRankingConfig({ maxPerProject: 0 })).toThrow();
    });
  });

  describe('safeValidateRankingConfig', () => {
    it('returns success for valid config', () => {
      const result = safeValidateRankingConfig({ maxFileCount: 10 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxFileCount).toBe(10);
      }
    });

    it('returns failure for invalid config', () => {
      const result = safeValidateRankingConfig({ minRelevanceScore: 99 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('validateRankingWeights', () => {
    it('accepts valid weights', () => {
      const result = validateRankingWeights({ filename: 0.5, relativePath: 0.5 });
      expect(result.filename).toBe(0.5);
      expect(result.relativePath).toBe(0.5);
    });

    it('rejects weight below 0', () => {
      expect(() => validateRankingWeights({ filename: -0.1 })).toThrow();
    });

    it('rejects weight above 1', () => {
      expect(() => validateRankingWeights({ filename: 1.1 })).toThrow();
    });
  });

  describe('toContextSelectionOptions', () => {
    it('converts config to selection options', () => {
      const config: RankingConfig = {
        minRelevanceScore: 0.2,
        maxFileCount: 10,
        maxBudget: 50000,
        perFileBaseCost: 256,
        perByteCost: 0.002,
        enableDiversity: false,
        maxPerDirectory: 2,
        maxPerProject: 5,
        weights: defaultRankingWeightsConfig,
      };
      const options = toContextSelectionOptions(config);
      expect(options.maxFileCount).toBe(10);
      expect(options.maxBudget).toBe(50000);
      expect(options.minRelevanceScore).toBe(0.2);
      expect(options.enableDiversity).toBe(false);
      expect(options.maxPerDirectory).toBe(2);
      expect(options.maxPerProject).toBe(5);
    });

    it('applies priority mentions override', () => {
      const options = toContextSelectionOptions(defaultRankingConfig, {
        priorityMentions: ['src/auth.ts'],
      });
      expect(options.priorityMentions).toEqual(['src/auth.ts']);
    });

    it('applies signal override', () => {
      const ac = new AbortController();
      const options = toContextSelectionOptions(defaultRankingConfig, {
        signal: ac.signal,
      });
      expect(options.signal).toBe(ac.signal);
    });

    it('preserves signal alone', () => {
      const ac = new AbortController();
      const options = toContextSelectionOptions(defaultRankingConfig, {
        signal: ac.signal,
      });
      expect(options.signal).toBe(ac.signal);
      expect(options.priorityMentions).toBeUndefined();
      expect(options.maxFileCount).toBe(defaultRankingConfig.maxFileCount);
    });

    it('preserves priority mentions alone', () => {
      const options = toContextSelectionOptions(defaultRankingConfig, {
        priorityMentions: ['src/auth.ts'],
      });
      expect(options.priorityMentions).toEqual(['src/auth.ts']);
      expect(options.signal).toBeUndefined();
    });

    it('preserves signal and priority mentions together', () => {
      const ac = new AbortController();
      const options = toContextSelectionOptions(defaultRankingConfig, {
        priorityMentions: ['src/auth.ts'],
        signal: ac.signal,
      });
      expect(options.priorityMentions).toEqual(['src/auth.ts']);
      expect(options.signal).toBe(ac.signal);
    });

    it('combines signal and priority with config-derived selection options', () => {
      const ac = new AbortController();
      const options = toContextSelectionOptions(defaultRankingConfig, {
        priorityMentions: ['src/auth.ts'],
        signal: ac.signal,
      });
      expect(options.priorityMentions).toEqual(['src/auth.ts']);
      expect(options.signal).toBe(ac.signal);
      expect(options.maxFileCount).toBe(defaultRankingConfig.maxFileCount);
      expect(options.minRelevanceScore).toBe(defaultRankingConfig.minRelevanceScore);
      expect(options.enableDiversity).toBe(defaultRankingConfig.enableDiversity);
      expect(options.maxPerDirectory).toBe(defaultRankingConfig.maxPerDirectory);
      expect(options.maxPerProject).toBe(defaultRankingConfig.maxPerProject);
    });

    it('leaves optional values undefined when not supplied', () => {
      const options = toContextSelectionOptions(defaultRankingConfig);
      expect(options.priorityMentions).toBeUndefined();
      expect(options.signal).toBeUndefined();
      expect(options.maxFileCount).toBe(defaultRankingConfig.maxFileCount);
    });
  });
});
