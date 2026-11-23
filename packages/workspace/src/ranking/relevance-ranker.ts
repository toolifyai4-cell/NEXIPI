import type {
  FileMetadata,
  WorkspaceFolderId,
  RankingCandidateId,
  RankingCandidate,
  RankingResult,
  RankingOptions,
  RankingWeights,
} from './ranking-types.js';
import {
  computeAllSignals,
  computeOverallScore,
  type SignalContext,
} from './relevance-signals.js';
import { classifyTask, type TaskClassification } from './task-classifier.js';
import { InvalidQueryError, InvalidRankingConfigError } from './ranking-errors.js';
import { safeValidateRankingWeights } from './ranking-config.js';

function normalizeRelativePath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/\/+$/, '');
}

function candidateId(relativePath: string, workspaceFolderId: WorkspaceFolderId): RankingCandidateId {
  const str = `${workspaceFolderId}:${normalizeRelativePath(relativePath)}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `rank_${Math.abs(hash).toString(36)}` as RankingCandidateId;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('Operation aborted') as Error & { code?: string };
    err.name = 'AbortError';
    throw err;
  }
}

export class RelevanceRanker {
  private readonly weights: RankingWeights;

  constructor(weights?: Partial<RankingWeights>) {
    const merged: RankingWeights = {
      ...defaultRankingWeights,
      ...weights,
    };
    const validated = safeValidateRankingWeights(merged);
    if (!validated.success) {
      throw new InvalidRankingConfigError(
        `Invalid ranking weights: ${validated.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    this.weights = validated.data;
  }

  getWeights(): RankingWeights {
    return { ...this.weights };
  }

  rank(options: RankingOptions, files: readonly FileMetadata[]): RankingResult {
    if (!options.query || options.query.trim().length === 0) {
      throw new InvalidQueryError('Query must not be empty');
    }

    const classification = classifyTask(options.query, {
      ...(options.taskCategory !== undefined ? { explicitCategory: options.taskCategory } : {}),
    });

    const candidates: RankingCandidate[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      checkAborted(options.signal);

      const relKey = normalizeRelativePath(file.relativePath);
      const dedupKey = `${file.workspaceFolderId}:${relKey}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);

      const context: SignalContext = {
        query: options.query,
        taskCategory: classification.category,
        weights: this.weights,
        workspaceFolderId: file.workspaceFolderId as unknown as string,
        ...(options.explicitMentions !== undefined ? { explicitMentions: options.explicitMentions } : {}),
        ...(file.projectId !== undefined ? { projectId: file.projectId } : {}),
      };

      const signals = computeAllSignals(file, context);
      const overallScore = computeOverallScore(signals);

      const inclusionReasons: string[] = [];
      const exclusionReasons: string[] = [];
      let isEligible = true;

      for (const sig of signals) {
        if (sig.name === 'classification-safety' && sig.score === 0) {
          isEligible = false;
          exclusionReasons.push(sig.reason);
        } else if (sig.score > 0) {
          inclusionReasons.push(sig.reason);
        }
      }

      if (inclusionReasons.length === 0 && isEligible) {
        inclusionReasons.push('No strong relevance signals; baseline candidate');
      }

      const normalizedScore = Math.round(overallScore * 10000) / 10000;

      candidates.push({
        id: candidateId(file.relativePath, file.workspaceFolderId),
        file,
        projectId: file.projectId,
        workspaceFolderId: file.workspaceFolderId,
        overallScore,
        normalizedScore,
        signals,
        included: false,
        inclusionReasons,
        exclusionReasons,
        isEligible,
      });
    }

    checkAborted(options.signal);

    const sorted = [...candidates].sort((a, b) => {
      if (b.overallScore !== a.overallScore) {
        return b.overallScore - a.overallScore;
      }
      if (a.normalizedScore !== b.normalizedScore) {
        return b.normalizedScore - a.normalizedScore;
      }
      const pa = a.file.relativePath.localeCompare(b.file.relativePath);
      if (pa !== 0) return pa;
      return a.file.name.localeCompare(b.file.name);
    });

    const eligibleCount = candidates.filter((c) => c.isEligible).length;
    const includedCount = candidates.filter((c) => c.included).length;
    const excludedCount = candidates.length - includedCount;

    return {
      query: options.query,
      taskCategory: classification.category,
      candidates,
      totalCandidates: candidates.length,
      eligibleCandidates: eligibleCount,
      includedCandidates: includedCount,
      excludedCandidates: excludedCount,
      sortedByScore: sorted,
      signal: options.signal,
    };
  }

  rankToRankedFiles(options: RankingOptions, files: readonly FileMetadata[]): {
    readonly classification: TaskClassification;
    readonly rankedFiles: ReadonlyArray<{
      readonly id: RankingCandidateId;
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly workspaceFolderId: WorkspaceFolderId;
      readonly projectId: string | undefined;
      readonly category: FileMetadata['category'];
      readonly language: string | null;
      readonly size: number;
      readonly overallScore: number;
      readonly normalizedScore: number;
      readonly signals: ReadonlyArray<{ readonly name: string; readonly weight: number; readonly score: number; readonly reason: string }>;
      readonly inclusionReasons: readonly string[];
      readonly exclusionReasons: readonly string[];
      readonly isEligible: boolean;
    }>;
  } {
    const result = this.rank(options, files);
    return {
      classification: {
        category: result.taskCategory,
        confidence: 0,
        matchedKeywords: [],
        reasons: [],
      },
      rankedFiles: result.sortedByScore.map((c) => ({
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
        signals: c.signals,
        inclusionReasons: c.inclusionReasons,
        exclusionReasons: c.exclusionReasons,
        isEligible: c.isEligible,
      })),
    };
  }
}

export function createRelevanceRanker(weights?: Partial<RankingWeights>): RelevanceRanker {
  return new RelevanceRanker(weights);
}

const defaultRankingWeights: RankingWeights = {
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
