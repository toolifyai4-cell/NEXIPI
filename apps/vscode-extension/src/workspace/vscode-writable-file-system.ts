import * as vscode from 'vscode';
import * as path from 'path';
import type {
  DirectoryEntry,
  FileStat,
  FileSystemProvider,
  WorkspaceFolder,
} from '@nexipi/workspace';
import {
  WritableFileSystemProvider,
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

/**
 * VS Code implementation of the {@link WritableFileSystemProvider} abstraction.
 *
 * Uses `vscode.workspace.fs` for write/rename/delete operations and the
 * injected read-only {@link FileSystemProvider} for path validation
 * (symlink-free boundary checks). Enforces workspace isolation and
 * symlink protections consistent with the read-only tooling.
 */
export class VSCodeWritableFileSystem implements WritableFileSystemProvider {
  private readonly rootUri: string;
  private readonly fileSystem: FileSystemProvider;

  constructor(deps: VSCodeWritableFileSystemDependencies) {
    this.rootUri = deps.workspaceFolder.uri;
    this.fileSystem = deps.fileSystem;
  }

  async writeFile(uri: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal);
    const normalizedUri = this.toNormalizedUri(uri);
    await this.validateTargetForWrite(normalizedUri, signal);

    const tempUri = generateTempFileName(normalizedUri);

    try {
      await this.writeBytes(tempUri, content, signal);
    } catch (error) {
      // Temp file creation/write failed; no temp file to clean up
      throw this.toWritableError(error, 'write');
    }

    try {
      await this.renameFile(tempUri, normalizedUri, { overwrite: true }, signal);
    } catch (error) {
      // Rename failed: attempt cleanup of temp file, preserving original error
      await this.cleanupTempFile(tempUri);
      throw this.toWritableError(error, 'rename');
    }
  }

  async rename(oldUri: string, newUri: string, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal);
    const normalizedOld = this.toNormalizedUri(oldUri);
    const normalizedNew = this.toNormalizedUri(newUri);

    // Source must exist and be a file
    await this.validateSourceExists(normalizedOld, signal);
    // Destination must be within workspace, not a directory/symlink
    await this.validateTargetForWrite(normalizedNew, signal);

    await this.renameFile(normalizedOld, normalizedNew, { overwrite: false }, signal);
  }

  async deleteFile(uri: string, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal);
    const normalizedUri = this.toNormalizedUri(uri);

    // Must exist and be a file (not directory/symlink)
    await this.validateSourceExists(normalizedUri, signal);

    try {
      await vscode.workspace.fs.delete(this.toVsCodeUri(normalizedUri));
    } catch (error) {
      throw this.toWritableError(error, 'delete');
    }
  }

  /**
   * Converts a URI to a normalized scheme-stripped path for internal use.
   * Accepts full `file://` URIs or scheme-stripped paths.
   */
  private toNormalizedUri(uri: string): string {
    return uri.replace(/^file:\/\//i, '').replace(/\\/g, '/');
  }

  /**
   * Converts a normalized URI to a VS Code URI for API calls.
   */
  private toVsCodeUri(uri: string): vscode.Uri {
    return vscode.Uri.parse('file://' + uri);
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new WritableFileSystemError('WRITE_CANCELLED', 'Operation cancelled');
    }
  }

  /**
   * Validates that a target path is within the workspace, has a symlink-free
   * parent directory, and (if it exists) is a file not a directory or symlink.
   * For new files, the parent must exist and be a directory.
   */
  private async validateTargetForWrite(targetUri: string, signal?: AbortSignal): Promise<void> {
    // Boundary check
    validateWorkspaceBoundary(this.rootUri, targetUri);
    this.checkCancelled(signal);

    // Walk components from root to parent of target, ensuring no symlinks
    // and that each component exists and is a directory.
    const rootNormalized = this.toNormalizedUri(this.rootUri);
    const rel = this.relativePath(rootNormalized, targetUri);
    if (rel === undefined) {
      // Should not happen due to validateWorkspaceBoundary, but defense in depth
      throw new WritableFileSystemError('WRITE_INVALID_DESTINATION', `Path outside workspace: ${targetUri}`);
    }

    const components = rel.split('/');
    let current = rootNormalized;

    // Validate all components up to the parent directory
    const parentComponents = components.slice(0, -1);
    for (const component of parentComponents) {
      current = `${current}/${component}`;
      const stat = await this.lstatWithSignal(current, signal);
      if (stat.type === 'symbolicLink') {
        throw new WritableFileSystemError('WRITE_SYMLINK_NOT_ALLOWED', `Path contains a symbolic link: ${current}`);
      }
      if (stat.type !== 'directory') {
        throw new WritableFileSystemError('WRITE_FILE_NOT_FOUND', `Parent is not a directory: ${current}`);
      }
      this.checkCancelled(signal);
    }

    // If the target itself exists, it must be a file (not directory/symlink)
    try {
      const stat = await this.lstatWithSignal(targetUri, signal);
      if (stat.type !== 'file') {
        throw new WritableFileSystemError('WRITE_INVALID_DESTINATION', `Target exists and is not a file: ${targetUri}`);
      }
    } catch (error) {
      // If target does not exist (ENOENT), that's fine for a new file
      if (error instanceof WritableFileSystemError) {
        if (error.code === 'WRITE_FILE_NOT_FOUND' || error.code === 'WRITE_FILESYSTEM_ERROR') {
          return; // target missing is expected for new file
        }
      }
      // Other errors (cancelled, permission, etc.) propagate
      throw error;
    }
  }

  /**
   * Validates that a source file exists, is within workspace, and is a file.
   */
  private async validateSourceExists(sourceUri: string, signal?: AbortSignal): Promise<void> {
    validateWorkspaceBoundary(this.rootUri, sourceUri);
    this.checkCancelled(signal);

    const rootNormalized = this.toNormalizedUri(this.rootUri);
    const rel = this.relativePath(rootNormalized, sourceUri);
    if (rel === undefined) {
      throw new WritableFileSystemError('RENAME_INVALID_DESTINATION', `Path outside workspace: ${sourceUri}`);
    }

    const components = rel.split('/');
    let current = rootNormalized;
    for (const component of components) {
      current = `${current}/${component}`;
      const stat = await this.lstatWithSignal(current, signal);
      if (stat.type === 'symbolicLink') {
        throw new WritableFileSystemError('RENAME_SYMLINK_NOT_ALLOWED', `Path contains a symbolic link: ${current}`);
      }
      this.checkCancelled(signal);
    }

    // Final component must be a file
    const finalStat = await this.lstatWithSignal(sourceUri, signal);
    if (finalStat.type !== 'file') {
      throw new WritableFileSystemError('RENAME_NOT_FOUND', `Source is not a file: ${sourceUri}`);
    }
  }

  /**
   * Performs lstat with cancellation check, mapping errors to WritableFileSystemError.
   */
  private async lstatWithSignal(uri: string, signal?: AbortSignal): Promise<FileStat> {
    this.checkCancelled(signal);
    try {
      return await this.fileSystem.lstat(uri);
    } catch (error) {
      throw this.toWritableError(error, 'write'); // 'write' context maps ENOENT -> WRITE_FILE_NOT_FOUND
    }
  }

  /**
   * Writes bytes to a file using vscode.workspace.fs.writeFile.
   */
  private async writeBytes(uri: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.checkCancelled(signal);
    try {
      await vscode.workspace.fs.writeFile(this.toVsCodeUri(uri), content);
    } catch (error) {
      throw this.toWritableError(error, 'write');
    }
  }

  /**
   * Renames a file using vscode.workspace.fs.rename.
   * overwrite=true replaces destination; overwrite=false fails if destination exists.
   */
  private async renameFile(
    oldUri: string,
    newUri: string,
    options: { overwrite: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    this.checkCancelled(signal);
    try {
      await vscode.workspace.fs.rename(
        this.toVsCodeUri(oldUri),
        this.toVsCodeUri(newUri),
        options
      );
    } catch (error) {
      // VS Code's rename may throw if destination exists and overwrite=false
      if (!options.overwrite && this.isFileExistsError(error)) {
        throw new WritableFileSystemError('RENAME_OVERWRITE_DISALLOWED', `Destination already exists: ${newUri}`);
      }
      throw this.toWritableError(error, 'rename');
    }
  }

  /**
   * Attempts to delete a temporary file, suppressing errors to preserve original failure.
   */
  private async cleanupTempFile(tempUri: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.toVsCodeUri(tempUri));
    } catch {
      // Intentionally ignore cleanup failures; original error takes precedence
    }
  }

  /**
   * Converts a raw error to a typed WritableFileSystemError with appropriate code.
   */
  private toWritableError(error: unknown, context: 'write' | 'rename' | 'delete' | 'temp'): WritableFileSystemError {
    if (error instanceof WritableFileSystemError) {
      return error;
    }
    const code = this.classifyError(error, context);
    const message = error instanceof Error ? error.message : String(error);
    return new WritableFileSystemError(code, message);
  }

  /**
   * Best-effort classification of raw VS Code filesystem errors.
   */
  private classifyError(error: unknown, context: 'write' | 'rename' | 'delete' | 'temp'): WritableFileSystemErrorCode {
    if (error instanceof Error) {
      const code = (error as Error & { code?: string }).code;
      const message = error.message.toLowerCase();

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

      if (code === 'ENOENT' || message.includes('enoent') || message.includes('not found')) {
        switch (context) {
          case 'write':
            return 'WRITE_FILE_NOT_FOUND';
          case 'rename':
            return 'RENAME_NOT_FOUND';
          case 'delete':
            return 'DELETE_NOT_FOUND';
          case 'temp':
            return 'TEMP_FILE_CREATE_FAILED';
        }
      }

      if (code === 'EACCES' || code === 'EPERM' || message.includes('permission') || message.includes('access denied')) {
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

      if (code === 'EISDIR' || code === 'ENOTDIR' || message.includes('invalid') || message.includes('not a file')) {
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

      // VS Code-specific: "FileSystemError" with code "FileExists"
      if (message.includes('fileexists') || message.includes('already exists')) {
        if (context === 'rename') return 'RENAME_OVERWRITE_DISALLOWED';
      }
    }

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

  private isFileExistsError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const code = (error as Error & { code?: string }).code;
      return code === 'EEXIST' || message.includes('already exists') || message.includes('fileexists');
    }
    return false;
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
}