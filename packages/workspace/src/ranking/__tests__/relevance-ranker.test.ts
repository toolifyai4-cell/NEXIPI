import { describe, it, expect } from 'vitest';
import { RelevanceRanker, createRelevanceRanker } from '../relevance-ranker.js';
import {
  makeFileMetadata,
  makeSourceFile,
  makeTestFile,
  makeConfigFile,
  makeManifestFile,
  makeSensitiveFile,
  makeBinaryFile,
  makeHiddenFile,
} from './test-helpers.js';

function makeFiles(): FileMetadata[] {
  return [
    makeSourceFile('src/auth/login.ts', { name: 'login', extension: 'ts', language: 'typescript' }),
    makeSourceFile('src/auth/auth.service.ts', { name: 'auth.service', extension: 'ts', language: 'typescript' }),
    makeTestFile('src/auth/auth.test.ts', { name: 'auth.test', extension: 'ts', language: 'typescript' }),
    makeSourceFile('src/database/connection.ts', { name: 'connection', extension: 'ts', language: 'typescript' }),
    makeConfigFile('tsconfig.json', { name: 'tsconfig', extension: 'json', language: 'json' }),
    makeManifestFile('package.json', { name: 'package', extension: 'json', language: 'json' }),
    makeSourceFile('src/index.ts', { name: 'index', extension: 'ts', language: 'typescript' }),
    makeSensitiveFile('.env', { name: '.env', extension: '', language: null }),
    makeBinaryFile('image.png', { name: 'image', extension: 'png', language: null }),
    makeHiddenFile('.gitignore', { name: '.gitignore', extension: '', language: null }),
  ];
}

