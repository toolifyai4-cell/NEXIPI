import type {
  FileMetadata,
  RankingCandidateId,
  WorkspaceFolderId,
  ContextSelectionOptions,
  SelectedFile,
  ContextSelectionResult,
} from './ranking-types.js';
import { ContextBudget, ByteBudgetEstimator, type BudgetEstimator } from './context-budget.js';

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('Operation aborted') as Error & { code?: string };
    err.name = 'AbortError';
    throw err;
  }
}

function directoryKey(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/') || '(root)';
}

export interface CandidateSelectionInput {
  readonly id: RankingCandidateId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly workspaceFolderId: string;
  readonly projectId?: string;
  readonly category: FileMetadata['category'];
  readonly language: string | null;
  readonly size: number;
  readonly overallScore: number;
  readonly normalizedScore: number;
  readonly isEligible: boolean;
  readonly inclusionReasons: readonly string[];
  readonly exclusionReasons: readonly string[];
}

export class ContextSelector {
  private readonly maxFileCount: number;
  private readonly maxBudget: number;
  private readonly minRelevanceScore: number;
  private readonly enableDiversity: boolean;
  private readonly maxPerDirectory: number;
  private readonly maxPerProject: number;
  private readonly priorityMentions: readonly string[];
  private readonly estimator: BudgetEstimator;

  constructor(options: ContextSelectionOptions) {
    this.maxFileCount = options.maxFileCount;
    this.maxBudget = options.maxBudget;
    this.minRelevanceScore = options.minRelevanceScore;
    this.enableDiversity = options.enableDiversity;
    this.maxPerDirectory = options.maxPerDirectory;
    this.maxPerProject = options.maxPerProject;
    this.priorityMentions = options.priorityMentions ?? [];
    this.estimator = new ByteBudgetEstimator(512, 0.001);
  }

