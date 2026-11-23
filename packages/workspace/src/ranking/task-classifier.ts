import type { TaskCategory } from './ranking-types.js';

export interface TaskClassification {
  readonly category: TaskCategory;
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
  readonly reasons: readonly string[];
}

export interface TaskClassifierOptions {
  readonly explicitCategory?: TaskCategory;
}

const KEYWORDS: Record<TaskCategory, readonly string[]> = {
  'bug-fixing': ['fix', 'bug', 'error', 'fail', 'broken', 'issue', 'defect', 'crash', 'exception', 'patch', 'resolve'],
  'feature-implementation': ['add', 'new', 'feature', 'implement', 'create', 'build', 'introduce', 'endpoint', 'api', 'support', 'update', 'change', 'modify', 'upgrade', 'schema', 'migration'],
  'refactoring': ['refactor', 'restructure', 'reorganize', 'cleanup', 'clean up', 'rewrite', 'simplify', 'extract', 'inline', 'optimize'],
  'testing': ['test', 'spec', 'jest', 'vitest', 'mocha', 'assert', 'mock', 'coverage', 'test case', 'unit test', 'integration test'],
  'documentation': ['doc', 'documentation', 'readme', 'comment', 'guide', 'tutorial', 'markdown', 'wiki', 'docstring'],
  'configuration': ['config', 'configure', 'setting', 'settings', 'env', 'environment', 'ini', 'yaml', 'toml', 'json config', 'deploy config'],
  'architecture-exploration': ['architecture', 'design', 'structure', 'overview', 'how', 'flow', 'component', 'module', 'system', 'diagram'],
  'debugging': ['debug', 'trace', 'investigate', 'diagnose', 'log', 'logging', 'breakpoint', 'step through', 'inspect', 'probe'],
  'general-explanation': ['explain', 'describe', 'understand', 'overview', 'what', 'why', 'summary', 'summarize'],
unknown: [],
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

export function classifyTask(query: string, options: TaskClassifierOptions = {}): TaskClassification {
  if (options.explicitCategory !== undefined) {
    return {
      category: options.explicitCategory,
      confidence: 1.0,
      matchedKeywords: [],
      reasons: [`Explicit task category override: ${options.explicitCategory}`],
    };
  }

  if (!query || query.trim().length === 0) {
    return {
      category: 'unknown',
      confidence: 0.0,
      matchedKeywords: [],
      reasons: ['Empty task description; classified as unknown'],
    };
  }

  let bestCategory: TaskCategory = 'unknown';
  let bestScore = 0;
  let bestMatched: string[] = [];

  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    const cat = category as TaskCategory;
    if (cat === 'unknown') continue;

    let score = 0;
    const matched: string[] = [];

    for (const keyword of keywords) {
      const kw = keyword.toLowerCase();
      const kwTokens = tokenize(keyword);
      if (kwTokens.length === 0) continue;

      // Multi-word keyword: require all tokens to appear as substrings
      if (kwTokens.length > 1) {
        const allPresent = kwTokens.every((t) => query.toLowerCase().includes(t));
        if (allPresent) {
          matched.push(keyword);
          score += kwTokens.length * 2; // weight multi-word keywords higher
        }
        continue;
      }

      // Single-word keyword: match as whole word or substring
      if (query.toLowerCase().includes(kw)) {
        matched.push(keyword);
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
      bestMatched = matched;
    }
  }

  const confidence = bestScore > 0 ? Math.min(bestScore / 5, 1.0) : 0.0;

  const reasons: string[] = [];
  if (bestCategory === 'unknown') {
    reasons.push('No task-specific keywords detected; classified as unknown/general');
  } else {
    reasons.push(`Detected ${bestCategory} task (${bestMatched.length} keyword matches)`);
    if (bestMatched.length > 0) {
      reasons.push(`Matched: ${bestMatched.join(', ')}`);
    }
  }

  return {
    category: bestCategory,
    confidence,
    matchedKeywords: bestMatched,
    reasons,
  };
}

export function classifyTaskCategory(query: string, options: TaskClassifierOptions = {}): TaskCategory {
  return classifyTask(query, options).category;
}

export function isSupportedTaskCategory(category: string): category is TaskCategory {
  return [
    'bug-fixing',
    'feature-implementation',
    'refactoring',
    'testing',
    'documentation',
    'configuration',
    'architecture-exploration',
    'debugging',
    'general-explanation',
    'unknown',
  ].includes(category);
}
