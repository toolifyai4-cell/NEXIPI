import { describe, it, expect } from 'vitest';
import { applyOperations, splitLinesPreserveEndings } from '../operations.js';
import { EditDomainError } from '../errors.js';

describe('Editing operations', () => {
  describe('splitLinesPreserveEndings', () => {
    it('splits empty content into zero lines', () => {
      expect(splitLinesPreserveEndings('')).toEqual([]);
    });

    it('splits LF content', () => {
      expect(splitLinesPreserveEndings('a\nb\n')).toEqual(['a\n', 'b\n']);
    });

    it('splits CRLF content', () => {
      expect(splitLinesPreserveEndings('a\r\nb\r\n')).toEqual(['a\r\n', 'b\r\n']);
    });

    it('includes final line without trailing newline', () => {
      expect(splitLinesPreserveEndings('a\nb')).toEqual(['a\n', 'b']);
    });

    it('handles single line without newline', () => {
      expect(splitLinesPreserveEndings('a')).toEqual(['a']);
    });
  });

  describe('applyOperations - replace-lines', () => {
    it('replaces a single line', () => {
      const result = applyOperations('a\nb\nc\n', [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: 'B\n' },
      ]);
      expect(result.content).toBe('a\nB\nc\n');
    });

    it('replaces a range of lines', () => {
      const result = applyOperations('a\nb\nc\nd\n', [
        { kind: 'replace-lines', startLine: 2, endLine: 3, newContent: 'B\nC\n' },
      ]);
      expect(result.content).toBe('a\nB\nC\nd\n');
    });

    it('replaces with empty content to delete lines', () => {
      const result = applyOperations('a\nb\nc\n', [
        { kind: 'replace-lines', startLine: 2, endLine: 2, newContent: '' },
      ]);
      expect(result.content).toBe('a\nc\n');
    });

    it('rejects startLine > endLine', () => {
      expect(() =>
        applyOperations('a\n', [
          { kind: 'replace-lines', startLine: 2, endLine: 1, newContent: 'x\n' },
        ])
      ).toThrow(EditDomainError);
    });

    it('rejects endLine beyond file length', () => {
      expect(() =>
        applyOperations('a\n', [
          { kind: 'replace-lines', startLine: 1, endLine: 2, newContent: 'x\n' },
        ])
      ).toThrow(EditDomainError);
    });
  });

  describe('applyOperations - insert-lines', () => {
    it('inserts at line 1 (top)', () => {
      const result = applyOperations('a\n', [
        { kind: 'insert-lines', atLine: 1, newContent: 'X\n' },
      ]);
      expect(result.content).toBe('X\na\n');
    });

    it('inserts at end (atLine = lineCount + 1)', () => {
      const result = applyOperations('a\n', [
        { kind: 'insert-lines', atLine: 2, newContent: 'X\n' },
      ]);
      expect(result.content).toBe('a\nX\n');
    });

    it('inserts in middle', () => {
      const result = applyOperations('a\nb\n', [
        { kind: 'insert-lines', atLine: 2, newContent: 'X\n' },
      ]);
      expect(result.content).toBe('a\nX\nb\n');
    });
  });

  describe('applyOperations - delete-lines', () => {
    it('deletes a range', () => {
      const result = applyOperations('a\nb\nc\n', [
        { kind: 'delete-lines', startLine: 2, endLine: 2 },
      ]);
      expect(result.content).toBe('a\nc\n');
    });
  });

  describe('applyOperations - replace-full', () => {
    it('replaces entire content', () => {
      const result = applyOperations('a\nb\n', [{ kind: 'replace-full', newContent: 'x\ny\n' }]);
      expect(result.content).toBe('x\ny\n');
      expect(result.contentHash).toHaveLength(64);
    });
  });

  describe('applyOperations - multi-op sequences', () => {
    it('applies multiple non-overlapping ops', () => {
      const result = applyOperations('a\nb\nc\nd\n', [
        { kind: 'replace-lines', startLine: 1, endLine: 1, newContent: 'A\n' },
        { kind: 'replace-lines', startLine: 3, endLine: 3, newContent: 'C2\n' },
      ]);
      expect(result.content).toBe('A\nb\nC2\nd\n');
    });

    it('rejects overlapping operations', () => {
      expect(() =>
        applyOperations('a\nb\nc\n', [
          { kind: 'replace-lines', startLine: 1, endLine: 2, newContent: 'A\n' },
          { kind: 'delete-lines', startLine: 2, endLine: 2 },
        ])
      ).toThrow(EditDomainError);
    });

    it('rejects replace-full combined with other ops', () => {
      expect(() =>
        applyOperations('a\n', [
          { kind: 'replace-full', newContent: 'x\n' },
          { kind: 'insert-lines', atLine: 1, newContent: 'y\n' },
        ])
      ).toThrow(EditDomainError);
    });

    it('rejects empty operations array', () => {
      expect(() => applyOperations('a\n', [])).toThrow(EditDomainError);
    });

    it('rejects too many operations', () => {
      const ops = Array.from({ length: 51 }, (_, i) => ({
        kind: 'insert-lines' as const,
        atLine: (i % 2) + 1,
        newContent: 'x\n',
      }));
      expect(() => applyOperations('a\n', ops)).toThrow(EditDomainError);
    });
  });

  describe('applyOperations - content limits', () => {
    it('rejects content exceeding size limit', () => {
      const bigContent = 'x'.repeat(1024 * 1024 * 11);
      expect(() =>
        applyOperations(bigContent, [{ kind: 'replace-full', newContent: bigContent }])
      ).toThrow(EditDomainError);
    });
  });

  describe('applyOperations - determinism', () => {
    it('returns deterministic results for identical inputs', () => {
      const ops = [{ kind: 'replace-lines', startLine: 1, endLine: 2, newContent: 'A\nB\n' }];
      const r1 = applyOperations('a\nb\nc\n', ops);
      const r2 = applyOperations('a\nb\nc\n', ops);
      expect(r1.content).toBe(r2.content);
      expect(r1.contentHash).toBe(r2.contentHash);
    });
  });
});
