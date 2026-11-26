import { describe, it, expect } from 'vitest';
import {
  WritableFileSystemError,
  type WritableFileSystemErrorCode,
  validateWorkspaceBoundary,
  generateTempFileName,
  classifyFilesystemError,
} from '../writable-file-system.js';

describe('WritableFileSystemError', () => {
  it('carries a code and message', () => {
    const error = new WritableFileSystemError('WRITE_PERMISSION_DENIED', 'Permission denied');
    expect(error.code).toBe('WRITE_PERMISSION_DENIED');
    expect(error.message).toBe('Permission denied');
    expect(error.name).toBe('WritableFileSystemError');
  });

  it('is an instance of Error', () => {
    const error = new WritableFileSystemError('RENAME_NOT_FOUND', 'Not found');
    expect(error).toBeInstanceOf(Error);
  });

  it('covers all defined error codes', () => {
    const codes: WritableFileSystemErrorCode[] = [
      'WRITE_FILE_NOT_FOUND',
      'WRITE_PERMISSION_DENIED',
      'WRITE_INVALID_DESTINATION',
      'WRITE_SYMLINK_NOT_ALLOWED',
      'WRITE_FILESYSTEM_ERROR',
      'WRITE_CANCELLED',
      'RENAME_NOT_FOUND',
      'RENAME_PERMISSION_DENIED',
      'RENAME_INVALID_DESTINATION',
      'RENAME_SYMLINK_NOT_ALLOWED',
      'RENAME_FILESYSTEM_ERROR',
      'RENAME_CANCELLED',
      'RENAME_OVERWRITE_DISALLOWED',
      'DELETE_NOT_FOUND',
      'DELETE_PERMISSION_DENIED',
      'DELETE_INVALID_DESTINATION',
      'DELETE_FILESYSTEM_ERROR',
      'DELETE_CANCELLED',
      'TEMP_FILE_CREATE_FAILED',
      'TEMP_FILE_CLEANUP_FAILED',
    ];
    for (const code of codes) {
      const error = new WritableFileSystemError(code, 'message');
      expect(error.code).toBe(code);
    }
  });
});

describe('validateWorkspaceBoundary', () => {
  const root = 'file:///workspace';

  it('accepts a path inside the workspace root', () => {
    const rel = validateWorkspaceBoundary(root, 'file:///workspace/src/file.ts');
    expect(rel).toBe('src/file.ts');
  });

  it('accepts the workspace root itself', () => {
    const rel = validateWorkspaceBoundary(root, root);
    expect(rel).toBe('');
  });

  it('accepts scheme-stripped absolute paths', () => {
    const rel = validateWorkspaceBoundary('/workspace', '/workspace/src/file.ts');
    expect(rel).toBe('src/file.ts');
  });

  it('rejects a path outside the workspace root', () => {
    expect(() => validateWorkspaceBoundary(root, 'file:///outside/file.ts')).toThrow(
      WritableFileSystemError
    );
  });

  it('rejects path traversal attempts', () => {
    expect(() =>
      validateWorkspaceBoundary(root, 'file:///workspace/src/../../outside/file.ts')
    ).toThrow(WritableFileSystemError);
  });

  it('rejects a sibling path outside workspace', () => {
    expect(() => validateWorkspaceBoundary(root, 'file:///workspace-src/file.ts')).toThrow(
      WritableFileSystemError
    );
  });

  it('carries WRITE_INVALID_DESTINATION code for out-of-workspace paths', () => {
    try {
      validateWorkspaceBoundary(root, 'file:///outside/file.ts');
    } catch (error) {
      if (error instanceof WritableFileSystemError) {
        expect(error.code).toBe('WRITE_INVALID_DESTINATION');
      } else {
        throw error;
      }
    }
  });
});

describe('generateTempFileName', () => {
  it('places the temp file in the same directory as the target', () => {
    const temp = generateTempFileName('file:///workspace/src/file.ts');
    const dir = temp.slice(0, temp.lastIndexOf('/'));
    expect(dir).toBe('/workspace/src');
  });

  it('uses a collision-resistant UUID-based name', () => {
    const temp1 = generateTempFileName('file:///workspace/src/file.ts');
    const temp2 = generateTempFileName('file:///workspace/src/file.ts');
    expect(temp1).not.toBe(temp2);
    expect(temp1).toMatch(/\.nexipi-tmp-[0-9a-f-]{36}-file\.ts$/);
  });

  it('preserves the target basename in the temp name', () => {
    const temp = generateTempFileName('file:///workspace/src/file.ts');
    expect(temp).toMatch(/file\.ts$/);
  });

  it('handles scheme-stripped paths', () => {
    const temp = generateTempFileName('/workspace/src/file.ts');
    const dir = temp.slice(0, temp.lastIndexOf('/'));
    expect(dir).toBe('/workspace/src');
    expect(temp).toMatch(/\.ts$/);
  });
});

describe('classifyFilesystemError', () => {
  it('maps ENOENT to NOT_FOUND for write context', () => {
    const error = new Error('ENOENT: no such file') as Error & { code: string };
    error.code = 'ENOENT';
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_FILE_NOT_FOUND');
    expect(classifyFilesystemError(error, 'rename')).toBe('RENAME_NOT_FOUND');
    expect(classifyFilesystemError(error, 'delete')).toBe('DELETE_NOT_FOUND');
  });

  it('maps permission errors to PERMISSION_DENIED', () => {
    const error = new Error('EACCES: permission denied') as Error & { code: string };
    error.code = 'EACCES';
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_PERMISSION_DENIED');
    expect(classifyFilesystemError(error, 'delete')).toBe('DELETE_PERMISSION_DENIED');
  });

  it('maps AbortError to CANCELLED', () => {
    const error = new Error('cancelled') as Error;
    error.name = 'AbortError';
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_CANCELLED');
    expect(classifyFilesystemError(error, 'rename')).toBe('RENAME_CANCELLED');
    expect(classifyFilesystemError(error, 'delete')).toBe('DELETE_CANCELLED');
  });

  it('maps EISDIR to INVALID_DESTINATION', () => {
    const error = new Error('EISDIR: not a file') as Error & { code: string };
    error.code = 'EISDIR';
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_INVALID_DESTINATION');
  });

  it('maps ELOOP symlink errors to SYMLINK_NOT_ALLOWED', () => {
    const error = new Error('ELOOP: too many symbolic links') as Error & { code: string };
    error.code = 'ELOOP';
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_SYMLINK_NOT_ALLOWED');
  });

  it('falls back to FILESYSTEM_ERROR for unknown errors', () => {
    const error = new Error('boom');
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_FILESYSTEM_ERROR');
    expect(classifyFilesystemError(error, 'rename')).toBe('RENAME_FILESYSTEM_ERROR');
    expect(classifyFilesystemError(error, 'delete')).toBe('DELETE_FILESYSTEM_ERROR');
    expect(classifyFilesystemError(error, 'temp')).toBe('TEMP_FILE_CREATE_FAILED');
  });

  it('maps plain objects without code', () => {
    const error = { message: 'unknown failure' };
    expect(classifyFilesystemError(error, 'write')).toBe('WRITE_FILESYSTEM_ERROR');
  });
});