  select(
    candidates: readonly CandidateSelectionInput[]
  ): ContextSelectionResult {
    const budget = new ContextBudget({
      maxBudget: this.maxBudget,
      estimator: this.estimator,
    });

    const selected: SelectedFile[] = [];
    const skipped: SelectedFile[] = [];
    const seenIds = new Set<string>();
    const dirCounts = new Map<string, number>();
    const projectCounts = new Map<string, number>();

    let thresholdExcluded = 0;
    let safetyExcluded = 0;
    let dedupRemoved = 0;
    let budgetLimited = false;
    const selectionReasons: string[] = [];
    const skipReasons: string[] = [];

    const prioritySet = new Set(this.priorityMentions.map((m) => m.toLowerCase()));
    const PRIORITY_BOOST = 0.5;

    const sorted = [...candidates].sort((a, b) => {
      const aIsPriority = prioritySet.size > 0 && (
        prioritySet.has(a.relativePath.toLowerCase()) ||
        [...prioritySet].some((p) => a.relativePath.toLowerCase().includes(p))
      );
      const bIsPriority = prioritySet.size > 0 && (
        prioritySet.has(b.relativePath.toLowerCase()) ||
        [...prioritySet].some((p) => b.relativePath.toLowerCase().includes(p))
      );
      const aScore = aIsPriority ? a.overallScore + PRIORITY_BOOST : a.overallScore;
      const bScore = bIsPriority ? b.overallScore + PRIORITY_BOOST : b.overallScore;
      if (bScore !== aScore) {
        return bScore - aScore;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    for (const cand of sorted) {
      checkAborted(undefined);

      const relKey = cand.relativePath.toLowerCase();
      const isPriority = prioritySet.size > 0 && (
        prioritySet.has(relKey) ||
        [...prioritySet].some((p) => relKey.includes(p))
      );

      if (!cand.isEligible) {
        safetyExcluded += 1;
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: this.estimator.estimateCostFromSize(cand.size),
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: `Excluded by safety/eligibility: ${cand.exclusionReasons.join('; ') || 'ineligible'}`,
        });
        skipReasons.push(`${cand.relativePath}: safety/eligibility exclusion`);
        continue;
      }

      if (cand.overallScore < this.minRelevanceScore) {
        thresholdExcluded += 1;
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: this.estimator.estimateCostFromSize(cand.size),
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: `Below minimum relevance score (${cand.overallScore.toFixed(3)} < ${this.minRelevanceScore.toFixed(3)})`,
        });
        skipReasons.push(`${cand.relativePath}: below threshold`);
        continue;
      }

      if (seenIds.has(cand.id)) {
        dedupRemoved += 1;
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: this.estimator.estimateCostFromSize(cand.size),
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: 'Duplicate candidate',
        });
        skipReasons.push(`${cand.relativePath}: duplicate`);
        continue;
      }

      const dir = directoryKey(cand.relativePath);
      const dirCount = dirCounts.get(dir) ?? 0;
      const projCount = projectCounts.get(cand.projectId ?? '(none)') ?? 0;

      let diversitySkipped = false;
      let diversityReason = '';
      if (this.enableDiversity) {
        if (dirCount >= this.maxPerDirectory) {
          diversitySkipped = true;
          diversityReason = `directory limit reached (${dirCount}/${this.maxPerDirectory})`;
        } else if (cand.projectId && projCount >= this.maxPerProject) {
          diversitySkipped = true;
          diversityReason = `project limit reached (${projCount}/${this.maxPerProject})`;
        }
      }

      if (diversitySkipped && !isPriority) {
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: this.estimator.estimateCostFromSize(cand.size),
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: `Diversity: ${diversityReason}`,
        });
        skipReasons.push(`${cand.relativePath}: ${diversityReason}`);
        continue;
      }

      const cost = this.estimator.estimateCostFromSize(cand.size);

      if (!budget.canAfford(cost)) {
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: cost,
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: `Budget exceeded (would use ${cost}, remaining ${budget.getRemainingBudget()})`,
        });
        skipReasons.push(`${cand.relativePath}: budget limit`);
        budgetLimited = true;
        continue;
      }

      if (selected.length >= this.maxFileCount && !isPriority) {
        skipped.push({
          id: cand.id,
          relativePath: cand.relativePath,
          absolutePath: cand.absolutePath,
          workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
          projectId: cand.projectId,
          category: cand.category,
          language: cand.language,
          size: cand.size,
          estimatedCost: cost,
          overallScore: cand.overallScore,
          selectionReason: '',
          skippedReason: `File count limit reached (${this.maxFileCount})`,
        });
        skipReasons.push(`${cand.relativePath}: count limit`);
        continue;
      }

      budget.reserve(cost);
      seenIds.add(cand.id);
      dirCounts.set(dir, dirCount + 1);
      if (cand.projectId) {
        projectCounts.set(cand.projectId, projCount + 1);
      }

      const reasonParts: string[] = [];
      if (isPriority) reasonParts.push('priority mention');
      reasonParts.push(`score ${cand.overallScore.toFixed(3)}`);
      reasonParts.push(`cost ${cost}`);
      if (cand.inclusionReasons.length > 0) {
        reasonParts.push(`signals: ${cand.inclusionReasons.join('; ')}`);
      }

      selected.push({
        id: cand.id,
        relativePath: cand.relativePath,
        absolutePath: cand.absolutePath,
        workspaceFolderId: cand.workspaceFolderId as unknown as WorkspaceFolderId,
        projectId: cand.projectId,
        category: cand.category,
        language: cand.language,
        size: cand.size,
        estimatedCost: cost,
        overallScore: cand.overallScore,
        selectionReason: reasonParts.join(', '),
        skippedReason: undefined,
      });
      selectionReasons.push(`${cand.relativePath}: selected (${reasonParts.join(', ')})`);
    }

    const result = budget.toResult();
    return {
      selected,
      skipped,
      totalCandidates: candidates.length,
      selectedCount: selected.length,
      skippedCount: skipped.length,
      totalBudgetUsed: result.usedBudget,
      totalBudget: result.maxBudget,
      budgetExceeded: result.exceeded || budgetLimited,
      countLimitReached: selected.length >= this.maxFileCount,
      thresholdExcluded,
      safetyExcluded,
      dedupRemoved,
      selectionReasons,
      skipReasons,
    };
  }
}

export function createContextSelector(options: ContextSelectionOptions): ContextSelector {
  return new ContextSelector(options);
}
