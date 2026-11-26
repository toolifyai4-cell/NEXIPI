/**
 * Phase 10 Stage B — Edit operations engine.
 *
 * Pure function that applies validated edit operations to file content.
 * No filesystem access, no VS Code imports, no I/O of any kind.
 */

import {
  EditOperation,
  EditOperationKind,
} from './contracts.js';
import {
  MAX_EDIT_OPERATIONS,
  MAX_EDIT_CONTENT_SIZE,
} from './schemas.js';
import { EditDomainError } from './errors.js';
import { sha256 } from './hash.js';

export interface ApplyOperationsResult {
  readonly content: string;
  readonly contentHash: string;
  readonly size: number;
}

const EDIT_CONTENT_SIZE_LIMIT = MAX_EDIT_CONTENT_SIZE;

/**
 * Splits content into lines while preserving original line endings (LF and
 * CRLF). The final line without a trailing newline is included. An empty string
 * yields zero lines.
 */
export function splitLinesPreserveEndings(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (ch === '\r') {
      if (i + 1 < len && content[i + 1] === '\n') {
        lines.push(content.slice(start, i + 2));
        i += 2;
      } else {
        lines.push(content.slice(start, i + 1));
        i += 1;
      }
      start = i;
    } else if (ch === '\n') {
      lines.push(content.slice(start, i + 1));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < len) {
    lines.push(content.slice(start));
  }
  return lines;
}

function joinLines(lines: readonly string[]): string {
  let result = '';
  for (const line of lines) {
    result += line;
  }
  return result;
}

function validateOperations(
  operations: readonly EditOperation[],
  lineCount: number
): void {
  if (operations.length === 0) {
    throw new EditDomainError('EDIT_EMPTY_OPERATIONS', 'Edit operations array must not be empty');
  }
  if (operations.length > MAX_EDIT_OPERATIONS) {
    throw new EditDomainError(
      'EDIT_OPERATION_LIMIT_EXCEEDED',
      `Edit operations count ${operations.length} exceeds maximum of ${MAX_EDIT_OPERATIONS}`
    );
  }

  // replace-full must be standalone
  const replaceFull = operations.find((op) => op.kind === 'replace-full');
  if (replaceFull !== undefined && operations.length > 1) {
    throw new EditDomainError(
      'EDIT_CONFLICTING_OPERATIONS',
      'replace-full cannot be combined with other operations'
    );
  }
  if (replaceFull !== undefined) {
    const content = (replaceFull as { newContent: string }).newContent;
    if (content.length > EDIT_CONTENT_SIZE_LIMIT) {
      throw new EditDomainError(
        'EDIT_CONTENT_TOO_LARGE',
        `replace-full content size ${content.length} exceeds limit ${EDIT_CONTENT_SIZE_LIMIT}`
      );
    }
    return;
  }

  const consuming: Array<{
    kind: EditOperationKind;
    start: number;
    end: number;
  }> = [];

  const inserts: Array<{ pos: number; content: string }> = [];

  for (const op of operations) {
    if (op.kind === 'replace-lines') {
      if (op.startLine > op.endLine) {
        throw new EditDomainError(
          'EDIT_INVALID_RANGE',
          `replace-lines startLine ${op.startLine} must not exceed endLine ${op.endLine}`
        );
      }
      if (op.endLine > lineCount) {
        throw new EditDomainError(
          'EDIT_INVALID_RANGE',
          `replace-lines endLine ${op.endLine} exceeds file line count ${lineCount}`
        );
      }
      consuming.push({ kind: op.kind, start: op.startLine - 1, end: op.endLine });
    } else if (op.kind === 'delete-lines') {
      if (op.startLine > op.endLine) {
        throw new EditDomainError(
          'EDIT_INVALID_RANGE',
          `delete-lines startLine ${op.startLine} must not exceed endLine ${op.endLine}`
        );
      }
      if (op.endLine > lineCount) {
        throw new EditDomainError(
          'EDIT_INVALID_RANGE',
          `delete-lines endLine ${op.endLine} exceeds file line count ${lineCount}`
        );
      }
      consuming.push({ kind: op.kind, start: op.startLine - 1, end: op.endLine });
    } else if (op.kind === 'insert-lines') {
      const pos = op.atLine - 1; // 0-based insert index; atLine in [1, lineCount+1]
      if (op.atLine < 1 || op.atLine > lineCount + 1) {
        throw new EditDomainError(
          'EDIT_INVALID_RANGE',
          `insert-lines atLine ${op.atLine} out of bounds (valid range: 1-${lineCount + 1})`
        );
      }
      inserts.push({ pos, content: op.newContent });
    }
  }

  // Check pairwise overlap among consuming ops (disjoint required).
  // Ranges are half-open: [start, end). Sorted by start; overlap iff next.start < a.end.
  const sorted = [...consuming].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const next = sorted[i + 1];
    if (next !== undefined) {
      if (next.start < a.end) {
        throw new EditDomainError(
          'EDIT_OVERLAPPING_OPERATIONS',
          `Operations ${a.kind} [${a.start + 1}-${a.end}] and ${next.kind} [${next.start + 1}-${next.end}] overlap`
        );
      }
    }
  }

  // Check insert positions against consuming ranges.
  for (const ins of inserts) {
    for (const c of consuming) {
      if (ins.pos > c.start && ins.pos < c.end) {
        throw new EditDomainError(
          'EDIT_CONFLICTING_OPERATIONS',
          `Insert at position ${ins.pos + 1} falls inside consuming operation range [${c.start + 1}-${c.end}]`
        );
      }
    }
  }
}

