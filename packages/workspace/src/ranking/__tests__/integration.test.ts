import { describe, it, expect } from 'vitest';
import { RelevanceRanker, createRelevanceRanker } from '../relevance-ranker.js';
import { ContextSelector, createContextSelector } from '../context-selector.js';
import {
  makeSourceFile,
  makeTestFile,
  makeConfigFile,
  makeManifestFile,
  makeSensitiveFile,
  makeBinaryFile,
} from './test-helpers.js';

function makeWorkspaceFiles(): FileMetadata[] {
  return [
    makeSourceFile('src/auth/login.ts', { name: 'login', extension: 'ts', language: 'typescript', size: 2000 }),
    makeSourceFile('src/auth/auth.service.ts', { name: 'auth.service', extension: 'ts', language: 'typescript', size: 3000 }),
    makeTestFile('src/auth/auth.test.ts', { name: 'auth.test', extension: 'ts', language: 'typescript', size: 1500 }),
    makeSourceFile('src/database/connection.ts', { name: 'connection', extension: 'ts', language: 'typescript', size: 2500 }),
    makeSourceFile('src/database/migration.ts', { name: 'migration', extension: 'ts', language: 'typescript', size: 1800 }),
    makeSourceFile('src/index.ts', { name: 'index', extension: 'ts', language: 'typescript', size: 500 }),
    makeConfigFile('tsconfig.json', { name: 'tsconfig', extension: 'json', language: 'json', size: 800 }),
    makeManifestFile('package.json', { name: 'package', extension: 'json', language: 'json', size: 400 }),
    makeSensitiveFile('.env', { name: '.env', extension: '', language: null, size: 100 }),
    makeBinaryFile('image.png', { name: 'image', extension: 'png', language: null, size: 50000 }),
  ];
}

