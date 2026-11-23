import * as vscode from 'vscode';
import {
  WorkspaceScanOrchestrator,
  type FileChange,
  type IncrementalRefreshResult as IncrementalRefreshResultType,
  type OrchestratorStatus as OrchestratorStatusType,
  type ScanId,
  type ScanOptions,
  type ScanProgress as ScanProgressType,
  type WorkspaceFolderId,
  type ScanResult as ScanResultType,
  type WorkspaceProviderSubscription,
  type ContextSelectionOptions,
  RelevanceRanker,
  ContextSelector,
} from '@nexipi/workspace';
import type { Logger } from '@nexipi/shared';
import type { VSCodeFileSystemProvider } from './vscode-file-system-provider.js';
import { VSCodeFileWatcher, type FileWatchEvent } from './vscode-file-watcher.js';
import type { VSCodeWorkspaceProvider } from './vscode-workspace-provider.js';

/**
 * Snapshot of workspace intelligence status exposed to the extension UI.
 */
export interface WorkspaceStatus {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly workspaceId: string | null;
  readonly orchestrator: OrchestratorStatusType;
  readonly progress: ScanProgressType | null;
  readonly latestScanId: string | null;
}

/**
 * Options for {@link WorkspaceManager}.
 */
export interface WorkspaceManagerOptions {
  readonly logger: Logger;
  /**
   * Debounce delay in milliseconds applied to watcher events before an
   * incremental refresh is issued. Defaults to 150ms.
   */
  readonly debounceMs?: number;
}

/**
 * Extension-level manager for workspace discovery and scanning.
 *
 * Owns the VS Code-specific adapters (workspace provider, file system
 * provider, file watchers) and the {@link WorkspaceScanOrchestrator}. The
 * orchestrator internally owns its `WorkspaceDiscovery` and `IgnoreEngine`
 * instances; this manager disposes them only through the orchestrator's own
 * `dispose()` and never touches them directly.
 *
 * Disposal is idempotent and all owned resources are disposed exactly once.
 */
export class WorkspaceManager {
  private readonly logger: Logger;
  private readonly provider: VSCodeWorkspaceProvider;
  private readonly fileSystem: VSCodeFileSystemProvider;
  private readonly orchestrator: WorkspaceScanOrchestrator;
  private readonly debounceMs: number;

  private disposed = false;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  private readonly watchers = new Map<string, VSCodeFileWatcher>();
  private folderChangeSubscription: WorkspaceProviderSubscription | null = null;

