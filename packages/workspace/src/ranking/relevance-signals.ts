import type {
  FileMetadata,
  TaskCategory,
  RankingSignalContribution,
  RankingSignalName,
  RankingWeights,
} from './ranking-types.js';

export interface SignalContext {
  readonly query: string;
  readonly taskCategory: TaskCategory;
  readonly explicitMentions?: readonly string[];
  readonly weights: RankingWeights;
  readonly projectId?: string;
  readonly workspaceFolderId: string;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s./\\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

function scoreFromRatio(matched: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(matched / total, 1);
}

export function signalFilename(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const name = file.name.toLowerCase();
  const queryTokens = tokenize(context.query);
  let matched = 0;
  const matchedTokens: string[] = [];

  for (const token of queryTokens) {
    if (name.includes(token)) {
      matched += 1;
      matchedTokens.push(token);
    }
  }

  const exact = queryTokens.length > 0 && queryTokens.every((t) => name.includes(t));
  const score = exact ? 1.0 : scoreFromRatio(matched, queryTokens.length);

  let reason: string;
  if (queryTokens.length === 0) {
    reason = 'No query tokens to match against filename';
  } else if (exact) {
    reason = `Filename "${file.name}" matches all query tokens`;
  } else if (matched > 0) {
    reason = `Filename "${file.name}" matches ${matched}/${queryTokens.length} query tokens (${matchedTokens.join(', ')})`;
  } else {
    reason = `Filename "${file.name}" does not match query tokens`;
  }

  return {
    name: 'filename',
    weight: context.weights.filename,
    score,
    reason,
  };
}

export function signalRelativePath(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const rel = file.relativePath.toLowerCase();
  const queryTokens = tokenize(context.query);
  let matched = 0;
  const matchedTokens: string[] = [];

  for (const token of queryTokens) {
    if (rel.includes(token)) {
      matched += 1;
      matchedTokens.push(token);
    }
  }

  const exact = queryTokens.length > 0 && queryTokens.every((t) => rel.includes(t));
  const score = exact ? 1.0 : scoreFromRatio(matched, queryTokens.length);

  let reason: string;
  if (queryTokens.length === 0) {
    reason = 'No query tokens to match against relative path';
  } else if (exact) {
    reason = `Relative path "${file.relativePath}" matches all query tokens`;
  } else if (matched > 0) {
    reason = `Relative path "${file.relativePath}" matches ${matched}/${queryTokens.length} query tokens (${matchedTokens.join(', ')})`;
  } else {
    reason = `Relative path "${file.relativePath}" does not match query tokens`;
  }

  return {
    name: 'relative-path',
    weight: context.weights.relativePath,
    score,
    reason,
  };
}

export function signalDirectory(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const rel = file.relativePath.toLowerCase();
  const queryTokens = tokenize(context.query);
  const dirSegments = rel.split('/').slice(0, -1);
  let matched = 0;
  const matchedDirs: string[] = [];

  for (const token of queryTokens) {
    for (const seg of dirSegments) {
      if (seg.includes(token)) {
        matched += 1;
        matchedDirs.push(seg);
        break;
      }
    }
  }

  const score = queryTokens.length === 0 ? 0 : scoreFromRatio(matched, queryTokens.length);

  let reason: string;
  if (queryTokens.length === 0) {
    reason = 'No query tokens to match against directory';
  } else if (matched > 0) {
    reason = `Directory path matches ${matched}/${queryTokens.length} query tokens (${matchedDirs.join(', ')})`;
  } else {
    reason = `Directory path does not match query tokens`;
  }

  return {
    name: 'directory',
    weight: context.weights.directory,
    score,
    reason,
  };
}

export function signalExtensionLanguage(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const ext = file.extension.toLowerCase();
  const lang = file.language?.toLowerCase() ?? '';
  const queryTokens = tokenize(context.query);
  let matched = 0;
  const matchedTokens: string[] = [];

  for (const token of queryTokens) {
    if (ext.includes(token) || lang.includes(token)) {
      matched += 1;
      matchedTokens.push(token);
    }
  }

  const score = queryTokens.length === 0 ? 0 : scoreFromRatio(matched, queryTokens.length);

  let reason: string;
  if (queryTokens.length === 0) {
    reason = 'No query tokens to match against extension/language';
  } else if (matched > 0) {
    const details = ext.length > 0 ? `extension .${ext}` : 'no extension';
    const langDetail = lang ? `, language ${lang}` : '';
    reason = `File ${details}${langDetail} matches ${matched}/${queryTokens.length} query tokens (${matchedTokens.join(', ')})`;
  } else {
    reason = `File extension/language does not match query tokens`;
  }

  return {
    name: 'extension-language',
    weight: context.weights.extensionLanguage,
    score,
    reason,
  };
}

export function signalProjectManifestConfig(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const isManifest = file.isManifest;
  const isConfig = file.isConfig;
  const rel = file.relativePath.toLowerCase();
  const queryTokens = tokenize(context.query);
  let score = 0;
  const reasons: string[] = [];

  if (isManifest) {
    score += 0.5;
    reasons.push('project manifest file');
  }
  if (isConfig) {
    score += 0.3;
    reasons.push('configuration file');
  }

  let matched = 0;
  const matchedTokens: string[] = [];
  for (const token of queryTokens) {
    if (rel.includes(token) && (token.includes('config') || token.includes('manifest') || token.includes('setting'))) {
      matched += 1;
      matchedTokens.push(token);
    }
  }
  if (matched > 0) {
    score += 0.2 * scoreFromRatio(matched, queryTokens.length);
    reasons.push(`matches ${matched}/${queryTokens.length} config-related tokens`);
  }

  const finalScore = Math.min(score, 1.0);

  let reason: string;
  if (reasons.length === 0) {
    reason = 'Not a manifest or configuration file';
  } else {
    reason = reasons.join('; ');
  }

  return {
    name: 'project-manifest-config',
    weight: context.weights.projectManifestConfig,
    score: finalScore,
    reason,
  };
}

export function signalTestFile(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const name = file.name.toLowerCase();
  const rel = file.relativePath.toLowerCase();
  const queryTokens = tokenize(context.query);
  let score = 0;
  const reasons: string[] = [];

  const isTest = name.includes('.test.') || name.includes('.spec.') || rel.includes('/tests/') || rel.includes('/__tests__/') || rel.includes('/test/');
  if (isTest) {
    score += 0.5;
    reasons.push('test file');
  }

  let matched = 0;
  const matchedTokens: string[] = [];
  for (const token of queryTokens) {
    if ((name.includes(token) || rel.includes(token)) && (token.includes('test') || token.includes('spec'))) {
      matched += 1;
      matchedTokens.push(token);
    }
  }
  if (matched > 0) {
    score += 0.5 * scoreFromRatio(matched, queryTokens.length);
    reasons.push(`matches ${matched}/${queryTokens.length} test-related tokens`);
  }

  const finalScore = Math.min(score, 1.0);

  let reason: string;
  if (reasons.length === 0) {
    reason = 'Not a test file';
  } else {
    reason = reasons.join('; ');
  }

  return {
    name: 'test-file',
    weight: context.weights.testFile,
    score: finalScore,
    reason,
  };
}

export function signalEntryPoint(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const name = file.name.toLowerCase();
  const rel = file.relativePath.toLowerCase();
  const entryNames = ['index', 'main', 'app', 'bootstrap', 'start', 'server', 'cli', 'entry'];
  const entryPaths = ['/bin/', '/src/', '/cmd/', '/app/'];
  let score = 0;
  const reasons: string[] = [];

  const isEntryName = entryNames.some((n) => name === n || name === `${n}.ts` || name === `${n}.js`);
  if (isEntryName) {
    score += 0.9;
    reasons.push(`entry-point filename "${file.name}"`);
  }

  const isEntryPath = entryPaths.some((p) => rel.includes(p));
  if (isEntryPath) {
    score += 0.3;
    reasons.push('located in entry-point directory');
  }

  const finalScore = Math.min(score, 1.0);

  let reason: string;
  if (reasons.length === 0) {
    reason = 'Not an entry point';
  } else {
    reason = reasons.join('; ');
  }

  return {
    name: 'entry-point',
    weight: context.weights.entryPoint,
    score: finalScore,
    reason,
  };
}

export function signalTaskType(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const category = context.taskCategory;
  const name = file.name.toLowerCase();
  const rel = file.relativePath.toLowerCase();
  const ext = file.extension.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  const categorySignals: Record<TaskCategory, { namePatterns: string[]; pathPatterns: string[]; extensions: string[] }> = {
    'bug-fixing': { namePatterns: [], pathPatterns: [], extensions: [] },
    'feature-implementation': { namePatterns: [], pathPatterns: [], extensions: [] },
    'refactoring': { namePatterns: [], pathPatterns: [], extensions: [] },
    'testing': {
      namePatterns: ['.test.', '.spec.'],
      pathPatterns: ['/tests/', '/__tests__/', '/test/'],
      extensions: [],
    },
    'documentation': {
      namePatterns: [],
      pathPatterns: ['/docs/', '/documentation/'],
      extensions: ['md', 'markdown', 'rst', 'adoc', 'txt'],
    },
    'configuration': {
      namePatterns: [],
      pathPatterns: ['/config/', '/conf/', '/etc/'],
      extensions: ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'],
    },
    'architecture-exploration': { namePatterns: [], pathPatterns: [], extensions: [] },
    'debugging': { namePatterns: [], pathPatterns: [], extensions: [] },
    'general-explanation': { namePatterns: [], pathPatterns: [], extensions: [] },
    unknown: { namePatterns: [], pathPatterns: [], extensions: [] },
  };

  const signals = categorySignals[category];
  if (signals) {
    for (const pat of signals.namePatterns) {
      if (name.includes(pat)) {
        score += 0.4;
        reasons.push(`filename matches ${category} pattern "${pat}"`);
        break;
      }
    }
    for (const pat of signals.pathPatterns) {
      if (rel.includes(pat)) {
        score += 0.4;
        reasons.push(`path matches ${category} pattern "${pat}"`);
        break;
      }
    }
    for (const extPat of signals.extensions) {
      if (ext === extPat) {
        score += 0.2;
        reasons.push(`extension .${extPat} relevant to ${category}`);
        break;
      }
    }
  }

  const finalScore = Math.min(score, 1.0);

  let reason: string;
  if (reasons.length === 0) {
    reason = `No ${category}-specific signals detected`;
  } else {
    reason = reasons.join('; ');
  }

  return {
    name: 'task-type',
    weight: context.weights.taskType,
    score: finalScore,
    reason,
  };
}

export function signalExplicitMention(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  const mentions = context.explicitMentions ?? [];
  if (mentions.length === 0) {
    return {
      name: 'explicit-mention',
      weight: context.weights.explicitMention,
      score: 0,
      reason: 'No explicit file mentions provided',
    };
  }

  const rel = file.relativePath.toLowerCase();
  const name = file.name.toLowerCase();
  const abs = file.absolutePath.toLowerCase();
  let matched = 0;
  const matchedMentions: string[] = [];

  for (const mention of mentions) {
    const m = mention.toLowerCase();
    if (rel === m || rel.includes(m) || name === m || name.includes(m) || abs.includes(m)) {
      matched += 1;
      matchedMentions.push(mention);
    }
  }

  const score = scoreFromRatio(matched, mentions.length);

  let reason: string;
  if (matched === mentions.length && mentions.length > 0) {
    reason = `Explicitly mentioned: ${matchedMentions.join(', ')}`;
  } else if (matched > 0) {
    reason = `Partially matches explicit mentions: ${matchedMentions.join(', ')}`;
  } else {
    reason = 'Not explicitly mentioned';
  }

  return {
    name: 'explicit-mention',
    weight: context.weights.explicitMention,
    score,
    reason,
  };
}

export function signalClassificationSafety(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution {
  let score = 1.0;
  const reasons: string[] = [];

  if (file.isSensitive) {
    score = 0;
    reasons.push('sensitive file (safety exclusion)');
  } else if (file.isBinary) {
    score = 0;
    reasons.push('binary file (not source context)');
  } else if (file.sourceExcluded) {
    score = 0;
    reasons.push('source-excluded file');
  } else if (file.isHidden) {
    score = 0.3;
    reasons.push('hidden file (lower priority)');
  } else {
    reasons.push('eligible source file');
  }

  let reason: string;
  if (score === 0) {
    reason = `Ineligible: ${reasons.join('; ')}`;
  } else if (score < 1) {
    reason = `Eligible with caution: ${reasons.join('; ')}`;
  } else {
    reason = 'Eligible source file';
  }

  return {
    name: 'classification-safety',
    weight: context.weights.classificationSafety,
    score,
    reason,
  };
}

export const SIGNAL_CALCULATORS: Record<RankingSignalName, (file: FileMetadata, context: SignalContext) => RankingSignalContribution> = {
  filename: signalFilename,
  'relative-path': signalRelativePath,
  directory: signalDirectory,
  'extension-language': signalExtensionLanguage,
  'project-manifest-config': signalProjectManifestConfig,
  'test-file': signalTestFile,
  'entry-point': signalEntryPoint,
  'task-type': signalTaskType,
  'explicit-mention': signalExplicitMention,
  'classification-safety': signalClassificationSafety,
};

export function computeAllSignals(
  file: FileMetadata,
  context: SignalContext
): RankingSignalContribution[] {
  const signals: RankingSignalContribution[] = [];
  for (const [, calc] of Object.entries(SIGNAL_CALCULATORS)) {
    signals.push(calc(file, context));
  }
  return signals;
}

export function computeOverallScore(
  signals: readonly RankingSignalContribution[]
): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const sig of signals) {
    totalWeight += sig.weight;
    weightedSum += sig.score * sig.weight;
  }
  if (totalWeight === 0) return 0;
  return Math.min(weightedSum / totalWeight, 1.0);
}
