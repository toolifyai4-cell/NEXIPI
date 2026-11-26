/**
 * Phase 10 Stage C — Writable filesystem capability.
 *
 * A separate capability from the read-only {@link FileSystemProvider}, providing
 * minimal write operations: write file bytes, rename, and delete.
 *
 * The domain is platform-independent and does not import VS Code APIs.
 * Cancellation signals are respected where the underlying API allows it.
 * Path-security and workspace-isolation are enforced by the adapter layer.
 */

import { normalizePath, relativePath } from '../tools/classification.js';
import { randomUUID } from 'node:crypto';

/**
 * Error codes for writable filesystem operations.
 */
export type WritableFileSystemErrorCode =
  | 'WRITE_FILE_NOT_FOUND'
  | 'WRITE_PERMISSION_DENIED'
  | 'WRITE_INVALID_DESTINATION'
  | 'WRITE_SYMLINK_NOT_ALLOWED'
  | 'WRITE_FILESYSTEM_ERROR'
  | 'WRITE_CANCELLED'
  | 'RENAME_NOT_FOUND'
  | 'RENAME_PERMISSION_DENIED'
  | 'RENAME_INVALID_DESTINATION'
  | 'RENAME_SYMLINK_NOT_ALLOWED'
  | 'RENAME_FILESYSTEM_ERROR'
  | 'RENAME_CANCELLED'
  | 'RENAME_OVERWRITE_DISALLOWED'
  | 'DELETE_NOT_FOUND'
  | 'DELETE_PERMISSION_DENIED'
  | 'DELETE_INVALID_DESTINATION'
  | 'DELETE_FILESYSTEM_ERROR'
  | 'DELETE_CANCELLED'
  | 'TEMP_FILE_CREATE_FAILED'
  | 'TEMP_FILE_CLEANUP_FAILED';

/**
 * Typed error class for writable filesystem operation failures.
 *
 * All messages are intentionally non-sensitive and do not expose file contents.
 */
export class WritableFileSystemError extends Error {
  public readonly code: WritableFileSystemErrorCode;

  constructor(code: WritableFileSystemErrorCode, message: string) {
    super(message);
    this.name = 'WritableFileSystemError';
    this.code = code;
    Object.setPrototypeOf(this, WritableFileSystemError.prototype);
  }
}

/**
 * Minimum writable filesystem operations.
 *
 * The domain interface is separate from the read-only
 * {@link FileSystemProvider}. Implementations must enforce workspace
 * boundaries and symlink protections; the adapter layer handles
 * platform-specific details.
 */
export interface WritableFileSystemProvider {
  /**
   * Write file bytes to the specified URI.
   *
   * @param uri - The file URI (file:// or scheme-stripped).
   * @param content - The file content as UTF-8 bytes.
   * @param signal - Optional AbortSignal for cancellation.
   * @returns Promise that resolves when the write completes, or rejects
   *  with a {@link WritableFileSystemError}.
   *
   * Throws WritableFileSystemError with code WRITE_FILE_SYSTEM_ERROR if the
   * underlying API fails. Throws WRITE_CANCELLED if the operation is
   * aborted before completion.
   */
  writeFile(uri: string, content: Uint8Array, signal?: AbortSignal): Promise<void>;

  /**
   * Rename a file from oldUri to newUri.
   *
   * @param oldUri - The current file URI.
   * @param newUri - The target file URI.
   * @param signal - Optional AbortSignal for cancellation.
   * @returns Promise that resolves when the rename completes, or rejects
   *  with a {@link WritableFileSystemError}.
   *
   * Throws WritableFileSystemError with code RENAME_NOT_FOUND if oldUri does
   * not exist. Throws RENAME_INVALID_DESTINATION if newUri is outside the
   * workspace or invalid. Throws RENAME_CANCELLED if the operation is aborted.
   */
  rename(oldUri: string, newUri: string, signal?: AbortSignal): Promise<void>;