  private readonly statusListeners = new Set<(status: WorkspaceStatus) => void>();
  private readonly pendingChanges = new Map<string, FileChange>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    provider: VSCodeWorkspaceProvider,
    fileSystem: VSCodeFileSystemProvider,
    options: WorkspaceManagerOptions
  ) {
    this.logger = options.logger;
    this.provider = provider;
    this.fileSystem = fileSystem;
    this.debounceMs = options.debounceMs ?? 150;
    this.orchestrator = new WorkspaceScanOrchestrator(provider, fileSystem);
  }

  /* ======================== Lifecycle ======================== */

  /**
   * Initialize workspace discovery and scanning.
   *
   * Idempotent: repeated calls return the same initialization promise and do
   * not duplicate subscriptions or watchers. The initial full scan is kicked
   * off in the background so activation is not blocked.
   */
  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error('WorkspaceManager has been disposed');
    }
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this.doInitialize();
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    // Subscribe to VS Code workspace folder changes exactly once.
    this.folderChangeSubscription = this.provider.onWorkspaceFoldersChange((event) => {
      this.handleWorkspaceFoldersChange(event);
    });

    // Create a file watcher for each existing workspace folder.
    const folders = await this.provider.getWorkspaceFolders();
    this.createWatchers(folders);

    this.initialized = true;
    this.emitStatus();

    // Kick off the initial full scan in the background. Do not await it so
    // extension activation is not blocked by a potentially large scan.
    void this.startFullScan();
  }

  /**
   * Current workspace id, derived from the latest completed scan result.
   */
  getWorkspaceId(): string | null {
    return this.orchestrator.getLatestResult()?.workspaceId ?? null;
  }

  getStatus(): WorkspaceStatus {
    return {
      initialized: this.initialized,
      disposed: this.disposed,
      workspaceId: this.getWorkspaceId(),
      orchestrator: this.orchestrator.getStatus(),
      progress: this.orchestrator.getProgress(),
      latestScanId: this.orchestrator.getCurrentScanId(),
    };
  }

  getProgress(): ScanProgressType | null {
    return this.orchestrator.getProgress();
  }

  getLatestScanResult(): ScanResultType | null {
    return this.orchestrator.getLatestResult();
  }

  /**
   * Subscribe to workspace status changes for UI integration.
   */
  onStatusChange(listener: (status: WorkspaceStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  /* ======================== Scanning ======================== */

  async startFullScan(options: ScanOptions = {}): Promise<ScanResultType> {
    const result = await this.orchestrator.startFullScan(options);
    this.emitStatus();
    return result;
  }

  async startFolderScan(
    folderId: WorkspaceFolderId,
    options: ScanOptions = {}
  ): Promise<ScanResultType> {
    const result = await this.orchestrator.startFolderScan(folderId, options);
    this.emitStatus();
    return result;
  }

  async cancel(scanId?: ScanId): Promise<boolean> {
    return this.orchestrator.cancel(scanId);
  }

  /* ======================== Ranking and context selection ======================== */

  /**
   * Rank and select files relevant to a query from the latest scan result.
   *
   * This reuses the workspace package's {@link RelevanceRanker} and
   * {@link ContextSelector} without duplicating their algorithms.
   *
   * IMPORTANT: The selected files are file references/metadata only. They are
   * NOT file contents and are NOT delivered to the AI model. Actual AI
   * context delivery (safe file-content retrieval, content limits, sensitive
   * file protection, request construction) is out of scope for this stage.
   *
   * Returns null when no scan result is available yet (e.g. empty workspace
   * before the first scan completes, or scan error/cancellation).
   */
  selectContext(
    query: string,
    options: {
      readonly signal?: AbortSignal;
      readonly maxFileCount?: number;
      readonly maxBudget?: number;
      readonly minRelevanceScore?: number;
      readonly enableDiversity?: boolean;
      readonly maxPerDirectory?: number;
      readonly maxPerProject?: number;
      readonly priorityMentions?: readonly string[];
    } = {}
  ): {
    readonly query: string;
    readonly ranking: ReturnType<RelevanceRanker['rankToRankedFiles']>;
    readonly selection: ReturnType<ContextSelector['select']>;
  } | null {
    const result = this.orchestrator.getLatestResult();
    if (!result) {
      return null;
    }

    const ranker = new RelevanceRanker();
    const ranking = ranker.rankToRankedFiles(
      { query, signal: options.signal },
      result.files
    );

    const selectionOptions: ContextSelectionOptions = {
      maxFileCount: options.maxFileCount ?? 20,
      maxBudget: options.maxBudget ?? 4096,
      minRelevanceScore: options.minRelevanceScore ?? 0,
      enableDiversity: options.enableDiversity ?? true,
      maxPerDirectory: options.maxPerDirectory ?? 5,
      maxPerProject: options.maxPerProject ?? 10,
      priorityMentions: options.priorityMentions,
      signal: options.signal,
    };
    const selector = new ContextSelector(selectionOptions);
    const selection = selector.select(ranking.rankedFiles);

    return { query, ranking, selection };
  }

  /* ======================== Incremental refresh (watcher-driven) ======================== */

  /**
   * Apply a batch of file changes through incremental refresh.
   *
   * When incremental refresh cannot be trusted (e.g. the index is stale
   * relative to the current workspace), it reports `requiresFullScan` and the
   * caller should fall back to a full scan.
   */
  async requestIncrementalRefresh(params: {
    readonly changes: readonly FileChange[];
    readonly workspaceId?: string;
  }): Promise<IncrementalRefreshResultType> {
    return this.orchestrator.requestIncrementalRefresh(params);
  }

  /**
   * Handle a single filesystem watcher event. Events are deduplicated by path
   * (latest wins) and debounced before being flushed as a single incremental
   * refresh batch. Rename events are carried as a single `renamed` change
   * with `previousAbsolutePath`.
   */
  onWatcherEvent(event: FileWatchEvent): void {
    if (this.disposed) {
      return;
    }
    const change = toFileChange(event);
    this.pendingChanges.set(change.absolutePath, change);
    this.scheduleDebouncedFlush();
  }

  private scheduleDebouncedFlush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushPendingChanges();
    }, this.debounceMs);
  }

  private async flushPendingChanges(): Promise<void> {
    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();
    if (changes.length === 0) {
      return;
    }

    const workspaceId = this.getWorkspaceId();
    let result: IncrementalRefreshResultType;
    try {
      result = await this.orchestrator.requestIncrementalRefresh({
        changes,
        workspaceId: workspaceId ?? undefined,
      });
    } catch (error) {
      this.logger.error('Incremental refresh failed', {
        error: error instanceof Error ? error.message : String(error),
        changeCount: changes.length,
      });
      return;
    }

    if (result.requiresFullScan) {
      this.logger.info('Incremental refresh requires full scan; scheduling fallback', {
        changesProcessed: result.changesProcessed,
      });
      void this.startFullScan();
    }
  }

  /* ======================== Workspace folder change handling ======================== */

  private handleWorkspaceFoldersChange(event: {
    readonly added: ReadonlyArray<{ readonly uri: string; readonly name: string; readonly index: number }>;
    readonly removed: ReadonlyArray<{ readonly uri: string; readonly name: string; readonly index: number }>;
    readonly changed: ReadonlyArray<{ readonly uri: string; readonly name: string; readonly index: number }>;
  }): void {
    if (this.disposed) {
      return;
    }

    // Dispose watchers for removed folders.
    for (const folder of event.removed) {
      const watcher = this.watchers.get(folder.uri);
      if (watcher) {
        watcher.dispose();
        this.watchers.delete(folder.uri);
      }
    }

    // Create watchers for added folders.
    for (const folder of event.added) {
      if (!this.watchers.has(folder.uri)) {
        this.createWatcher(folder);
      }
    }

    // A folder set change invalidates the cached workspace (handled by the
    // orchestrator's own subscription to discovery) and requires a rescan so
    // the index reflects the current workspace.
    this.logger.info('Workspace folders changed; rescheduling full scan', {
      added: event.added.length,
      removed: event.removed.length,
    });
    void this.startFullScan();
    this.emitStatus();
  }

  /* ======================== Watcher management ======================== */

  private createWatchers(folders: ReadonlyArray<{ readonly uri: string; readonly name: string; readonly index: number }>): void {
    for (const folder of folders) {
      this.createWatcher(folder);
    }
  }

  private createWatcher(folder: { readonly uri: string; readonly name: string; readonly index: number }): void {
    const watcher = new VSCodeFileWatcher(vscode.Uri.parse(folder.uri));
    watcher.onEvent((event) => this.onWatcherEvent(event));
    this.watchers.set(folder.uri, watcher);
  }

  /* ======================== Status ======================== */

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Listener errors must not break other status listeners.
      }
    }
  }

  /* ======================== Disposal ======================== */

  /**
   * Dispose all owned resources exactly once. Disposal is idempotent.
   *
   * The orchestrator's internal `WorkspaceDiscovery` and `IgnoreEngine`
   * resources are disposed by the orchestrator's own `dispose()`; this manager
   * does not touch them directly.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();

    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();

    this.folderChangeSubscription?.unsubscribe();
    this.folderChangeSubscription = null;

    // The orchestrator disposes its internal WorkspaceDiscovery and
    // IgnoreEngine resources; do not dispose them independently here.
    this.orchestrator.dispose();
    this.provider.dispose();

    this.initialized = false;
    this.statusListeners.clear();
  }
}

/**
 * Convert a watcher event into a {@link FileChange}. The watcher carries
 * `vscode.Uri.toString()` values (e.g. `file:///root/a.ts`); the workspace
 * package expects scheme-stripped absolute paths, so the `file://` scheme is
 * stripped here. Non-file URIs (remote / virtual) are preserved as-is.
 */
