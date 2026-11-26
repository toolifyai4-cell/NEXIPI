import { createHash } from 'node:crypto';

/**
 * Phase 10 Stage B — SHA-256 utilities.
 *
 * Deterministic hashing for original and proposed file content.
 * All hashing operates on UTF-8 encoded bytes. Line endings are preserved
 * exactly as provided — no normalization of CRLF/LF/CR or Unicode forms.
 */

const SHA256_HEX_LENGTH = 64;

/**
 * Computes a lowercase hexadecimal SHA-256 hash of the provided content.
 *
 * @param content - String content to hash. Encoded as UTF-8 before hashing.
 * @returns Lowercase hexadecimal SHA-256 hash string (64 characters).
 */
export function sha256(content: string): string {
  const buffer = Buffer.from(content, 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Computes a lowercase hexadecimal SHA-256 hash of the provided UTF-8 bytes.
 *
 * @param bytes - Uint8Array of bytes to hash.
 * @returns Lowercase hexadecimal SHA-256 hash string (64 characters).
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validates that a string is a well-formed lowercase SHA-256 hex digest.
 *
 * @param hash - String to validate.
 * @returns true if the string is exactly 64 lowercase hex characters.
 */
export function isValidSha256Hash(hash: string): boolean {
  if (typeof hash !== 'string' || hash.length !== SHA256_HEX_LENGTH) {
    return false;
  }
  return /^[a-f0-9]{64}$/.test(hash);
}