  /**
   * Delete a file at the specified URI.
   *
   * @param uri - The file URI to delete.
   * @param signal - Optional AbortSignal for cancellation.
   * @returns Promise that resolves when the deletion completes, or rejects
   *  with a {@link WritableFileSystemError}.
   *
   * Throws WritableFileSystemError with code DELETE_NOT_FOUND if the file
   * does not exist. Throws DELETE_CANCELLED if the operation is aborted.
   */
  deleteFile(uri: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Validates that a target URI is within the workspace root.
 *
 * Normalizes both paths (strips `file://` scheme, resolves `.`/`..`,
 * converts backslashes) and checks lexical containment. Does not follow
 * symlinks; symlink validation must be performed separately by the adapter.
 *
 * @param workspaceRootUri - The workspace folder URI (e.g. `file:///workspace`).
 * @param targetUri - The target URI to validate.
 * @returns The relative path from workspace root to target, or undefined if outside.
 * @throws {WritableFileSystemError} With code `WRITE_INVALID_DESTINATION` if outside workspace.
 */
export function validateWorkspaceBoundary(workspaceRootUri: string, targetUri: string): string {
  const root = normalizePath(workspaceRootUri);
  const target = normalizePath(targetUri);
  const rel = relativePath(root, target);
  if (rel === undefined) {
    throw new WritableFileSystemError(
      'WRITE_INVALID_DESTINATION',
      `Path is outside the workspace root: ${targetUri}`
    );
  }
  return rel;
}

/**
 * Generates a collision-resistant temporary file URI in the same directory as
 * the target file.
 *
 * The temporary file name uses a UUID and preserves the target's basename for
 * readability: `.nexipi-tmp-<uuid>-<basename>`. This minimizes the risk of
 * accidental overwrite of unrelated files and keeps temporary files within the
 * intended destination directory.
 *
 * @param targetUri - The target file URI (file:// or scheme-stripped).
 * @returns A temporary file URI in the same directory.
 */
export function generateTempFileName(targetUri: string): string {
  const normalized = normalizePath(targetUri);
  const dir = normalized.slice(0, normalized.lastIndexOf('/'));
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const uuid = randomUUID();
  return `${dir}/.nexipi-tmp-${uuid}-${base}`;
}

/**
 * Classifies a raw filesystem error into a typed writable error code.
 *
 * This is a best-effort mapping; implementations should refine based on the
 * specific platform's error codes. The `context` parameter provides the
 * operation kind for more precise classification.
 */
export function classifyFilesystemError(
  error: unknown,
  context: 'write' | 'rename' | 'delete' | 'temp'
): WritableFileSystemErrorCode {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    const message = error.message.toLowerCase();

    // Cancellation
    if (error.name === 'AbortError' || code === 'ABORT_ERR') {
      switch (context) {
        case 'write':
          return 'WRITE_CANCELLED';
        case 'rename':
          return 'RENAME_CANCELLED';
        case 'delete':
          return 'DELETE_CANCELLED';
        case 'temp':
          return 'TEMP_FILE_CREATE_FAILED';
      }
    }

    // Not found / ENOENT
    if (code === 'ENOENT' || message.includes('enoent') || message.includes('not found')) {
      switch (context) {
        case 'write':
          return 'WRITE_FILE_NOT_FOUND'; // parent directory missing
        case 'rename':
          return 'RENAME_NOT_FOUND';
        case 'delete':
          return 'DELETE_NOT_FOUND';
        case 'temp':
          return 'TEMP_FILE_CREATE_FAILED';
      }
    }

    // Permission denied / EACCES / EPERM
    if (
      code === 'EACCES' ||
      code === 'EPERM' ||
      message.includes('permission') ||
      message.includes('access denied')
    ) {
      switch (context) {
        case 'write':
          return 'WRITE_PERMISSION_DENIED';
        case 'rename':
          return 'RENAME_PERMISSION_DENIED';
        case 'delete':
          return 'DELETE_PERMISSION_DENIED';
        case 'temp':
          return 'TEMP_FILE_CREATE_FAILED';
      }
    }

    // Invalid destination (outside workspace, is directory when file expected, etc.)
    if (
      code === 'EISDIR' ||
      code === 'ENOTDIR' ||
      message.includes('invalid') ||
      message.includes('not a file')
    ) {
      switch (context) {
        case 'write':
          return 'WRITE_INVALID_DESTINATION';
        case 'rename':
          return 'RENAME_INVALID_DESTINATION';
        case 'delete':
          return 'DELETE_INVALID_DESTINATION';
        case 'temp':
          return 'TEMP_FILE_CREATE_FAILED';
      }
    }

    // Symlink detected - platform-specific, but treat as invalid destination
    if (code === 'ELOOP' || message.includes('symlink') || message.includes('symbolic link')) {
      switch (context) {
        case 'write':
          return 'WRITE_SYMLINK_NOT_ALLOWED';
        case 'rename':
          return 'RENAME_SYMLINK_NOT_ALLOWED';
        case 'delete':
          return 'DELETE_INVALID_DESTINATION';
        case 'temp':
          return 'TEMP_FILE_CREATE_FAILED';
      }
    }
  }

  // Generic fallback
  switch (context) {
    case 'write':
      return 'WRITE_FILESYSTEM_ERROR';
    case 'rename':
      return 'RENAME_FILESYSTEM_ERROR';
    case 'delete':
      return 'DELETE_FILESYSTEM_ERROR';
    case 'temp':
      return 'TEMP_FILE_CREATE_FAILED';
  }
}
