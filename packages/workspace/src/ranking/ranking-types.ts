export type { FileMetadata, WorkspaceFolderId } from '../types.js';
import type { FileMetadata, WorkspaceFolderId } from '../types.js';

export type RankingCandidateId = string & { readonly __brand: unique symbol };

export function createRankingCandidateId(id: string): RankingCandidateId {
  return id as RankingCandidateId;
}

export type TaskCategory =
  | 'bug-fixing'
  | 'feature-implementation'
  | 'refactoring'
  | 'testing'
  | 'documentation'
  | 'configuration'
  | 'architecture-exploration'
  | 'debugging'
  | 'general-explanation'
  | 'unknown';

export type RankingSignalName =
  | 'filename'
  | 'relative-path'
  | 'directory'
  | 'extension-language'
  | 'project-manifest-config'
  | 'test-file'
  | 'entry-point'
  | 'task-type'
  | 'explicit-mention'
  | 'classification-safety';

export interface RankingSignalContribution {
  readonly name: RankingSignalName;
  readonly weight: number;
  readonly score: number;
  readonly reason: string;
}

export interface RankingCandidate {
  readonly id: RankingCandidateId;
  readonly file: FileMetadata;
  readonly projectId: string | undefined;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly overallScore: number;
  readonly normalizedScore: number;
  readonly signals: readonly RankingSignalContribution[];
  readonly included: boolean;
  readonly inclusionReasons: readonly string[];
  readonly exclusionReasons: readonly string[];
  readonly isEligible: boolean;
}

export interface RankingOptions {
  readonly query: string;
  readonly explicitMentions?: readonly string[];
  readonly taskCategory?: TaskCategory;
  readonly signal?: AbortSignal;
}

export interface RankingResult {
  readonly query: string;
  readonly taskCategory: TaskCategory;
  readonly candidates: readonly RankingCandidate[];
  readonly totalCandidates: number;
  readonly eligibleCandidates: number;
  readonly includedCandidates: number;
  readonly excludedCandidates: number;
  readonly sortedByScore: readonly RankingCandidate[];
  readonly signal: AbortSignal | undefined;
}

export interface RankedFile {
  readonly id: RankingCandidateId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly projectId?: string;
  readonly category: FileMetadata['category'];
  readonly language: string | null;
  readonly size: number;
  readonly overallScore: number;
  readonly normalizedScore: number;
  readonly signals: readonly RankingSignalContribution[];
  readonly inclusionReasons: readonly string[];
  readonly exclusionReasons: readonly string[];
  readonly isEligible: boolean;
}

export interface RankingWeights {
  readonly filename: number;
  readonly relativePath: number;
  readonly directory: number;
  readonly extensionLanguage: number;
  readonly projectManifestConfig: number;
  readonly testFile: number;
  readonly entryPoint: number;
  readonly taskType: number;
  readonly explicitMention: number;
  readonly classificationSafety: number;
}

export const defaultRankingWeights: RankingWeights = {
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

export interface ContextSelectionOptions {
  readonly maxFileCount: number;
  readonly maxBudget: number;
  readonly minRelevanceScore: number;
  readonly enableDiversity: boolean;
  readonly maxPerDirectory: number;
  readonly maxPerProject: number;
  readonly priorityMentions?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ContextBudgetEstimate {
  readonly unit: 'bytes';
  readonly estimatedBytes: number;
  readonly cost: number;
}

export interface SelectedFile {
  readonly id: RankingCandidateId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly projectId: string | undefined;
  readonly category: FileMetadata['category'];
  readonly language: string | null;
  readonly size: number;
  readonly estimatedCost: number;
  readonly overallScore: number;
  readonly selectionReason: string;
  readonly skippedReason: string | undefined;
}

export interface ContextSelectionResult {
  readonly selected: readonly SelectedFile[];
  readonly skipped: readonly SelectedFile[];
  readonly totalCandidates: number;
  readonly selectedCount: number;
  readonly skippedCount: number;
  readonly totalBudgetUsed: number;
  readonly totalBudget: number;
  readonly budgetExceeded: boolean;
  readonly countLimitReached: boolean;
  readonly thresholdExcluded: number;
  readonly safetyExcluded: number;
  readonly dedupRemoved: number;
  readonly selectionReasons: readonly string[];
  readonly skipReasons: readonly string[];
}
