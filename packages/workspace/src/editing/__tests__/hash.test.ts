import { describe, it, expect } from 'vitest';
import { sha256, sha256Bytes, isValidSha256Hash } from '../hash.js';

describe('Editing hash utilities', () => {
  describe('sha256', () => {
    it('hashes empty content', () => {
      const result = sha256('');
      expect(result).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    });

    it('hashes simple ASCII', () => {
      const result = sha256('hello');
      expect(result).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      );
    });

    it('preserves CRLF endings', () => {
      const crlf = sha256('line1\r\nline2\r\n');
      const lf = sha256('line1\nline2\n');
      expect(crlf).not.toBe(lf);
    });

    it('hashes Unicode content', () => {
      const result = sha256('héllo wörld 🚀');
      expect(result).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(result)).toBe(true);
    });

    it('is deterministic', () => {
      const r1 = sha256('same input');
      const r2 = sha256('same input');
      expect(r1).toBe(r2);
    });

    it('produces different hashes for different inputs', () => {
      expect(sha256('a')).not.toBe(sha256('b'));
    });

    it('returns lowercase hex', () => {
      const result = sha256('test');
      expect(result).toBe(result.toLowerCase());
    });

    it('handles content without trailing newline', () => {
      const result = sha256('no newline');
      expect(result).toHaveLength(64);
    });
  });

  describe('sha256Bytes', () => {
    it('hashes bytes directly', () => {
      const bytes = new TextEncoder().encode('hello');
      const result = sha256Bytes(bytes);
      expect(result).toBe(sha256('hello'));
    });

    it('is deterministic', () => {
      const bytes = new TextEncoder().encode('test');
      expect(sha256Bytes(bytes)).toBe(sha256Bytes(bytes));
    });
  });

  describe('isValidSha256Hash', () => {
    it('accepts valid lowercase hash', () => {
      expect(isValidSha256Hash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true);
    });

    it('rejects uppercase', () => {
      expect(isValidSha256Hash('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855')).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidSha256Hash('e3b0c442')).toBe(false);
      expect(isValidSha256Hash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855x')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isValidSha256Hash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85g')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidSha256Hash('')).toBe(false);
    });
  });
});
