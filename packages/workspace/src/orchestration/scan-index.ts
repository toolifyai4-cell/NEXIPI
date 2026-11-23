import type {
  WorkspaceFolderId,
  FileMetadata,
} from '../types.js';
import { normalizeAbsolutePath } from './scan-types.js';

/**
 * In-memory scan result index.
 *
 * Provides lookup by file ID and normalized absolute path, listing by
 * workspace folder and by project, plus mutation operations used by the
 * orchestrator and incremental refresh. No persistence is performed.
 */
export class ScanIndex {
  private readonly filesById = new Map<string, FileMetadata>();
  private readonly filesByPath = new Map<string, FileMetadata>();
  private readonly filesByFolder = new Map<WorkspaceFolderId, Set<string>>();
  private readonly filesByProject = new Map<string, Set<string>>();

  private complete = false;
  private workspaceId: string | null = null;
  private lastSuccessfulScanTimestamp: number | null = null;

  /**
   * Look up a file by its metadata id.
   */
  getById(fileId: string): FileMetadata | undefined {
    return this.filesById.get(fileId);
  }

  /**
   * Look up a file by its normalized absolute path.
   */
  getByPath(absolutePath: string): FileMetadata | undefined {
    return this.filesByPath.get(normalizeAbsolutePath(absolutePath));
  }

