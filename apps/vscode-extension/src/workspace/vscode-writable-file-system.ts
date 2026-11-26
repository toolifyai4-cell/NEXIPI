import * as vscode from 'vscode';
import type { FileStat, FileSystemProvider, WorkspaceFolder } from '@nexipi/workspace';
import {
  type WritableFileSystemProvider,
  WritableFileSystemError,
  type WritableFileSystemErrorCode,
  validateWorkspaceBoundary,
  generateTempFileName,
} from '@nexipi/workspace';

/**
 * Dependencies for the VS Code writable filesystem adapter.
 */
export interface VSCodeWritableFileSystemDependencies {
  readonly workspaceFolder: WorkspaceFolder;
  readonly fileSystem: FileSystemProvider;
}

type ErrorContext = 'write' | 'rename' | 'delete' | 'temp';

/**
 * VS Code implementation of the {@link WritableFileSystemProvider} abstraction.
 *
 * Uses `vscode.workspace.fs` for write/rename/delete operations and the
 * injected read-only {@link FileSystemProvider} for path validation
 * (symlink-free boundary checks). Enforces workspace isolation and
 * symlink protections consistent with the read-only tooling.
 *
 * NOTE: The write path uses a best-effort temp-file-plus-rename strategy.
 * It is NOT universally atomic: a process crash or a provider-specific rename
 * behavior may leave the temporary file behind, and remote/virtual providers
 * may not guarantee atomic rename.
 */
export class VSCodeWritableFileSystem implements WritableFileSystemProvider {
  private readonly rootUri: string;
  private readonly fileSystem: FileSystemProvider;

  constructor(deps: VSCodeWritableFileSystemDependencies) {
    this.rootUri = deps.workspaceFolder.uri;
    this.fileSystem = deps.fileSystem;
  }

  async writeFile(uri: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal, 'write');
    const destUri = this.normalize(uri);

    // Validate destination boundary and symlink-free parent.
    await this.validateTargetForWrite(destUri, signal, 'write');

    const tempUri = generateTempFileName(destUri);

    // Write bytes to temp file in the destination directory.
    try {
      await this.writeBytes(tempUri, content, signal);
    } catch (error) {
      throw this.toWritableError(error, 'write');
    }

