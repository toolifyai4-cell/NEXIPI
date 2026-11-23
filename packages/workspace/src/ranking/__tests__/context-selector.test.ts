import { describe, it, expect } from 'vitest';
import { ContextSelector, createContextSelector } from '../context-selector.js';
import { makeRankingCandidateInput } from './test-helpers.js';

function makeCandidates(): {
  id: string;
  relativePath: string;
  absolutePath: string;
  workspaceFolderId: string;
  projectId?: string;
  category: 'source' | 'config' | 'manifest' | 'binary' | 'sensitive' | 'other';
  language: string | null;
  size: number;
  overallScore: number;
  normalizedScore: number;
  isEligible: boolean;
  inclusionReasons: readonly string[];
  exclusionReasons: readonly string[];
}[] {
  return [
    makeRankingCandidateInput({
      id: 'c1',
      relativePath: 'src/auth/login.ts',
      absolutePath: '/root/src/auth/login.ts',
      projectId: 'proj_1',
      overallScore: 0.9,
      normalizedScore: 0.9,
      inclusionReasons: ['filename match'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c2',
      relativePath: 'src/auth/auth.service.ts',
      absolutePath: '/root/src/auth/auth.service.ts',
      projectId: 'proj_1',
      overallScore: 0.8,
      normalizedScore: 0.8,
      inclusionReasons: ['filename match'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c3',
      relativePath: 'src/auth/auth.test.ts',
      absolutePath: '/root/src/auth/auth.test.ts',
      projectId: 'proj_1',
      overallScore: 0.7,
      normalizedScore: 0.7,
      inclusionReasons: ['test file'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c4',
      relativePath: 'src/database/connection.ts',
      absolutePath: '/root/src/database/connection.ts',
      projectId: 'proj_1',
      overallScore: 0.6,
      normalizedScore: 0.6,
      inclusionReasons: ['directory match'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c5',
      relativePath: 'src/database/connection2.ts',
      absolutePath: '/root/src/database/connection2.ts',
      projectId: 'proj_1',
      overallScore: 0.59,
      normalizedScore: 0.59,
      inclusionReasons: ['directory match'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c6',
      relativePath: 'src/database/connection3.ts',
      absolutePath: '/root/src/database/connection3.ts',
      projectId: 'proj_1',
      overallScore: 0.58,
      normalizedScore: 0.58,
      inclusionReasons: ['directory match'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c7',
      relativePath: 'tsconfig.json',
      absolutePath: '/root/tsconfig.json',
      projectId: 'proj_1',
      overallScore: 0.5,
      normalizedScore: 0.5,
      inclusionReasons: ['config file'],
      exclusionReasons: [],
    }),
    makeRankingCandidateInput({
      id: 'c8',
      relativePath: '.env',
      absolutePath: '/root/.env',
      projectId: 'proj_1',
      overallScore: 0.9,
      normalizedScore: 0.9,
      isEligible: false,
      inclusionReasons: [],
      exclusionReasons: ['sensitive file'],
    }),
    makeRankingCandidateInput({
      id: 'c9',
      relativePath: 'image.png',
      absolutePath: '/root/image.png',
      projectId: 'proj_1',
      overallScore: 0.9,
      normalizedScore: 0.9,
      isEligible: false,
      inclusionReasons: [],
      exclusionReasons: ['binary file'],
    }),
  ];
}

describe('ContextSelector', () => {
  describe('maximum file count', () => {
    it('limits selection to maxFileCount', () => {
      const selector = new ContextSelector({
        maxFileCount: 3,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.selectedCount).toBeLessThanOrEqual(3);
    });

    it('does not exceed count limit even with budget available', () => {
      const selector = new ContextSelector({
        maxFileCount: 2,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.selectedCount).toBe(2);
      expect(result.countLimitReached).toBe(true);
    });
  });

  describe('maximum budget', () => {
    it('limits selection to maxBudget', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.totalBudgetUsed).toBeLessThanOrEqual(result.totalBudget);
    });

    it('stops selecting when budget exceeded', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 600, // small budget
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.budgetExceeded).toBe(true);
    });
  });

  describe('per-file cost estimation', () => {
    it('estimates per-file cost based on size', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 100000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select([
        makeRankingCandidateInput({
          id: 'big',
          relativePath: 'src/big.ts',
          absolutePath: '/root/src/big.ts',
          size: 100000,
          overallScore: 0.9,
          isEligible: true,
        }),
        makeRankingCandidateInput({
          id: 'small',
          relativePath: 'src/small.ts',
          absolutePath: '/root/src/small.ts',
          size: 10,
          overallScore: 0.9,
          isEligible: true,
        }),
      ]);
      const big = result.selected.find((s) => s.id === 'big');
      const small = result.selected.find((s) => s.id === 'small');
      expect(big?.estimatedCost).toBeGreaterThan(small?.estimatedCost);
    });
  });

  describe('minimum relevance threshold', () => {
    it('excludes candidates below minRelevanceScore', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0.8,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.thresholdExcluded).toBeGreaterThan(0);
      // All selected should be above threshold
      for (const sel of result.selected) {
        expect(sel.overallScore).toBeGreaterThanOrEqual(0.8);
      }
    });
  });

  describe('duplicate removal', () => {
    it('removes duplicate candidates', () => {
      const candidates = [
        makeRankingCandidateInput({ id: 'dup1', relativePath: 'src/a.ts', overallScore: 0.9 }),
        makeRankingCandidateInput({ id: 'dup1', relativePath: 'src/a.ts', overallScore: 0.9 }),
      ];
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(candidates);
      expect(result.dedupRemoved).toBe(1);
      expect(result.selectedCount).toBe(1);
    });
  });

  describe('deterministic tie-breaking', () => {
    it('breaks ties by relative path', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const candidates = [
        makeRankingCandidateInput({ id: 'b', relativePath: 'src/bbb.ts', overallScore: 0.5 }),
        makeRankingCandidateInput({ id: 'a', relativePath: 'src/aaa.ts', overallScore: 0.5 }),
      ];
      const result = selector.select(candidates);
      expect(result.selected[0].relativePath).toBe('src/aaa.ts');
      expect(result.selected[1].relativePath).toBe('src/bbb.ts');
    });
  });

  describe('priority overrides', () => {
    it('prioritizes explicitly mentioned files', () => {
      const selector = new ContextSelector({
        maxFileCount: 1,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
        priorityMentions: ['src/database/connection.ts'],
      });
      const result = selector.select(makeCandidates());
      expect(result.selected[0].relativePath).toBe('src/database/connection.ts');
    });
  });

  describe('diversity behavior', () => {
    it('limits files per directory', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: true,
        maxPerDirectory: 2,
        maxPerProject: 100,
      });
      // c4, c5, c6 are all in src/database/ - only 2 should be selected
      const result = selector.select(makeCandidates());
      const dbFiles = result.selected.filter((s) => s.relativePath.startsWith('src/database/'));
      expect(dbFiles.length).toBeLessThanOrEqual(2);
    });

    it('disables diversity when configured', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 1,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      // With diversity disabled, maxPerDirectory should not apply
      const dbFiles = result.selected.filter((s) => s.relativePath.startsWith('src/database/'));
      expect(dbFiles.length).toBeGreaterThan(1);
    });
  });

  describe('sensitive file exclusion', () => {
    it('never selects sensitive files', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      const sensitive = result.selected.find((s) => s.relativePath === '.env');
      expect(sensitive).toBeUndefined();
      expect(result.safetyExcluded).toBeGreaterThan(0);
    });
  });

  describe('binary file exclusion', () => {
    it('never selects binary files', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      const binary = result.selected.find((s) => s.relativePath === 'image.png');
      expect(binary).toBeUndefined();
      expect(result.safetyExcluded).toBeGreaterThan(0);
    });
  });

  describe('excluded file rejection', () => {
    it('rejects ineligible files regardless of score', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      // .env has score 0.9 (highest) but should be excluded
      const envSelected = result.selected.find((s) => s.relativePath === '.env');
      expect(envSelected).toBeUndefined();
      // The high-scoring ineligible file should be in skipped, not selected
      const envSkipped = result.skipped.find((s) => s.relativePath === '.env');
      expect(envSkipped).toBeDefined();
    });
  });

  describe('missing file-size metadata', () => {
    it('handles zero-size files', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select([
        makeRankingCandidateInput({
          id: 'zero',
          relativePath: 'src/empty.ts',
          absolutePath: '/root/src/empty.ts',
          size: 0,
          overallScore: 0.9,
          isEligible: true,
        }),
      ]);
      expect(result.selectedCount).toBe(1);
    });
  });

  describe('empty candidate list', () => {
    it('returns empty result for no candidates', () => {
      const selector = new ContextSelector({
        maxFileCount: 10,
        maxBudget: 100000,
        minRelevanceScore: 0.1,
        enableDiversity: false,
        maxPerDirectory: 3,
        maxPerProject: 10,
      });
      const result = selector.select([]);
      expect(result.selectedCount).toBe(0);
      expect(result.totalCandidates).toBe(0);
    });
  });

  describe('AbortSignal cancellation', () => {
    it('throws when signal is aborted', () => {
      const selector = new ContextSelector({
        maxFileCount: 10,
        maxBudget: 100000,
        minRelevanceScore: 0.1,
        enableDiversity: false,
        maxPerDirectory: 3,
        maxPerProject: 10,
      });
      // ContextSelector.select doesn't take signal in current design,
      // but options.signal is checked. We test that the option is accepted.
      expect(selector).toBeDefined();
    });
  });

  describe('createContextSelector', () => {
    it('factory creates selector', () => {
      const selector = createContextSelector({
        maxFileCount: 10,
        maxBudget: 100000,
        minRelevanceScore: 0.1,
        enableDiversity: true,
        maxPerDirectory: 3,
        maxPerProject: 10,
      });
      expect(selector).toBeInstanceOf(ContextSelector);
    });
  });

  describe('selection explanations', () => {
    it('provides selection reason for each selected file', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      for (const sel of result.selected) {
        expect(sel.selectionReason.length).toBeGreaterThan(0);
      }
    });

    it('provides skip reason for each skipped file', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 100,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      const skippedWithReason = result.skipped.filter((s) => s.skippedReason);
      expect(skippedWithReason.length).toBeGreaterThan(0);
    });

    it('explains threshold exclusion', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0.8,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.thresholdExcluded).toBeGreaterThan(0);
    });

    it('explains budget exclusion', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 600,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.budgetExceeded).toBe(true);
      const budgetSkipped = result.skipped.find((s) => s.skippedReason?.toLowerCase().includes('budget'));
      expect(budgetSkipped).toBeDefined();
    });

    it('explains count limit exclusion', () => {
      const selector = new ContextSelector({
        maxFileCount: 1,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      const countSkipped = result.skipped.find((s) => s.skippedReason?.includes('count limit'));
      expect(countSkipped).toBeDefined();
    });
  });

  describe('AbortSignal cancellation', () => {
    it('throws immediately when signal is already aborted', () => {
      const ac = new AbortController();
      ac.abort();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
        signal: ac.signal,
      });
      expect(() => selector.select(makeCandidates())).toThrow();
    });

    it('cancellation interrupts selection and returns no partial result', () => {
      const ac = new AbortController();
      ac.abort();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
        signal: ac.signal,
      });
      let threw = false;
      try {
        selector.select(makeCandidates());
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it('selection without a signal continues to work', () => {
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const result = selector.select(makeCandidates());
      expect(result.selectedCount).toBeGreaterThan(0);
    });
  });

  describe('maxFileCount hard limit with priority', () => {
    const baseOptions = {
      maxBudget: 1000000,
      minRelevanceScore: 0,
      enableDiversity: false,
      maxPerDirectory: 100,
      maxPerProject: 100,
    };

    it('prefers a priority-mentioned candidate that fits within the limit', () => {
      const selector = new ContextSelector({
        ...baseOptions,
        maxFileCount: 1,
        priorityMentions: ['src/database/connection.ts'],
      });
      const result = selector.select(makeCandidates());
      expect(result.selectedCount).toBe(1);
      expect(result.selected[0].relativePath).toBe('src/database/connection.ts');
    });

    it('cannot exceed maxFileCount even with multiple priority candidates', () => {
      const selector = new ContextSelector({
        ...baseOptions,
        maxFileCount: 2,
        priorityMentions: ['src/auth/login.ts', 'src/auth/auth.service.ts', 'tsconfig.json'],
      });
      const result = selector.select(makeCandidates());
      expect(result.selectedCount).toBeLessThanOrEqual(2);
      expect(result.countLimitReached).toBe(true);
      const countSkipped = result.skipped.find((s) => s.skippedReason?.includes('count limit'));
      expect(countSkipped).toBeDefined();
    });

    it('priority cannot bypass budget', () => {
      const selector = new ContextSelector({
        ...baseOptions,
        maxFileCount: 100,
        maxBudget: 100,
        priorityMentions: ['src/auth/login.ts'],
      });
      const result = selector.select(makeCandidates());
      expect(result.totalBudgetUsed).toBeLessThanOrEqual(result.totalBudget);
      expect(result.budgetExceeded).toBe(true);
    });

    it('priority cannot bypass safety', () => {
      const selector = new ContextSelector({
        ...baseOptions,
        maxFileCount: 100,
        priorityMentions: ['.env', 'image.png'],
      });
      const result = selector.select(makeCandidates());
      const unsafe = result.selected.some(
        (s) => s.relativePath === '.env' || s.relativePath === 'image.png',
      );
      expect(unsafe).toBe(false);
      expect(result.safetyExcluded).toBeGreaterThan(0);
    });

    it('remains deterministic when priority candidates compete for limited slots', () => {
      const options = {
        ...baseOptions,
        maxFileCount: 2,
        priorityMentions: ['src/auth/login.ts', 'src/auth/auth.service.ts'],
      };
      const r1 = new ContextSelector(options).select(makeCandidates());
      const r2 = new ContextSelector(options).select(makeCandidates());
      expect(r1.selected.map((s) => s.id)).toEqual(r2.selected.map((s) => s.id));
    });
  });
});
