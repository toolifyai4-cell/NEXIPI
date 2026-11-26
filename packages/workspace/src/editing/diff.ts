/**
 * Phase 10 Stage B — Pure diff computation for edit previews.
 *
 * Computes a deterministic line-based diff between original and proposed
 * content. No filesystem access, no VS Code imports.
 *
 * Algorithm: LCS via dynamic programming with backtracking to derive an
 * edit script of equal/delete/insert entries. Entries are grouped into
 * hunks with configurable context lines.
 *
 * Input is bounded to protect against unbounded memory use; oversized
 * inputs are truncated before diffing and `truncated` is reported.
 */

import type { DiffHunk, DiffSummary } from './contracts.js';
import { splitLinesPreserveEndings } from './operations.js';

export interface DiffEntry {
  readonly kind: 'equal' | 'delete' | 'insert';
  readonly value: string;
}

export interface ComputeDiffOptions {
  /** Number of context lines before/after each hunk. Default 3. */
  readonly contextLines?: number;
  /** Maximum total lines (original + proposed) for full diff. Default 4000. */
  readonly maxLines?: number;
}

export interface ComputeDiffResult {
  readonly entries: readonly DiffEntry[];
  readonly hunks: readonly DiffHunk[];
  readonly summary: DiffSummary;
  readonly truncated: boolean;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_LINES = 4000;

/**
 * Computes a line-based diff between original and proposed content.
 *
 * Both inputs are split into lines preserving original line endings. The
 * diff is deterministic: identical inputs always produce identical output.
 */
export function computeDiff(
  originalContent: string,
  proposedContent: string,
  options: ComputeDiffOptions = {}
): ComputeDiffResult {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  const originalLines = splitLinesPreserveEndings(originalContent);
  const proposedLines = splitLinesPreserveEndings(proposedContent);

  const totalLines = originalLines.length + proposedLines.length;
  const truncated = totalLines > maxLines;

  let a = originalLines;
  let b = proposedLines;
  if (truncated) {
    const half = Math.max(1, Math.floor(maxLines / 2));
    const aHead = originalLines.slice(0, half);
    const aTail = originalLines.slice(Math.max(half, originalLines.length - half));
    const bHead = proposedLines.slice(0, half);
    const bTail = proposedLines.slice(Math.max(half, proposedLines.length - half));
    a = [...aHead, ...aTail];
    b = [...bHead, ...bTail];
  }

  const entries = lcsDiff(a, b);
  const hunks = buildHunks(entries, contextLines);
  const summary = summarize(entries);

  return { entries, hunks, summary, truncated };
}

interface LcsPair {
  readonly aIndex: number;
  readonly bIndex: number;
}

function lcsDiff(a: readonly string[], b: readonly string[]): DiffEntry[] {
  const n = a.length;
  const m = b.length;

  if (n === 0) {
    return b.map(value => ({ kind: 'insert' as const, value }));
  }
  if (m === 0) {
    return a.map(value => ({ kind: 'delete' as const, value }));
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const pairs: LcsPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push({ aIndex: i - 1, bIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();

  const entries: DiffEntry[] = [];
  let ai = 0;
  let bi = 0;
  for (const pair of pairs) {
    for (; ai < pair.aIndex; ai++) {
      entries.push({ kind: 'delete', value: a[ai]! });
    }
    for (; bi < pair.bIndex; bi++) {
      entries.push({ kind: 'insert', value: b[bi]! });
    }
    entries.push({ kind: 'equal', value: a[pair.aIndex]! });
    ai = pair.aIndex + 1;
    bi = pair.bIndex + 1;
  }
  for (; ai < n; ai++) {
    entries.push({ kind: 'delete', value: a[ai]! });
  }
  for (; bi < m; bi++) {
    entries.push({ kind: 'insert', value: b[bi]! });
  }

  return entries;
}

function buildHunks(entries: readonly DiffEntry[], contextLines: number): DiffHunk[] {
  const len = entries.length;
  if (len === 0) {
    return [];
  }

  const prefixOriginal: number[] = Array.from({ length: len + 1 }, () => 0);
  const prefixProposed: number[] = Array.from({ length: len + 1 }, () => 0);
  for (let k = 0; k < len; k++) {
    const entry = entries[k]!;
    const origBefore = prefixOriginal[k]!;
    const propBefore = prefixProposed[k]!;
    if (entry.kind === 'equal' || entry.kind === 'delete') {
      prefixOriginal[k + 1] = origBefore + 1;
    } else {
      prefixOriginal[k + 1] = origBefore;
    }
    if (entry.kind === 'equal' || entry.kind === 'insert') {
      prefixProposed[k + 1] = propBefore + 1;
    } else {
      prefixProposed[k + 1] = propBefore;
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < len) {
    if (entries[i]!.kind === 'equal') {
      i++;
      continue;
    }

    const changeStart = i;
    while (i < len && entries[i]!.kind !== 'equal') {
      i++;
    }
    const changeEnd = i;

    const contextStart = Math.max(0, changeStart - contextLines);
    const contextEnd = Math.min(len, changeEnd + contextLines);

    const contextBefore: string[] = [];
    for (let c = contextStart; c < changeStart; c++) {
      contextBefore.push(entries[c]!.value);
    }
    const contextAfter: string[] = [];
    for (let c = changeEnd; c < contextEnd; c++) {
      contextAfter.push(entries[c]!.value);
    }

    const originalStart = prefixOriginal[contextStart]! + 1;
    const originalEnd = Math.max(originalStart, prefixOriginal[contextEnd]!);
    const proposedStart = prefixProposed[contextStart]! + 1;
    const proposedEnd = Math.max(proposedStart, prefixProposed[contextEnd]!);

    hunks.push({
      originalStart,
      originalEnd,
      proposedStart,
      proposedEnd,
      contextBefore,
      contextAfter,
    });
  }

  return hunks;
}

function summarize(entries: readonly DiffEntry[]): DiffSummary {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const entry of entries) {
    if (entry.kind === 'insert') {
      linesAdded++;
    } else if (entry.kind === 'delete') {
      linesRemoved++;
    }
  }
  const linesModified = Math.min(linesAdded, linesRemoved);
  return { linesAdded, linesRemoved, linesModified };
}