function toFileChange(event: FileWatchEvent): FileChange {
  return {
    type: event.type,
    absolutePath: toWorkspaceAbsolutePath(event.absolutePath),
    ...(event.previousAbsolutePath
      ? { previousAbsolutePath: toWorkspaceAbsolutePath(event.previousAbsolutePath) }
      : {}),
    timestamp: event.timestamp,
  };
}

/**
 * Strip the `file://` scheme from a URI string so it matches the workspace
 * package's internal path convention (e.g. `/root/a.ts`). Non-file URIs
 * (remote / virtual) are preserved unchanged.
 *
 * Uses `vscode.Uri.parse` so that:
 * - Windows drive-letter paths (`file:///C:/Users/...`) keep the drive letter
 *   instead of gaining a spurious leading slash.
 * - Percent-encoded segments are preserved (no manual decoding / double-decoding).
 * - The path component retains its leading slash so `toVsCodeUri` can
 *   correctly reconstruct `file://` URIs for round-trip consistency.
 */
function toWorkspaceAbsolutePath(uriString: string): string {
  const uri = vscode.Uri.parse(uriString);
  if (uri.scheme === 'file') {
    return uri.path.replace(/\\/g, '/').replace(/\/+$/, '');
  }
  // Remote / virtual URI schemes are preserved unchanged.
  return uriString;
}
