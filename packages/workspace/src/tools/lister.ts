import type {
  DirectoryEntry,
  FileStat,
  FileSystemProvider,
} from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
import { FileMetadataCollector } from '../discovery/file-metadata.js';
import { IgnoreEngine } from '../ignore/ignore-engine.js';
import {
  matchesIncludePatterns,
  isSensitiveFileName,
  splitNameExtension,
  normalizePath,
  isChildOf,
  relativePath,
} from './classification.js';
import { defaultDirectoryListConfig, type DirectoryListConfig } from './config.js';
import type {
  ListDirectoryOptions,
  ListDirectoryResult,
  DirectoryListingEntry,
} from './contracts.js';
import { safeValidateListDirectoryInput } from './schemas.js';
import { ToolErrorCode, createToolError } from './errors.js';

function checkCancelled(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Listing cancelled', { path });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

interface TraverseState {
  truncated: boolean;
  cancelled: boolean;
}

export class DirectoryLister {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: DirectoryListConfig;
  private readonly workspaceId: string;
  private readonly collector: FileMetadataCollector;

  constructor(options: {
    fileSystem: FileSystemProvider;
    workspaceFolder: WorkspaceFolder;
    config?: Partial<DirectoryListConfig>;
  }) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    this.config = { ...defaultDirectoryListConfig, ...options.config };
    const normalized = this.workspaceFolder.uri
      .replace(/^file:\/\//, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    this.workspaceId = `ws_${Math.abs(hash).toString(36)}`;
    this.collector = new FileMetadataCollector({
      workspaceId: this.workspaceId,
      workspaceFolder: this.workspaceFolder,
    });
  }

  getConfig(): Readonly<DirectoryListConfig> {
    return { ...this.config };
  }

  async listDirectory(options: ListDirectoryOptions): Promise<ListDirectoryResult> {
    const input = safeValidateListDirectoryInput(options);
    if (!input.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid list arguments: ${input.error.issues.map(i => i.message).join(', ')}`,
        { path: options.uri }
      );
    }

    const recursive = options.recursive ?? false;
    const maxDepth = options.maxDepth ?? this.config.maxDepth;
    const maxEntries = options.maxEntries ?? this.config.maxEntries;
    const filterByType = options.filterByType ?? 'all';
    const includePatterns = options.includePatterns ?? [];

    // Non-recursive listing never descends below the target directory.
    const effectiveMaxDepth = recursive ? maxDepth : 0;

    checkCancelled(options.signal, options.uri);

    const absPath = normalizePath(options.uri);
    const root = normalizePath(this.workspaceFolder.uri);

    if (!isChildOf(root, absPath)) {
      throw createToolError(
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE,
        'Path is outside the workspace root',
        { path: options.uri }
      );
    }

    checkCancelled(options.signal, options.uri);

    let stat: FileStat;
    try {
      stat = await this.fileSystem.stat(absPath);
    } catch (error) {
      if (isAbortError(error)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Listing cancelled', {
          path: options.uri,
        });
      }
      throw createToolError(
        ToolErrorCode.TOOL_FILE_NOT_FOUND,
        `Directory not found: ${error instanceof Error ? error.message : String(error)}`,
        { path: options.uri, cause: error instanceof Error ? error : undefined }
      );
    }

    if (stat.type === 'symbolicLink') {
      throw createToolError(
        ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED,
        'Symbolic links are not allowed for listing',
        { path: options.uri }
      );
    }
    if (stat.type !== 'directory') {
      throw createToolError(ToolErrorCode.TOOL_NOT_A_DIRECTORY, 'Path is not a directory', {
        path: options.uri,
      });
    }

    checkCancelled(options.signal, options.uri);

    const rel = relativePath(root, absPath);
    if (rel === undefined) {
      throw createToolError(
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE,
        'Path escapes workspace root boundary',
        { path: options.uri }
      );
    }

    const ignoreEngine = new IgnoreEngine({
      fileSystem: this.fileSystem,
      workspaceFolder: this.workspaceFolder,
      root,
      config: {
        enableMandatorySafetyExclusions: true,
        enableDefaultExclusions: true,
        userExclusions: [],
        caseSensitive: false,
      },
    });
    try {
      await ignoreEngine.loadGitignore(root);
    } catch {
      // Unreadable gitignore must not block the listing.
    }

    const entries: DirectoryListingEntry[] = [];
    const errors: Array<{ path: string; message: string; isFatal: boolean }> = [];
    let truncated = false;
    let cancelled = false;
    let completed = false;

    try {
      await this.traverseDirectory(
        absPath,
        rel || '',
        0,
        effectiveMaxDepth,
        ignoreEngine,
        entries,
        errors,
        {
          get truncated() {
            return truncated;
          },
          set truncated(v: boolean) {
            truncated = v;
          },
          get cancelled() {
            return cancelled;
          },
          set cancelled(v: boolean) {
            cancelled = v;
          },
        },
        options.signal,
        filterByType,
        includePatterns,
        maxEntries
      );
      completed = true;
    } catch (error) {
      if (isAbortError(error)) {
        cancelled = true;
        completed = false;
      } else {
        errors.push({
          path: absPath,
          message: error instanceof Error ? error.message : String(error),
          isFatal: true,
        });
        completed = false;
      }
    }

    return {
      kind: 'list',
      uri: options.uri,
      absolutePath: absPath,
      relativePath: rel || '',
      entries,
      count: entries.length,
      truncated,
      cancelled,
      completed,
      errors,
    };
  }

  private async traverseDirectory(
    absDir: string,
    relDir: string,
    depth: number,
    maxDepth: number,
    ignoreEngine: IgnoreEngine,
    entries: DirectoryListingEntry[],
    errors: Array<{ path: string; message: string; isFatal: boolean }>,
    state: TraverseState,
    signal: AbortSignal | undefined,
    filterByType: 'file' | 'directory' | 'all',
    includePatterns: readonly string[],
    maxEntries: number
  ): Promise<void> {
    if (state.cancelled) {
      return;
    }
    checkCancelled(signal, absDir);

    if (!isChildOf(normalizePath(this.workspaceFolder.uri), absDir)) {
      errors.push({
        path: absDir,
        message: 'Path escapes workspace root boundary',
        isFatal: false,
      });
      return;
    }

    let directoryEntries: readonly DirectoryEntry[];
    try {
      directoryEntries = await this.fileSystem.readDirectory(absDir);
    } catch (error) {
      errors.push({
        path: absDir,
        message: error instanceof Error ? error.message : String(error),
        isFatal: false,
      });
      return;
    }

    const sorted = [...directoryEntries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (state.cancelled || entries.length >= maxEntries) {
        if (entries.length >= maxEntries) {
          state.truncated = true;
        }
        return;
      }
      if (!this.config.includeHidden && entry.name.startsWith('.')) {
        continue;
      }

      const absEntry = `${absDir}/${entry.name}`;
      const relEntry = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      checkCancelled(signal, absEntry);

      // Boundary check per entry.
      if (!isChildOf(normalizePath(this.workspaceFolder.uri), absEntry)) {
        errors.push({
          path: absEntry,
          message: 'Entry escapes workspace root boundary',
          isFatal: false,
        });
        continue;
      }

      // Symbolic links are never followed or traversed. The FileSystemProvider
      // abstraction has no readlink/realpath API, so symlink targets cannot be
      // resolved or validated against the workspace root. Skip unconditionally.
      if (entry.type === 'symbolicLink') {
        continue;
      }

      if (entry.type === 'directory') {
        if (this.config.respectIgnoreRules) {
          const dirResult = ignoreEngine.isExcluded(relEntry, { isDirectory: true });
          if (dirResult.ignored) {
            continue;
          }
        }
        if (filterByType === 'directory' || filterByType === 'all') {
          entries.push(this.makeDirectoryEntry(relEntry, entry.name));
          if (entries.length >= maxEntries) {
            state.truncated = true;
            return;
          }
        }
        if (depth < maxDepth) {
          await this.traverseDirectory(
            absEntry,
            relEntry,
            depth + 1,
            maxDepth,
            ignoreEngine,
            entries,
            errors,
            state,
            signal,
            filterByType,
            includePatterns,
            maxEntries
          );
        }
        continue;
      }

      if (entry.type === 'file') {
        if (this.config.respectIgnoreRules) {
          const fileResult = ignoreEngine.isExcluded(relEntry, { isDirectory: false });
          if (fileResult.ignored) {
            continue;
          }
        }
        await this.collectFileEntry(
          absEntry,
          relEntry,
          undefined,
          ignoreEngine,
          entries,
          state,
          signal,
          filterByType,
          includePatterns,
          maxEntries
        );
        continue;
      }
    }
  }

  private async collectFileEntry(
    absPath: string,
    relPath: string,
    stat: FileStat | undefined,
    ignoreEngine: IgnoreEngine,
    entries: DirectoryListingEntry[],
    state: TraverseState,
    signal: AbortSignal | undefined,
    filterByType: 'file' | 'directory' | 'all',
    includePatterns: readonly string[],
    maxEntries: number
  ): Promise<void> {
    if (state.cancelled || entries.length >= maxEntries) {
      if (entries.length >= maxEntries) {
        state.truncated = true;
      }
      return;
    }
    checkCancelled(signal, absPath);

    let fileStat: FileStat;
    try {
      fileStat = stat ?? (await this.fileSystem.stat(absPath));
    } catch (error) {
      entries.push(this.makeErrorEntry(relPath, absPath));
      return;
    }

    if (this.config.respectSensitiveFiles) {
      const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
      const { extension } = splitNameExtension(baseName);
      if (isSensitiveFileName(baseName, extension)) {
        return;
      }
    }

    if (filterByType !== 'file' && filterByType !== 'all') {
      return;
    }

    if (includePatterns.length > 0 && !matchesIncludePatterns(relPath, includePatterns)) {
      return;
    }

    if (entries.length >= maxEntries) {
      state.truncated = true;
      return;
    }

    const metadata = this.collector.collect(absPath, relPath, fileStat);
    const baseName = relPath.slice(relPath.lastIndexOf('/') + 1);

    entries.push({
      relativePath: relPath,
      name: baseName,
      type: 'file',
      size: metadata.size,
      mtime: metadata.mtime,
      language: metadata.language,
      category: metadata.category,
      isBinary: metadata.isBinary,
      isSensitive: metadata.isSensitive,
      isIgnored: false,
    });
  }

  private makeDirectoryEntry(relativePath: string, name: string): DirectoryListingEntry {
    return {
      relativePath,
      name,
      type: 'directory',
      size: undefined,
      mtime: null,
      language: null,
      category: 'other',
      isBinary: false,
      isSensitive: false,
      isIgnored: false,
    };
  }

  private makeErrorEntry(relativePath: string, absPath: string): DirectoryListingEntry {
    return {
      relativePath,
      name: absPath.slice(absPath.lastIndexOf('/') + 1),
      type: 'file',
      size: undefined,
      mtime: null,
      language: null,
      category: 'other',
      isBinary: false,
      isSensitive: false,
      isIgnored: false,
    };
  }

  private dispose(): void {
    // No resources to release at this layer.
  }
}

export function createDirectoryLister(options: {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<DirectoryListConfig>;
}): DirectoryLister {
  return new DirectoryLister(options);
}