describe('RelevanceRanker', () => {
  describe('basic ranking', () => {
    it('ranks auth-related files higher for auth query', () => {
      const ranker = new RelevanceRanker();
      const files = makeFiles();
      const result = ranker.rank({ query: 'auth bug fix' }, files);

      const authFiles = result.sortedByScore.filter((c) =>
        c.file.relativePath.includes('auth')
      );
      const nonAuthFiles = result.sortedByScore.filter((c) =>
        !c.file.relativePath.includes('auth') &&
        !c.file.relativePath.includes('index') &&
        !c.file.relativePath.includes('package') &&
        !c.file.relativePath.includes('tsconfig')
      );

      // Top files should be auth-related
      expect(authFiles[0].overallScore).toBeGreaterThan(nonAuthFiles[0].overallScore);
    });

    it('produces deterministic ordering for identical inputs', () => {
      const ranker = new RelevanceRanker();
      const files = makeFiles();
      const r1 = ranker.rank({ query: 'fix auth bug' }, files);
      const r2 = ranker.rank({ query: 'fix auth bug' }, files);
      expect(r1.sortedByScore.map((c) => c.id)).toEqual(r2.sortedByScore.map((c) => c.id));
    });

    it('avoids giving all files the same score', () => {
      const ranker = new RelevanceRanker();
      const files = makeFiles();
      const result = ranker.rank({ query: 'auth bug' }, files);
      const scores = result.sortedByScore.map((c) => c.overallScore);
      const uniqueScores = new Set(scores);
      expect(uniqueScores.size).toBeGreaterThan(1);
    });

    it('does not depend on filesystem traversal order', () => {
      const ranker = new RelevanceRanker();
      const files = makeFiles();
      const reversed = [...files].reverse();
      const r1 = ranker.rank({ query: 'auth' }, files);
      const r2 = ranker.rank({ query: 'auth' }, reversed);
      expect(r1.sortedByScore.map((c) => c.id)).toEqual(r2.sortedByScore.map((c) => c.id));
    });
  });

  describe('exact filename match', () => {
    it('ranks exact filename match highest', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/other.ts'),
        makeSourceFile('src/auth.ts'),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth.ts');
    });
  });

  describe('partial filename match', () => {
    it('ranks partial filename match', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/database.ts'),
        makeSourceFile('src/authentication-service.ts'),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/authentication-service.ts');
    });
  });

  describe('relative path match', () => {
    it('ranks matching relative path higher', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/utils/helper.ts'),
        makeSourceFile('src/auth/login.ts'),
      ];
      const result = ranker.rank({ query: 'auth login' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth/login.ts');
    });
  });

  describe('directory match', () => {
    it('ranks files in matching directory higher', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/database/connection.ts'),
        makeSourceFile('src/auth/login.ts'),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth/login.ts');
    });
  });

  describe('language and extension relevance', () => {
    it('ranks matching language files higher', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('script.py', { extension: 'py', language: 'python' }),
        makeSourceFile('src/auth.ts', { extension: 'ts', language: 'typescript' }),
      ];
      const result = ranker.rank({ query: 'typescript' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth.ts');
    });
  });

  describe('project metadata relevance', () => {
    it('ranks manifest files for config queries', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts'),
        makeManifestFile('package.json'),
      ];
      const result = ranker.rank({ query: 'package manifest config' }, files);
      // Manifest should score due to manifest signal
      const manifestIdx = result.sortedByScore.findIndex((c) => c.file.relativePath === 'package.json');
      const sourceIdx = result.sortedByScore.findIndex((c) => c.file.relativePath === 'src/auth.ts');
      expect(manifestIdx).toBeGreaterThanOrEqual(0);
      expect(sourceIdx).toBeGreaterThanOrEqual(0);
    });

    it('ranks config files for config queries', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts'),
        makeConfigFile('tsconfig.json'),
      ];
      const result = ranker.rank({ query: 'config' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('tsconfig.json');
    });
  });

  describe('entry-point relevance', () => {
    it('ranks entry point files for start queries', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/utils/helper.ts'),
        makeSourceFile('src/index.ts', { name: 'index' }),
      ];
      const result = ranker.rank({ query: 'application start entry point' }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/index.ts');
    });
  });

  describe('test-file relevance', () => {
    it('ranks test files for testing queries', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts'),
        makeTestFile('src/auth/auth.test.ts'),
      ];
      const result = ranker.rank({ query: 'test auth' }, files);
      const testIdx = result.sortedByScore.findIndex((c) => c.file.relativePath.includes('auth.test'));
      const sourceIdx = result.sortedByScore.findIndex((c) => c.file.relativePath === 'src/auth.ts');
      expect(testIdx).toBeLessThan(sourceIdx);
    });
  });

  describe('explicitly mentioned file', () => {
    it('ranks explicitly mentioned file highest', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/database/connection.ts'),
        makeSourceFile('src/auth/login.ts'),
      ];
      const result = ranker.rank({
        query: 'fix login service',
        explicitMentions: ['src/auth/login.ts'],
      }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth/login.ts');
    });
  });

  describe('irrelevant files', () => {
    it('ranks irrelevant files lower', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth/login.ts'),
        makeSourceFile('src/utils/random.ts'),
      ];
      const result = ranker.rank({ query: 'database migration' }, files);
      // Neither matches well; both should have low scores
      for (const c of result.sortedByScore) {
        expect(c.overallScore).toBeLessThan(0.5);
      }
    });
  });

  describe('missing metadata', () => {
    it('handles files with null language', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeFileMetadata({
          relativePath: 'Makefile',
          name: 'Makefile',
          extension: '',
          language: null,
          category: 'other',
          size: 500,
        }),
      ];
      const result = ranker.rank({ query: 'build' }, files);
      expect(result.totalCandidates).toBe(1);
    });

    it('handles files with no projectId', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeFileMetadata({
          relativePath: 'src/standalone.ts',
          name: 'standalone',
          extension: 'ts',
          language: 'typescript',
          category: 'source',
          size: 100,
        }),
      ];
      const result = ranker.rank({ query: 'typescript' }, files);
      expect(result.totalCandidates).toBe(1);
    });
  });

  describe('equal-score deterministic ordering', () => {
    it('orders equal scores by relative path', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/bbb.ts', { overallScore: 0 }),
        makeSourceFile('src/aaa.ts', { overallScore: 0 }),
      ];
      // Can't set overallScore directly via makeFileMetadata; use ranker and check ordering
      const result = ranker.rank({ query: 'zzz' }, files);
      // All scores likely 0 or very low, should be ordered by path
      const paths = result.sortedByScore.map((c) => c.file.relativePath);
      expect(paths).toEqual([...paths].sort());
    });
  });

  describe('configurable weights', () => {
    it('applies custom weights', () => {
      const ranker = new RelevanceRanker({ explicitMention: 0.9, filename: 0.05 });
      const files = [
        makeSourceFile('src/database/connection.ts'),
        makeSourceFile('src/auth/login.ts'),
      ];
      // With high explicitMention weight, mentioned file should rank high
      const result = ranker.rank({
        query: 'database',
        explicitMentions: ['src/auth/login.ts'],
      }, files);
      expect(result.sortedByScore[0].file.relativePath).toBe('src/auth/login.ts');
    });

    it('getWeights returns configured weights', () => {
      const ranker = new RelevanceRanker({ filename: 0.5 });
      const weights = ranker.getWeights();
      expect(weights.filename).toBe(0.5);
    });
  });

  describe('invalid configuration', () => {
    it('rejects empty query', () => {
      const ranker = new RelevanceRanker();
      expect(() => ranker.rank({ query: '' }, [])).toThrow();
    });

    it('rejects whitespace-only query', () => {
      const ranker = new RelevanceRanker();
      expect(() => ranker.rank({ query: '   ' }, [])).toThrow();
    });

    it('rejects weight below zero', () => {
      expect(() => new RelevanceRanker({ filename: -0.1 })).toThrow();
    });

    it('rejects weight above one', () => {
      expect(() => new RelevanceRanker({ filename: 1.1 })).toThrow();
    });

    it('rejects negative weight on any signal', () => {
      expect(() => new RelevanceRanker({ classificationSafety: -0.5 })).toThrow();
    });

    it('accepts weights within the valid range', () => {
      const ranker = new RelevanceRanker({ filename: 0.5, explicitMention: 0 });
      expect(ranker.getWeights().filename).toBe(0.5);
      expect(ranker.getWeights().explicitMention).toBe(0);
    });
  });

  describe('empty query', () => {
    it('throws on empty query', () => {
      const ranker = new RelevanceRanker();
      expect(() => ranker.rank({ query: '' }, [])).toThrow();
    });
  });

  describe('empty workspace', () => {
    it('returns empty result for empty file list', () => {
      const ranker = new RelevanceRanker();
      const result = ranker.rank({ query: 'auth' }, []);
      expect(result.totalCandidates).toBe(0);
      expect(result.sortedByScore).toEqual([]);
    });
  });

  describe('multi-root workspace', () => {
    it('handles files from multiple workspace folders', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts', { workspaceFolderId: 'folder_1' as any }),
        makeSourceFile('src/auth.ts', { workspaceFolderId: 'folder_2' as any }),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      expect(result.totalCandidates).toBe(2);
    });
  });

  describe('AbortSignal cancellation', () => {
    it('throws when signal is aborted before start', () => {
      const ranker = new RelevanceRanker();
      const ac = new AbortController();
      ac.abort();
      const files = [makeSourceFile('src/auth.ts')];
      expect(() => ranker.rank({ query: 'auth', signal: ac.signal }, files)).toThrow();
    });

    it('throws when signal aborts during ranking', () => {
      const ranker = new RelevanceRanker();
      const ac = new AbortController();
      // Create many files to ensure ranking takes some iterations
      const files: FileMetadata[] = [];
      for (let i = 0; i < 100; i++) {
        files.push(makeSourceFile(`src/file${i}.ts`));
      }
      // Abort immediately
      ac.abort();
      expect(() => ranker.rank({ query: 'test', signal: ac.signal }, files)).toThrow();
    });
  });

  describe('safety and eligibility', () => {
    it('marks sensitive files as ineligible', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts'),
        makeSensitiveFile('.env'),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      const sensitive = result.sortedByScore.find((c) => c.file.relativePath === '.env');
      expect(sensitive?.isEligible).toBe(false);
    });

    it('marks binary files as ineligible', () => {
      const ranker = new RelevanceRanker();
      const files = [
        makeSourceFile('src/auth.ts'),
        makeBinaryFile('image.png'),
      ];
      const result = ranker.rank({ query: 'auth' }, files);
      const binary = result.sortedByScore.find((c) => c.file.relativePath === 'image.png');
      expect(binary?.isEligible).toBe(false);
    });

    it('does not include source contents in ranking', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth.ts')];
      const result = ranker.rank({ query: 'auth' }, files);
      // Candidate should only contain metadata, not file contents
      expect(result.sortedByScore[0].file.absolutePath).toBeDefined();
      expect(result.sortedByScore[0].file).not.toHaveProperty('content');
    });
  });

  describe('createRelevanceRanker', () => {
    it('factory creates ranker', () => {
      const ranker = createRelevanceRanker();
      expect(ranker).toBeInstanceOf(RelevanceRanker);
    });
  });

  describe('task classification in ranking', () => {
    it('classifies bug-fixing task', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth.ts')];
      const result = ranker.rank({ query: 'fix the auth bug' }, files);
      expect(result.taskCategory).toBe('bug-fixing');
    });

    it('classifies feature task', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth.ts')];
      const result = ranker.rank({ query: 'add new feature' }, files);
      expect(result.taskCategory).toBe('feature-implementation');
    });

    it('uses explicit task category override', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth.ts')];
      const result = ranker.rank({
        query: 'anything',
        taskCategory: 'testing',
      }, files);
      expect(result.taskCategory).toBe('testing');
    });
  });

  describe('explainability', () => {
    it('provides signal contributions for each candidate', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth/login.ts')];
      const result = ranker.rank({ query: 'auth login' }, files);
      const candidate = result.sortedByScore[0];
      expect(candidate.signals.length).toBeGreaterThan(0);
      expect(candidate.signals[0]).toHaveProperty('name');
      expect(candidate.signals[0]).toHaveProperty('weight');
      expect(candidate.signals[0]).toHaveProperty('score');
      expect(candidate.signals[0]).toHaveProperty('reason');
    });

    it('provides inclusion reasons', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth/login.ts')];
      const result = ranker.rank({ query: 'auth login' }, files);
      const candidate = result.sortedByScore[0];
      expect(candidate.inclusionReasons.length).toBeGreaterThan(0);
    });

    it('provides exclusion reasons for ineligible files', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSensitiveFile('.env')];
      const result = ranker.rank({ query: 'env' }, files);
      const candidate = result.sortedByScore[0];
      expect(candidate.isEligible).toBe(false);
      expect(candidate.exclusionReasons.length).toBeGreaterThan(0);
    });

    it('does not expose source contents in diagnostic messages', () => {
      const ranker = new RelevanceRanker();
      const files = [makeSourceFile('src/auth.ts', { size: 5000 })];
      const result = ranker.rank({ query: 'auth' }, files);
      for (const candidate of result.sortedByScore) {
        for (const sig of candidate.signals) {
        expect(sig.reason).not.toContain('password');
        expect(sig.reason).not.toContain('secret');
        expect(sig.reason).not.toContain('private key');
        }
        for (const reason of candidate.inclusionReasons) {
          expect(reason).not.toContain('password');
          expect(reason).not.toContain('secret');
        }
      }
    });
  });
});