function computeProposedHash(content: string): string {
  return sha256(content);
}

function computeSize(content: string): number {
  // Size in bytes (UTF-8) — mirrors FileStat.size semantics.
  const bytes = Buffer.from(content, 'utf8');
  return bytes.length;
}

export function applyOperations(
  content: string,
  operations: readonly EditOperation[]
): ApplyOperationsResult {
  const originalLines = splitLinesPreserveEndings(content);
  const lineCount = originalLines.length;

  validateOperations(operations, lineCount);

  const replaceFull = operations.find((op) => op.kind === 'replace-full');
  if (replaceFull !== undefined) {
    const resultContent = (replaceFull as { newContent: string }).newContent;
    if (resultContent.length > EDIT_CONTENT_SIZE_LIMIT) {
      throw new EditDomainError(
        'EDIT_CONTENT_TOO_LARGE',
        `replace-full content size ${resultContent.length} exceeds limit ${EDIT_CONTENT_SIZE_LIMIT}`
      );
    }
    const proposedHash = computeProposedHash(resultContent);
    return {
      content: resultContent,
      contentHash: proposedHash,
      size: computeSize(resultContent),
    };
  }

  // Build consuming ops sorted by start position (disjoint validated).
  const consumingOps: Array<{
    start: number;
    end: number;
    replacement: string[];
  }> = [];
  for (const op of operations) {
    if (op.kind === 'replace-lines') {
      consumingOps.push({
        start: op.startLine - 1,
        end: op.endLine,
        replacement: splitLinesPreserveEndings(op.newContent),
      });
    } else if (op.kind === 'delete-lines') {
      consumingOps.push({ start: op.startLine - 1, end: op.endLine, replacement: [] });
    }
  }
  consumingOps.sort((a, b) => a.start - b.start);

  const insertsByPos = new Map<number, string[]>();
  for (const op of operations) {
    if (op.kind === 'insert-lines') {
      const pos = op.atLine - 1;
      const parts = splitLinesPreserveEndings(op.newContent);
      const existing = insertsByPos.get(pos) ?? [];
      existing.push(...parts);
      insertsByPos.set(pos, existing);
    }
  }

  const resultLines: string[] = [];
  let i = 0;
  let oi = 0;

  while (i < lineCount) {
    const insertsAt = insertsByPos.get(i);
    if (insertsAt !== undefined) {
      resultLines.push(...insertsAt);
    }
    const op = consumingOps[oi];
    if (op !== undefined && op.start === i) {
      resultLines.push(...op.replacement);
      i = op.end;
      oi++;
      continue;
    }
    resultLines.push(originalLines[i]!);
    i++;
  }
  const trailingInserts = insertsByPos.get(lineCount);
  if (trailingInserts !== undefined) {
    resultLines.push(...trailingInserts);
  }

  const resultContent = joinLines(resultLines);
  const proposedHash = computeProposedHash(resultContent);
  return {
    content: resultContent,
    contentHash: proposedHash,
    size: computeSize(resultContent),
  };
}