    // Replace destination with temp file (overwrite enabled).
    try {
      await this.renameFile(tempUri, destUri, { overwrite: true }, signal);
    } catch (error) {
      // Best-effort cleanup; original rename error takes precedence.
      await this.cleanupTempFile(tempUri);
      throw this.toWritableError(error, 'rename');
    }
  }

  async rename(oldUri: string, newUri: string, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal, 'rename');
    const srcUri = this.normalize(oldUri);
    const dstUri = this.normalize(newUri);

    // Source must exist, be within workspace, be a file, and be symlink-free.
    await this.validateSourceExists(srcUri, signal, 'rename');

    // Destination must be within workspace, symlink-free, and (if present) a file.
    await this.validateTargetForWrite(dstUri, signal, 'rename');

    await this.renameFile(srcUri, dstUri, { overwrite: false }, signal);
  }

  async deleteFile(uri: string, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal, 'delete');
    const targetUri = this.normalize(uri);

    // Target must exist, be within workspace, be a file, and be symlink-free.
    await this.validateSourceExists(targetUri, signal, 'delete');

    try {
      await vscode.workspace.fs.delete(this.toVsCodeUri(targetUri));
    } catch (error) {
      throw this.toWritableError(error, 'delete');
    }
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private normalize(uri: string): string {
    return uri.replace(/^file:\/\//i, '').replace(/\\/g, '/');
  }

  private toVsCodeUri(uri: string): vscode.Uri {
    return vscode.Uri.parse('file://' + uri);
  }

  private relativePath(root: string, absolutePath: string): string | undefined {
    const r = root.replace(/\/+$/, '');
    const a = absolutePath.replace(/\/+$/, '');
    if (a === r) {
      return '';
    }
    if (a.startsWith(`${r}/`)) {
      return a.slice(r.length + 1);
    }
    return undefined;
  }

  private checkCancelled(signal?: AbortSignal, context: ErrorContext = 'write'): void {
    if (signal?.aborted) {
      const codes: Record<ErrorContext, WritableFileSystemErrorCode> = {
        write: 'WRITE_CANCELLED',
        rename: 'RENAME_CANCELLED',
        delete: 'DELETE_CANCELLED',
        temp: 'TEMP_FILE_CREATE_FAILED',
      };
      throw new WritableFileSystemError(codes[context], 'Operation cancelled');
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates that a target path is inside the workspace, its parent directory
   * chain is symlink-free, and (if the target exists) it is a file.
   */
  private async validateTargetForWrite(
    targetUri: string,
    signal: AbortSignal | undefined,
    context: ErrorContext
  ): Promise<void> {
    validateWorkspaceBoundary(this.rootUri, targetUri);
    this.checkCancelled(signal, context);

    const root = this.normalize(this.rootUri);
    const rel = this.relativePath(root, targetUri);
    if (rel === undefined) {
      throw new WritableFileSystemError(
        this.invalidDestinationCode(context),
        `Path is outside the workspace root: ${targetUri}`
      );
    }

    const components = rel.split('/').filter(c => c.length > 0);
    const parentComponents = components.slice(0, -1);
    let current = root;

    // Walk from root to the parent directory, ensuring each component exists,
    // is a directory, and is not a symbolic link.
    for (const component of parentComponents) {
      current = `${current}/${component}`;
      const stat = await this.lstat(current, signal, context);
      if (stat.type === 'symbolicLink') {
        throw new WritableFileSystemError(
          this.symlinkCode(context),
          `Path contains a symbolic link: ${current}`
        );
      }
      if (stat.type !== 'directory') {
        throw new WritableFileSystemError(
          this.notFoundCode(context),
          `Path component is not a directory: ${current}`
        );
      }
      this.checkCancelled(signal, context);
    }

    // If the target itself exists, it must be a file (not dir / symlink).
    let targetStat: FileStat | undefined;
    try {
      targetStat = await this.lstat(targetUri, signal, context);
    } catch (error) {
      if (
        error instanceof WritableFileSystemError &&
        (error.code === this.notFoundCode(context) || error.code === 'WRITE_FILESYSTEM_ERROR')
      ) {
        // Target missing is expected for a new file.
        return;
      }
      throw error;
    }

    if (targetStat.type === 'symbolicLink') {
      throw new WritableFileSystemError(
        this.symlinkCode(context),
        `Target is a symbolic link: ${targetUri}`
      );
    }
    if (targetStat.type !== 'file') {
      throw new WritableFileSystemError(
        this.invalidDestinationCode(context),
        `Target exists and is not a file: ${targetUri}`
      );
    }
  }

  /**
   * Validates that a source path exists, is inside the workspace, is a file,
   * and is symlink-free across all its components.
   */
  private async validateSourceExists(
    sourceUri: string,
    signal: AbortSignal | undefined,
    context: ErrorContext
  ): Promise<void> {
    validateWorkspaceBoundary(this.rootUri, sourceUri);
    this.checkCancelled(signal, context);

    const root = this.normalize(this.rootUri);
    const rel = this.relativePath(root, sourceUri);
    if (rel === undefined) {
      throw new WritableFileSystemError(
        this.invalidDestinationCode(context),
        `Path is outside the workspace root: ${sourceUri}`
      );
    }

    const components = rel.split('/').filter(c => c.length > 0);
    let current = root;
    for (const component of components) {
      current = `${current}/${component}`;
      const stat = await this.lstat(current, signal, context);
      if (stat.type === 'symbolicLink') {
        throw new WritableFileSystemError(
          this.symlinkCode(context),
          `Path contains a symbolic link: ${current}`
        );
      }
      this.checkCancelled(signal, context);
    }

    // Final component must be a file.
    const finalStat = await this.lstat(sourceUri, signal, context);
    if (finalStat.type !== 'file') {
      throw new WritableFileSystemError(
        this.notFoundCode(context),
        `Path is not a file: ${sourceUri}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Low-level operations
  // ---------------------------------------------------------------------------

  private async lstat(
    uri: string,
    signal: AbortSignal | undefined,
    context: ErrorContext
  ): Promise<FileStat> {
    this.checkCancelled(signal);
    try {
      return await this.fileSystem.lstat(uri);
    } catch (error) {
      throw this.toWritableError(error, context);
    }
  }

  private async writeBytes(uri: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal);
    await vscode.workspace.fs.writeFile(this.toVsCodeUri(uri), content);
  }

  private async renameFile(
    oldUri: string,
    newUri: string,
    options: { overwrite: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    this.checkCancelled(signal, 'rename');
    try {
      await vscode.workspace.fs.rename(this.toVsCodeUri(oldUri), this.toVsCodeUri(newUri), options);
    } catch (error) {
      if (!options.overwrite && this.isFileExistsError(error)) {
        throw new WritableFileSystemError(
          'RENAME_OVERWRITE_DISALLOWED',
          `Destination already exists: ${newUri}`
        );
      }
      throw this.toWritableError(error, 'rename');
    }
  }

  /**
   * Attempts to delete a temporary file. Any failure is swallowed so the
   * original failure that triggered cleanup is preserved and rethrown.
   */
  private async cleanupTempFile(tempUri: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.toVsCodeUri(tempUri));
    } catch {
      // Intentionally ignore cleanup failures.
    }
  }

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  private toWritableError(error: unknown, context: ErrorContext): WritableFileSystemError {
    if (error instanceof WritableFileSystemError) {
      return error;
    }
    const code = this.classifyError(error, context);
    const message = error instanceof Error ? error.message : String(error);
    return new WritableFileSystemError(code, message);
  }

  private classifyError(error: unknown, context: ErrorContext): WritableFileSystemErrorCode {
    if (error instanceof Error) {
      const code = (error as Error & { code?: string }).code;
      const message = error.message.toLowerCase();

      if (error.name === 'AbortError' || code === 'ABORT_ERR') {
        if (context === 'write') return 'WRITE_CANCELLED';
        if (context === 'rename') return 'RENAME_CANCELLED';
        if (context === 'delete') return 'DELETE_CANCELLED';
        return 'TEMP_FILE_CREATE_FAILED';
      }

      if (code === 'ENOENT' || message.includes('enoent') || message.includes('not found')) {
        return this.notFoundCode(context);
      }

      if (
        code === 'EACCES' ||
        code === 'EPERM' ||
        message.includes('permission') ||
        message.includes('access denied')
      ) {
        if (context === 'write') return 'WRITE_PERMISSION_DENIED';
        if (context === 'rename') return 'RENAME_PERMISSION_DENIED';
        if (context === 'delete') return 'DELETE_PERMISSION_DENIED';
        return 'TEMP_FILE_CREATE_FAILED';
      }

      if (
        code === 'EISDIR' ||
        code === 'ENOTDIR' ||
        message.includes('invalid') ||
        message.includes('not a file')
      ) {
        return this.invalidDestinationCode(context);
      }

      if (code === 'ELOOP' || message.includes('symlink') || message.includes('symbolic link')) {
        return this.symlinkCode(context);
      }
    }

    if (context === 'write') return 'WRITE_FILESYSTEM_ERROR';
    if (context === 'rename') return 'RENAME_FILESYSTEM_ERROR';
    if (context === 'delete') return 'DELETE_FILESYSTEM_ERROR';
    return 'TEMP_FILE_CREATE_FAILED';
  }

  private notFoundCode(context: ErrorContext): WritableFileSystemErrorCode {
    if (context === 'write') return 'WRITE_FILE_NOT_FOUND';
    if (context === 'rename') return 'RENAME_NOT_FOUND';
    if (context === 'delete') return 'DELETE_NOT_FOUND';
    return 'TEMP_FILE_CREATE_FAILED';
  }

  private invalidDestinationCode(context: ErrorContext): WritableFileSystemErrorCode {
    if (context === 'write') return 'WRITE_INVALID_DESTINATION';
    if (context === 'rename') return 'RENAME_INVALID_DESTINATION';
    if (context === 'delete') return 'DELETE_INVALID_DESTINATION';
    return 'TEMP_FILE_CREATE_FAILED';
  }

  private symlinkCode(context: ErrorContext): WritableFileSystemErrorCode {
    if (context === 'write') return 'WRITE_SYMLINK_NOT_ALLOWED';
    if (context === 'rename') return 'RENAME_SYMLINK_NOT_ALLOWED';
    if (context === 'delete') return 'DELETE_INVALID_DESTINATION';
    return 'TEMP_FILE_CREATE_FAILED';
  }

  private isFileExistsError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const code = (error as Error & { code?: string }).code;
      return (
        code === 'EEXIST' || message.includes('already exists') || message.includes('fileexists')
      );
    }
    return false;
  }
}
