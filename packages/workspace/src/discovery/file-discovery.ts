import type { DirectoryEntry, FileStat, FileSystemProvider } from '../discovery/workspace-provider.js';
import type {
  DiscoveryError,
  FileMetadata,
  WorkspaceFolder,
  WorkspaceFolderId,
} from '../types.js';
import { IgnoreEngine } from '../ignore/ignore-engine.js';
import { FileMetadataCollector } from './file-metadata.js';
import { defaultFileDiscoveryConfig, type FileDiscoveryConfig } from '../config.js';

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isChildOf(parent: string, child: string): boolean {
  const p = normalizeRoot(parent);
  const c = normalizeRoot(child);
  return c === p || c.startsWith(`${p}/`);
}

export interface FileDiscoveryOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  projectId?: string;
  config?: Partial<FileDiscoveryConfig>;
  signal?: AbortSignal;
}

export interface FileDiscoveryServiceResult {
  readonly workspaceId: string;
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly files: readonly FileMetadata[];
  readonly count: number;
  readonly truncated: boolean;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly errors: readonly DiscoveryError[];
}

export class FileDiscoveryService {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly projectId: string | undefined;
  private readonly config: FileDiscoveryConfig;
  private readonly signal: AbortSignal | undefined;
  private readonly workspaceId: string;