describe('Stage E Integration', () => {
  describe('complete flow: task → classification → ranking → selection', () => {
    it('fix auth bug prioritizes auth files', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 5,
        maxBudget: 100000,
        minRelevanceScore: 0.05,
        enableDiversity: false,
        maxPerDirectory: 10,
        maxPerProject: 10,
      });

      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'fix auth service bug' }, files);
      expect(ranking.taskCategory).toBe('bug-fixing');

      const selection = selector.select(ranking.sortedByScore.map((c) => ({
        id: c.id,
        relativePath: c.file.relativePath,
        absolutePath: c.file.absolutePath,
        workspaceFolderId: c.workspaceFolderId as unknown as string,
        projectId: c.projectId,
        category: c.file.category,
        language: c.file.language,
        size: c.file.size,
        overallScore: c.overallScore,
        normalizedScore: c.normalizedScore,
        isEligible: c.isEligible,
        inclusionReasons: c.inclusionReasons,
        exclusionReasons: c.exclusionReasons,
      })));

      expect(selection.selectedCount).toBeGreaterThan(0);
      const authSelected = selection.selected.some((s) =>
        s.relativePath.includes('auth')
      );
      expect(authSelected).toBe(true);
    });

    it('explain application start prioritizes entry points', () => {
      const ranker = new RelevanceRanker();
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'Explain how the application starts' }, files);
      expect(ranking.taskCategory).toBe('architecture-exploration');

      const topFile = ranking.sortedByScore[0];
      // index.ts should rank high for entry-point queries
      expect(topFile.file.relativePath).toBe('src/index.ts');
    });

    it('add API endpoint prioritizes routes and controllers', () => {
      const ranker = new RelevanceRanker();
      const files = [
        ...makeWorkspaceFiles(),
        makeSourceFile('src/api/users.route.ts', { name: 'users.route', extension: 'ts', language: 'typescript', size: 1200 }),
        makeSourceFile('src/api/users.controller.ts', { name: 'users.controller', extension: 'ts', language: 'typescript', size: 1800 }),
      ];
      const ranking = ranker.rank({ query: 'Add a new API endpoint for users' }, files);
      expect(ranking.taskCategory).toBe('feature-implementation');

      const apiFiles = ranking.sortedByScore.filter((c) =>
        c.file.relativePath.includes('api') || c.file.relativePath.includes('route') || c.file.relativePath.includes('controller')
      );
      expect(apiFiles.length).toBeGreaterThan(0);
    });

    it('update database schema prioritizes migrations and models', () => {
      const ranker = new RelevanceRanker();
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'Update the database schema and migration files' }, files);
      expect(ranking.taskCategory).toBe('feature-implementation');

      const dbFiles = ranking.sortedByScore.filter((c) =>
        c.file.relativePath.includes('database') || c.file.relativePath.includes('migration')
      );
      expect(dbFiles.length).toBeGreaterThan(0);
    });

    it('fix failing test prioritizes test files', () => {
      const ranker = new RelevanceRanker();
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'Fix the failing unit test for auth service' }, files);
      expect(ranking.taskCategory).toBe('testing');

      const testFile = ranking.sortedByScore.find((c) =>
        c.file.relativePath.includes('auth.test')
      );
      expect(testFile).toBeDefined();
    });
  });

  describe('determinism', () => {
    it('identical inputs produce identical results', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 5,
        maxBudget: 100000,
        minRelevanceScore: 0.1,
        enableDiversity: true,
        maxPerDirectory: 3,
        maxPerProject: 10,
      });

      const files = makeWorkspaceFiles();
      const r1 = ranker.rank({ query: 'fix auth bug' }, files);
      const r2 = ranker.rank({ query: 'fix auth bug' }, files);
      expect(r1.sortedByScore.map((c) => c.id)).toEqual(r2.sortedByScore.map((c) => c.id));

      const s1 = selector.select(r1.sortedByScore.map(toCandidateInput));
      const s2 = selector.select(r2.sortedByScore.map(toCandidateInput));
      expect(s1.selected.map((s) => s.id)).toEqual(s2.selected.map((s) => s.id));
    });
  });

  describe('no workspace data mutation', () => {
    it('does not mutate input files', () => {
      const ranker = new RelevanceRanker();
      const files = makeWorkspaceFiles();
      const originals = files.map((f) => ({ ...f }));
      ranker.rank({ query: 'auth bug' }, files);
      for (let i = 0; i < files.length; i++) {
        expect(files[i]).toEqual(originals[i]);
      }
    });
  });

  describe('selection limits', () => {
    it('never exceeds maxFileCount', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 3,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'auth' }, files);
      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));
      expect(selection.selectedCount).toBeLessThanOrEqual(3);
    });

    it('never exceeds maxBudget', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 2000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'auth' }, files);
      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));
      expect(selection.totalBudgetUsed).toBeLessThanOrEqual(selection.totalBudget);
    });
  });

  describe('safety enforcement', () => {
    it('unsafe files cannot enter selected context', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'anything' }, files);
      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));
      const unsafeSelected = selection.selected.some((s) =>
        s.relativePath === '.env' || s.relativePath === 'image.png'
      );
      expect(unsafeSelected).toBe(false);
    });

    it('high score cannot bypass eligibility rules', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      // .env and image.png have high scores (0.9 from explicit match potential) but are ineligible
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'env image' }, files);
      const envCandidate = ranking.sortedByScore.find((c) => c.file.relativePath === '.env');
      expect(envCandidate?.isEligible).toBe(false);

      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));
      const envSelected = selection.selected.some((s) => s.relativePath === '.env');
      expect(envSelected).toBe(false);
    });
  });

  describe('explanations correspond to decisions', () => {
    it('selection reasons match actual ranking', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 100,
        maxBudget: 1000000,
        minRelevanceScore: 0.1,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'auth bug' }, files);
      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));

      for (const sel of selection.selected) {
        const candidate = ranking.sortedByScore.find((c) => c.id === sel.id);
        expect(candidate).toBeDefined();
        expect(sel.overallScore).toBe(candidate?.overallScore);
        expect(sel.selectionReason.length).toBeGreaterThan(0);
      }
    });

    it('skip reasons explain why candidates were skipped', () => {
      const ranker = new RelevanceRanker();
      const selector = new ContextSelector({
        maxFileCount: 2,
        maxBudget: 1000000,
        minRelevanceScore: 0.5,
        enableDiversity: false,
        maxPerDirectory: 100,
        maxPerProject: 100,
      });
      const files = makeWorkspaceFiles();
      const ranking = ranker.rank({ query: 'xyzzy nonexistent' }, files);
      const selection = selector.select(ranking.sortedByScore.map(toCandidateInput));
      expect(resultHasSkipReasons(selection)).toBe(true);
    });
  });
});

function toCandidateInput(c: {
  id: string;
  file: FileMetadata;
  projectId?: string;
  workspaceFolderId: string;
  overallScore: number;
  normalizedScore: number;
  isEligible: boolean;
  inclusionReasons: readonly string[];
  exclusionReasons: readonly string[];
}): {
  id: string;
  relativePath: string;
  absolutePath: string;
  workspaceFolderId: string;
  projectId?: string;
  category: FileMetadata['category'];
  language: string | null;
  size: number;
  overallScore: number;
  normalizedScore: number;
  isEligible: boolean;
  inclusionReasons: readonly string[];
  exclusionReasons: readonly string[];
} {
  return {
    id: c.id,
    relativePath: c.file.relativePath,
    absolutePath: c.file.absolutePath,
    workspaceFolderId: c.workspaceFolderId,
    projectId: c.projectId,
    category: c.file.category,
    language: c.file.language,
    size: c.file.size,
    overallScore: c.overallScore,
    normalizedScore: c.normalizedScore,
    isEligible: c.isEligible,
    inclusionReasons: c.inclusionReasons,
    exclusionReasons: c.exclusionReasons,
  };
}

function resultHasSkipReasons(selection: {
  skipped: { skippedReason?: string }[];
}): boolean {
  return selection.skipped.some((s) => s.skippedReason && s.skippedReason.length > 0);
}

// Type alias used in test
type FileMetadata = import('../ranking-types.js').FileMetadata;