  /**
   * List all files belonging to a workspace folder.
   */
  listByFolder(folderId: WorkspaceFolderId): FileMetadata[] {
    const ids = this.filesByFolder.get(folderId);
    if (!ids) {
      return [];
    }
    const result: FileMetadata[] = [];
    for (const id of ids) {
      const file = this.filesById.get(id);
      if (file) {
        result.push(file);
      }
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * List all files belonging to a project.
   */
  listByProject(projectId: string): FileMetadata[] {
    const ids = this.filesByProject.get(projectId);
    if (!ids) {
      return [];
    }
    const result: FileMetadata[] = [];
    for (const id of ids) {
      const file = this.filesById.get(id);
      if (file) {
        result.push(file);
      }
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * Return all indexed files in deterministic order.
   */
  getAllFiles(): FileMetadata[] {
    return Array.from(this.filesById.values()).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );
  }

  /**
   * Total number of indexed files.
   */
  getFileCount(): number {
    return this.filesById.size;
  }

  /**
   * Workspace id associated with the current index contents.
   */
  getWorkspaceId(): string | null {
    return this.workspaceId;
  }

  /**
   * Whether the index represents a complete successful scan.
   */
  isComplete(): boolean {
    return this.complete;
  }

  /**
   * Timestamp of the last successful complete scan, if any.
   */
  getLastSuccessfulScanTimestamp(): number | null {
    return this.lastSuccessfulScanTimestamp;
  }

  /**
   * Add or update a file's metadata in the index.
   * Returns true if the file was added or updated, false if unchanged.
   */
  upsertMetadata(file: FileMetadata): boolean {
    const existing = this.filesById.get(file.id);
    const normalizedPath = normalizeAbsolutePath(file.absolutePath);

    if (existing) {
      const existingPath = normalizeAbsolutePath(existing.absolutePath);
      let changed = false;
      const updated: FileMetadata = { ...existing, ...file };
      if (updated.absolutePath !== existing.absolutePath) changed = true;
      if (updated.relativePath !== existing.relativePath) changed = true;
      if (updated.workspaceFolderId !== existing.workspaceFolderId) changed = true;
      if (updated.projectId !== existing.projectId) changed = true;
      if (updated.name !== existing.name) changed = true;
      if (updated.extension !== existing.extension) changed = true;
      if (updated.size !== existing.size) changed = true;
      if (updated.mtime !== existing.mtime) changed = true;
      if (updated.language !== existing.language) changed = true;
      if (updated.category !== existing.category) changed = true;
      if (updated.isHidden !== existing.isHidden) changed = true;
      if (updated.isManifest !== existing.isManifest) changed = true;
      if (updated.isConfig !== existing.isConfig) changed = true;
      if (updated.isBinary !== existing.isBinary) changed = true;
      if (updated.isSensitive !== existing.isSensitive) changed = true;
      if (updated.sourceExcluded !== existing.sourceExcluded) changed = true;
      if (!changed) {
        return false;
      }

      // If the path changed, re-index under the new path.
      if (existingPath !== normalizedPath) {
        this.filesByPath.delete(existingPath);
        this.filesByPath.set(normalizedPath, updated);
      } else {
        this.filesByPath.set(normalizedPath, updated);
      }
      this.filesById.set(file.id, updated);
      this.addToFolderIndex(updated);
      this.addToProjectIndex(updated);
      return true;
    }

    this.filesById.set(file.id, file);
    this.filesByPath.set(normalizedPath, file);
    this.addToFolderIndex(file);
    this.addToProjectIndex(file);
    return true;
  }

  /**
   * Remove a file by id.
   */
  removeFile(fileId: string): boolean {
    const existing = this.filesById.get(fileId);
    if (!existing) {
      return false;
    }
    this.filesById.delete(fileId);
    this.filesByPath.delete(normalizeAbsolutePath(existing.absolutePath));
    this.removeFromFolderIndex(existing);
    this.removeFromProjectIndex(existing);
    return true;
  }

  /**
   * Remove all files belonging to a workspace folder.
   */
  removeFolder(folderId: WorkspaceFolderId): number {
    const ids = this.filesByFolder.get(folderId);
    if (!ids) {
      return 0;
    }
    let removed = 0;
    for (const id of ids) {
      if (this.removeFile(id)) {
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Replace the entire index with the results of a successful full scan.
   * Any previous complete index is discarded and replaced atomically.
   */
  replaceResults(files: readonly FileMetadata[], workspaceId: string): void {
    this.filesById.clear();
    this.filesByPath.clear();
    this.filesByFolder.clear();
    this.filesByProject.clear();

    for (const file of files) {
      const normalizedPath = normalizeAbsolutePath(file.absolutePath);
      this.filesById.set(file.id, file);
      this.filesByPath.set(normalizedPath, file);
      this.addToFolderIndex(file);
      this.addToProjectIndex(file);
    }

    this.workspaceId = workspaceId;
    this.complete = true;
    this.lastSuccessfulScanTimestamp = Date.now();
  }

  /**
   * Mark the index as partial (e.g. after a failed or cancelled scan).
   * A partial index is not considered a successful complete scan.
   */
  markPartial(workspaceId: string): void {
    this.workspaceId = workspaceId;
    this.complete = false;
  }

  /**
   * Clear the index without recording a successful scan timestamp.
   */
  clear(): void {
    this.filesById.clear();
    this.filesByPath.clear();
    this.filesByFolder.clear();
    this.filesByProject.clear();
    this.workspaceId = null;
    this.complete = false;
    this.lastSuccessfulScanTimestamp = null;
  }

  private addToFolderIndex(file: FileMetadata): void {
    let ids = this.filesByFolder.get(file.workspaceFolderId);
    if (!ids) {
      ids = new Set();
      this.filesByFolder.set(file.workspaceFolderId, ids);
    }
    ids.add(file.id);
  }

  private removeFromFolderIndex(file: FileMetadata): void {
    const ids = this.filesByFolder.get(file.workspaceFolderId);
    if (ids) {
      ids.delete(file.id);
      if (ids.size === 0) {
        this.filesByFolder.delete(file.workspaceFolderId);
      }
    }
  }

  private addToProjectIndex(file: FileMetadata): void {
    if (!file.projectId) {
      return;
    }
    let ids = this.filesByProject.get(file.projectId);
    if (!ids) {
      ids = new Set();
      this.filesByProject.set(file.projectId, ids);
    }
    ids.add(file.id);
  }

  private removeFromProjectIndex(file: FileMetadata): void {
    if (!file.projectId) {
      return;
    }
    const ids = this.filesByProject.get(file.projectId);
    if (ids) {
      ids.delete(file.id);
      if (ids.size === 0) {
        this.filesByProject.delete(file.projectId);
      }
    }
  }
}

export function createScanIndex(): ScanIndex {
  return new ScanIndex();
}