  constructor(options: FileDiscoveryOptions) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    this.projectId = options.projectId;
    this.config = { ...defaultFileDiscoveryConfig, ...options.config };
    this.signal = options.signal;
    // Stable workspace id derived from the folder uri.
    this.workspaceId = this.computeWorkspaceId(options.workspaceFolder.uri);
  }

  async discover(): Promise<FileDiscoveryServiceResult> {
    const root = normalizeRoot(this.workspaceFolder.uri.replace(/^file:\/\//, ''));
    const ignoreEngine = new IgnoreEngine({
      fileSystem: this.fileSystem,
      workspaceFolder: this.workspaceFolder,
      root,
      config: {
        enableMandatorySafetyExclusions: this.config.enableMandatorySafetyExclusions,
        enableDefaultExclusions: this.config.enableDefaultExclusions,
        userExclusions: this.config.userExclusions,
        caseSensitive: false,
      },
    });

    const collected: FileMetadata[] = [];
    const errors: DiscoveryError[] = [];
    const seen = new Set<string>();
    let truncated = false;
    let cancelled = false;
    let completed = false;

    try {
      await this.traverseDirectory(
        root,
        '',
        0,
        ignoreEngine,
        collected,
        errors,
        seen,
        {
          get truncated() { return truncated; },
          set truncated(v: boolean) { truncated = v; },
          get cancelled() { return cancelled; },
          set cancelled(v: boolean) { cancelled = v; },
        }
      );
      completed = true;
    } catch (error) {
      if (this.isAbortError(error)) {
        cancelled = true;
        completed = false;
      } else {
        errors.push({
          path: root,
          message: error instanceof Error ? error.message : String(error),
          isFatal: true,
        });
        completed = false;
      }
    }

    return {
      workspaceId: this.workspaceId,
      workspaceFolderId: this.workspaceFolder.id,
      files: collected,
      count: collected.length,
      truncated,
      completed,
      cancelled,
      errors,
    };
  }

  private async traverseDirectory(
    absDir: string,
    relDir: string,
    depth: number,
    ignoreEngine: IgnoreEngine,
    collected: FileMetadata[],
    errors: DiscoveryError[],
    seen: Set<string>,
    state: { truncated: boolean; cancelled: boolean }
  ): Promise<void> {
    if (state.cancelled) {
      return;
    }
    this.checkAbort();

    if (depth > this.config.maxDepth) {
      return;
    }

    // Boundary protection: never traverse outside the workspace root.
    if (!isChildOf(normalizeRoot(this.workspaceFolder.uri.replace(/^file:\/\//, '')), absDir)) {
      errors.push({
        path: absDir,
        message: 'Path escapes workspace root boundary',
        isFatal: false,
      });
      return;
    }

    // Avoid re-traversing already-visited directories (duplicate-path prevention).
    const absKey = absDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (seen.has(absKey)) {
      return;
    }
    seen.add(absKey);

    // Load nested .gitignore for this directory.
    try {
      await ignoreEngine.loadGitignore(absDir);
    } catch {
      // Unreadable gitignore must not abort the scan.
    }

    // If this directory is excluded by ignore rules, do not descend into it.
    if (relDir.length > 0) {
      const dirResult = ignoreEngine.isExcluded(relDir, { isDirectory: true });
      if (dirResult.ignored) {
        ignoreEngine.markDirectoryExcluded(absDir);
        return;
      }
    }

    let entries: readonly DirectoryEntry[];
    try {
      entries = await this.fileSystem.readDirectory(absDir);
    } catch (error) {
      errors.push({
        path: absDir,
        message: error instanceof Error ? error.message : String(error),
        isFatal: false,
      });
      return;
    }

    // Deterministic ordering.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (state.cancelled) {
        return;
      }
      this.checkAbort();

      if (collected.length >= this.config.maxFileCount) {
        state.truncated = true;
        return;
      }

      const absPath = `${absDir}/${entry.name}`;
      const relPath = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;

      if (entry.type === 'symbolicLink') {
        if (!this.config.followSymlinks) {
          // Skip symlinks by default to avoid escaping the root.
          continue;
        }
        // When following symlinks, stat the target.
        try {
          const targetStat = await this.fileSystem.stat(absPath);
          if (targetStat.type === 'directory') {
            await this.traverseDirectory(
              absPath,
              relPath,
              depth + 1,
              ignoreEngine,
              collected,
              errors,
              seen,
              state
            );
          } else if (targetStat.type === 'file') {
            this.collectFile(absPath, relPath, targetStat, ignoreEngine, collected, seen, state);
          }
        } catch (error) {
          errors.push({
            path: absPath,
            message: error instanceof Error ? error.message : String(error),
            isFatal: false,
          });
        }
        continue;
      }

      if (entry.type === 'directory') {
        await this.traverseDirectory(
          absPath,
          relPath,
          depth + 1,
          ignoreEngine,
          collected,
          errors,
          seen,
          state
        );
        continue;
      }

      if (entry.type === 'file') {
        try {
          const stat = await this.fileSystem.stat(absPath);
          this.collectFile(absPath, relPath, stat, ignoreEngine, collected, seen, state);
        } catch (error) {
          errors.push({
            path: absPath,
            message: error instanceof Error ? error.message : String(error),
            isFatal: false,
          });
        }
      }
    }
  }

  private collectFile(
    absPath: string,
    relPath: string,
    stat: FileStat,
    ignoreEngine: IgnoreEngine,
    collected: FileMetadata[],
    seen: Set<string>,
    state: { truncated: boolean; cancelled: boolean }
  ): void {
    if (state.cancelled) {
      return;
    }
    this.checkAbort();

    const fileResult = ignoreEngine.isExcluded(relPath, { isDirectory: false });
    if (fileResult.ignored) {
      return;
    }

    // Duplicate-path prevention by absolute path.
    const absKey = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (seen.has(absKey)) {
      return;
    }
    seen.add(absKey);

    const collector = new FileMetadataCollector({
      workspaceId: this.workspaceId,
      workspaceFolder: this.workspaceFolder,
      ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
    });
    collected.push(collector.collect(absPath, relPath, stat));
  }

  private checkAbort(): void {
    if (this.signal?.aborted) {
      const err = new Error('Operation aborted') as Error & { code?: string };
      err.name = 'AbortError';
      throw err;
    }
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
    }
    return false;
  }

  private computeWorkspaceId(uri: string): string {
    const normalized = uri.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `ws_${Math.abs(hash).toString(36)}`;
  }
}

export function createFileDiscoveryService(options: FileDiscoveryOptions): FileDiscoveryService {
  return new FileDiscoveryService(options);
}
