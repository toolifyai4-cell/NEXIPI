import { describe, it, expect } from 'vitest';
import { computeDiff } from '../diff.js';

describe('Editing diff computation', () => {
  describe('computeDiff - identical content', () => {
    it('returns empty diff for identical content', () => {
      const result = computeDiff('a\nb\nc\n', 'a\nb\nc\n');
      expect(result.hunks).toEqual([]);
      expect(result.summary.linesAdded).toBe(0);
      expect(result.summary.linesRemoved).toBe(0);
      expect(result.summary.linesModified).toBe(0);
    });

    it('returns empty entries for empty vs empty', () => {
      const result = computeDiff('', '');
      expect(result.entries).toEqual([]);
      expect(result.hunks).toEqual([]);
    });
  });

  describe('computeDiff - insertions', () => {
    it('detects a single line insertion', () => {
      const result = computeDiff('a\nb\n', 'a\nX\nb\n');
      expect(result.summary.linesAdded).toBe(1);
      expect(result.summary.linesRemoved).toBe(0);
      expect(result.hunks.length).toBeGreaterThan(0);
      const hunk = result.hunks[0]!;
      expect(hunk.originalStart).toBe(1);
      expect(hunk.originalEnd).toBe(2);
      expect(hunk.proposedStart).toBe(1);
      expect(hunk.proposedEnd).toBe(3);
      expect(hunk.contextBefore).toEqual(['a\n']);
      expect(hunk.contextAfter).toEqual(['b\n']);
    });
  });

  describe('computeDiff - deletions', () => {
    it('detects a single line deletion', () => {
      const result = computeDiff('a\nb\nc\n', 'a\nc\n');
      expect(result.summary.linesRemoved).toBe(1);
      expect(result.summary.linesAdded).toBe(0);
      expect(result.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('computeDiff - replacements', () => {
    it('detects a replacement', () => {
      const result = computeDiff('a\nb\n', 'a\nB\n');
      expect(result.summary.linesAdded).toBe(1);
      expect(result.summary.linesRemoved).toBe(1);
      expect(result.summary.linesModified).toBe(1);
      expect(result.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('computeDiff - multiple hunks', () => {
    it('detects multiple separate changes', () => {
      const result = computeDiff('a\nb\nc\nd\ne\n', 'A\nb\nc2\nd\ne\n');
      expect(result.hunks.length).toBeGreaterThanOrEqual(2);
      expect(result.summary.linesAdded).toBe(2);
      expect(result.summary.linesRemoved).toBe(2);
      expect(result.summary.linesModified).toBe(2);
    });
  });

  describe('computeDiff - context lines', () => {
    it('includes context lines', () => {
      const result = computeDiff('a\nb\nc\n', 'a\nX\nc\n', { contextLines: 2 });
      const hunk = result.hunks[0]!;
      expect(hunk.contextBefore).toEqual(['a\n']);
      expect(hunk.contextAfter).toEqual(['c\n']);
    });
  });

  describe('computeDiff - empty files', () => {
    it('handles empty original', () => {
      const result = computeDiff('', 'a\nb\n');
      expect(result.summary.linesAdded).toBe(2);
      expect(result.hunks.length).toBeGreaterThan(0);
    });

    it('handles empty proposed', () => {
      const result = computeDiff('a\nb\n', '');
      expect(result.summary.linesRemoved).toBe(2);
      expect(result.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('computeDiff - determinism', () => {
    it('returns identical results for identical inputs', () => {
      const r1 = computeDiff('a\nb\nc\n', 'a\nB\nc\n');
      const r2 = computeDiff('a\nb\nc\n', 'a\nB\nc\n');
      expect(r1.entries).toEqual(r2.entries);
      expect(r1.hunks).toEqual(r2.hunks);
      expect(r1.summary).toEqual(r2.summary);
    });
  });

  describe('computeDiff - entries structure', () => {
    it('builds a valid entry sequence', () => {
      const result = computeDiff('a\nb\n', 'a\nX\nb\n');
      const first = result.entries[0]!;
      expect(first.kind).toBe('equal');
      expect(first.value).toBe('a\n');
    });
  });
});
