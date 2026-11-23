import { describe, it, expect } from 'vitest';
import {
  signalFilename,
  signalRelativePath,
  signalDirectory,
  signalExtensionLanguage,
  signalProjectManifestConfig,
  signalTestFile,
  signalEntryPoint,
  signalTaskType,
  signalExplicitMention,
  signalClassificationSafety,
  computeAllSignals,
  computeOverallScore,
  type SignalContext,
} from '../relevance-signals.js';
import { makeFileMetadata, makeSourceFile, makeTestFile, makeConfigFile, makeManifestFile, makeSensitiveFile, makeBinaryFile, makeHiddenFile } from './test-helpers.js';

function makeContext(overrides: Partial<SignalContext> = {}): SignalContext {
  return {
    query: 'auth',
    taskCategory: 'bug-fixing',
    weights: {
      filename: 0.20,
      relativePath: 0.15,
      directory: 0.10,
      extensionLanguage: 0.10,
      projectManifestConfig: 0.10,
      testFile: 0.10,
      entryPoint: 0.05,
      taskType: 0.10,
      explicitMention: 0.15,
      classificationSafety: 0.05,
    },
    workspaceFolderId: 'folder_1',
    ...overrides,
  };
}

describe('RelevanceSignals - filename', () => {
  it('exact filename match scores 1.0', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalFilename(file, makeContext({ query: 'auth' }));
    expect(result.score).toBe(1.0);
    expect(result.reason).toContain('matches all query tokens');
  });

  it('partial filename match scores proportionally', () => {
    const file = makeSourceFile('src/authentication.ts');
    const result = signalFilename(file, makeContext({ query: 'auth login' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1.0);
  });

  it('no match scores 0', () => {
    const file = makeSourceFile('src/database.ts');
    const result = signalFilename(file, makeContext({ query: 'auth' }));
    expect(result.score).toBe(0);
  });

  it('empty query scores 0', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalFilename(file, makeContext({ query: '' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - relativePath', () => {
  it('matching relative path scores highly', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const result = signalRelativePath(file, makeContext({ query: 'auth login' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('non-matching path scores 0', () => {
    const file = makeSourceFile('src/database/connection.ts');
    const result = signalRelativePath(file, makeContext({ query: 'auth' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - directory', () => {
  it('matching directory scores', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const result = signalDirectory(file, makeContext({ query: 'auth' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('Directory path matches');
  });

  it('non-matching directory scores 0', () => {
    const file = makeSourceFile('src/database/connection.ts');
    const result = signalDirectory(file, makeContext({ query: 'auth' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - extensionLanguage', () => {
  it('matching extension scores', () => {
    const file = makeSourceFile('src/auth.ts', { extension: 'ts', language: 'typescript' });
    const result = signalExtensionLanguage(file, makeContext({ query: 'typescript' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('non-matching extension scores 0', () => {
    const file = makeSourceFile('src/auth.py', { extension: 'py', language: 'python' });
    const result = signalExtensionLanguage(file, makeContext({ query: 'typescript' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - projectManifestConfig', () => {
  it('manifest file scores high', () => {
    const file = makeManifestFile('package.json');
    const result = signalProjectManifestConfig(file, makeContext({ query: 'config' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('manifest');
  });

  it('config file scores', () => {
    const file = makeConfigFile('tsconfig.json');
    const result = signalProjectManifestConfig(file, makeContext({ query: 'config' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('configuration');
  });

  it('non-manifest non-config scores 0', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalProjectManifestConfig(file, makeContext({ query: 'auth' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - testFile', () => {
  it('test file scores high', () => {
    const file = makeTestFile('src/auth/auth.test.ts');
    const result = signalTestFile(file, makeContext({ query: 'test' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('test file');
  });

  it('non-test file scores 0', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalTestFile(file, makeContext({ query: 'test' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - entryPoint', () => {
  it('index.ts scores as entry point', () => {
    const file = makeSourceFile('src/index.ts', { name: 'index' });
    const result = signalEntryPoint(file, makeContext({ query: 'start' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('entry-point');
  });

  it('main.ts scores as entry point', () => {
    const file = makeSourceFile('src/main.ts', { name: 'main' });
    const result = signalEntryPoint(file, makeContext({ query: 'start' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('regular file does not score as entry point', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalEntryPoint(file, makeContext({ query: 'start' }));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - taskType', () => {
  it('testing task prioritizes test files', () => {
    const file = makeTestFile('src/auth/auth.test.ts');
    const result = signalTaskType(file, makeContext({ taskCategory: 'testing', query: 'test' }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toContain('testing');
  });

  it('configuration task prioritizes config files', () => {
    const file = makeConfigFile('config/app.json', { extension: 'json', language: 'json' });
    const result = signalTaskType(file, makeContext({ taskCategory: 'configuration', query: 'config' }));
    expect(result.score).toBeGreaterThan(0);
  });

  it('documentation task prioritizes markdown', () => {
    const file = makeSourceFile('docs/README.md', { extension: 'md', language: 'markdown' });
    const result = signalTaskType(file, makeContext({ taskCategory: 'documentation', query: 'docs' }));
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('RelevanceSignals - explicitMention', () => {
  it('explicitly mentioned file scores 1.0', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const result = signalExplicitMention(file, makeContext({
      explicitMentions: ['src/auth/login.ts'],
    }));
    expect(result.score).toBe(1.0);
    expect(result.reason).toContain('Explicitly mentioned');
  });

  it('non-mentioned file scores 0', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const result = signalExplicitMention(file, makeContext({
      explicitMentions: ['src/database/conn.ts'],
    }));
    expect(result.score).toBe(0);
  });

  it('no mentions scores 0', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const result = signalExplicitMention(file, makeContext({}));
    expect(result.score).toBe(0);
  });
});

describe('RelevanceSignals - classificationSafety', () => {
  it('sensitive file scores 0', () => {
    const file = makeSensitiveFile('.env');
    const result = signalClassificationSafety(file, makeContext({}));
    expect(result.score).toBe(0);
    expect(result.reason).toContain('sensitive');
  });

  it('binary file scores 0', () => {
    const file = makeBinaryFile('image.png');
    const result = signalClassificationSafety(file, makeContext({}));
    expect(result.score).toBe(0);
    expect(result.reason).toContain('binary');
  });

  it('eligible source file scores 1.0', () => {
    const file = makeSourceFile('src/auth.ts');
    const result = signalClassificationSafety(file, makeContext({}));
    expect(result.score).toBe(1.0);
    expect(result.reason).toContain('Eligible');
  });

  it('hidden file scores lower', () => {
    const file = makeHiddenFile('.eslintrc');
    const result = signalClassificationSafety(file, makeContext({}));
    expect(result.score).toBe(0.3);
  });
});

describe('RelevanceSignals - computeAllSignals', () => {
  it('returns all signal types', () => {
    const file = makeSourceFile('src/auth/login.ts');
    const signals = computeAllSignals(file, makeContext({ query: 'auth login' }));
    expect(signals.length).toBe(10);
    const names = signals.map((s) => s.name);
    expect(names).toContain('filename');
    expect(names).toContain('relative-path');
    expect(names).toContain('directory');
    expect(names).toContain('extension-language');
    expect(names).toContain('project-manifest-config');
    expect(names).toContain('test-file');
    expect(names).toContain('entry-point');
    expect(names).toContain('task-type');
    expect(names).toContain('explicit-mention');
    expect(names).toContain('classification-safety');
  });
});

describe('RelevanceSignals - computeOverallScore', () => {
  it('computes weighted average', () => {
    const signals = [
      { name: 'filename', weight: 0.5, score: 1.0, reason: 'test' },
      { name: 'relative-path', weight: 0.5, score: 0.0, reason: 'test' },
    ];
    const score = computeOverallScore(signals);
    expect(score).toBe(0.5);
  });

  it('returns 0 for empty signals', () => {
    expect(computeOverallScore([])).toBe(0);
  });

  it('clamps to 1.0 maximum', () => {
    const signals = [
      { name: 'filename', weight: 1.0, score: 1.0, reason: 'test' },
    ];
    expect(computeOverallScore(signals)).toBe(1.0);
  });
});
