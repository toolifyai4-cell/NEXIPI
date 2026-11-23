import { randomUUID } from 'crypto';
import {
  createLogger,
  type Logger,
  defaultEngineConfig,
  createEventEmitter,
  type EventEmitter,
} from '@nexipi/core';
import type {
  WorkspaceProvider,
  FileSystemProvider,
} from '../discovery/workspace-provider.js';
import { WorkspaceDiscovery } from '../discovery/workspace-discovery.js';
import type { FileDiscoveryOptions } from '../discovery/file-discovery.js';
import { createFileDiscoveryService } from '../discovery/file-discovery.js';
import { ProjectAnalyzer } from '../analysis/project-analyzer.js';
import { IgnoreEngine } from '../ignore/ignore-engine.js';
import type {
  Workspace,
  WorkspaceFolder,
  WorkspaceFolderId,
  FileMetadata,
  DiscoveryError,
  ProjectRoot,
} from '../types.js';
import {
  defaultFileDiscoveryConfig,
  MandatorySafetyExclusions,
  DefaultDirectoryExclusions,
  validateWorkspaceScanConfig,
  defaultWorkspaceScanConfig,
  type WorkspaceScanConfig,
} from '../config.js';
import {
  ScanId,
  createScanId,
  ScanState,
  ScanStage,
  FileChangeType,
  ScanProgress,
  ScanResult,
  FolderScanResult,
  IncrementalRefreshResult,
  IncrementalError,
  ScanEventMap,
  ScanEventName,
  ScanEventEmitter,
  ScanOptions,
  OrchestratorStatus,
  WorkspaceScanOrchestratorOptions,
  isTerminalScanState,
  isActiveScanState,
  normalizeAbsolutePath,
  isPathUnderRoot,
} from './scan-types.js';
import {
  ScanError,
  ScanCancelledError,
  QueueOverflowError,
  InvalidWorkspaceStateError,
  WorkspaceDiscoveryError,
  IncrementalRefreshError,
  ScanErrorCode,
  isScanError,
} from './scan-errors.js';
import { ScanIndex } from './scan-index.js';

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

interface QueuedScan {
  scanId: ScanId;
  workspaceId: string;
  folderId: WorkspaceFolderId | undefined;
  abortController: AbortController;
  resolve: (result: ScanResult) => void;
  reject: (error: Error) => void;
}

interface ActiveScan extends QueuedScan {
  state: ScanState;
  startTime: number;
  stage: ScanStage;
  progress: ScanProgress;
  lastEmitTime: number;
}

function initialProgress(
  scanId: ScanId,
  workspaceId: string,
  startTime: number
): ScanProgress {
  return {
    scanId,
    workspaceId,
    state: 'idle',
    stage: 'initializing',
    operation: 'Initializing scan',
    directoriesProcessed: 0,
    filesDiscovered: 0,
    filesExcluded: 0,
    errors: [],
    startTime,
    elapsedTime: 0,
    completed: false,
    cancelled: false,
    timestamp: startTime,
  };
}

export class WorkspaceScanOrchestrator implements ScanEventEmitter {
  private readonly config: WorkspaceScanConfig;
  private readonly logger: Logger;
  private readonly eventEmitter: EventEmitter<ScanEventMap>;
  private readonly provider: WorkspaceProvider;
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceDiscovery: WorkspaceDiscovery;
  private readonly projectAnalyzer: ProjectAnalyzer;
  private readonly index: ScanIndex;
  private readonly ignoreEngines = new Map<WorkspaceFolderId, IgnoreEngine>();

  private readonly activeScans = new Map<ScanId, ActiveScan>();
  private readonly queue: QueuedScan[] = [];

  private state: ScanState = 'idle';
  private disposed = false;
  private latestResult: ScanResult | null = null;
  private latestProgress: ScanProgress | null = null;
  private cachedWorkspace: Workspace | null = null;

  constructor(
    provider: WorkspaceProvider,
    fileSystem: FileSystemProvider,
    options: WorkspaceScanOrchestratorOptions = {}
  ) {
    this.provider = provider;
    this.fileSystem = fileSystem;
    this.config = {
      ...defaultWorkspaceScanConfig,
      ...validateWorkspaceScanConfig(options.config ?? {}),
    };
    this.logger = options.logger ?? createLogger({
      ...defaultEngineConfig,
      name: 'workspace-scan-orchestrator',
      version: '0.0.1',
      logLevel: 'info',
    });
    this.eventEmitter = createEventEmitter<ScanEventMap>({
      onListenerError: (error, eventName) => {
        this.logger.error(`Listener error for event ${eventName}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.index = new ScanIndex();
    this.workspaceDiscovery = new WorkspaceDiscovery({
      provider,
      fileSystem,
      logger: this.logger,
    });
    this.projectAnalyzer = new ProjectAnalyzer({
      fileSystem,
      logger: this.logger,
    });
  }

  /* ======================== Public API ======================== */

  getStatus(): OrchestratorStatus {
    if (this.disposed) {
      return {
        state: 'disposed',
        currentScanId: this.currentScanId(),
        activeScanCount: 0,
        queuedScanCount: 0,
        disposed: true,
      };
    }
    let aggregate: ScanState = 'idle';
    for (const scan of this.activeScans.values()) {
      if (isActiveScanState(scan.state)) {
        aggregate = 'scanning';
        break;
      }
    }
    if (aggregate === 'idle' && this.queue.length > 0) {
      aggregate = 'queued';
    }
    return {
      state: aggregate,
      currentScanId: this.currentScanId(),
      activeScanCount: this.activeScans.size,
      queuedScanCount: this.queue.length,
      disposed: false,
    };
  }

  getCurrentScanId(): ScanId | null {
    return this.currentScanId();
  }

  getLatestResult(): ScanResult | null {
    return this.latestResult;
  }

  getProgress(): ScanProgress | null {
    return this.latestProgress;
  }

  getIndex(): ScanIndex {
    return this.index;
  }

  /* ======================== ScanEventEmitter ======================== */

  on<T extends ScanEventName>(
    eventName: T,
    listener: (payload: ScanEventMap[T]) => void | Promise<void>
  ): { unsubscribe(): void } {
    if (this.disposed) {
      return { unsubscribe: () => undefined };
    }
    return this.eventEmitter.on(eventName, listener);
  }

  off<T extends ScanEventName>(
    eventName: T,
    listener: (payload: ScanEventMap[T]) => void | Promise<void>
  ): boolean {
    if (this.disposed) {
      return false;
    }
    return this.eventEmitter.off(eventName, listener);
  }

  emit<T extends ScanEventName>(eventName: T, payload: ScanEventMap[T]): void {
    if (this.disposed) {
      return;
    }
    this.eventEmitter.emit(eventName, payload);
  }

  emitAsync<T extends ScanEventName>(
    eventName: T,
    payload: ScanEventMap[T]
  ): Promise<void[]> {
    if (this.disposed) {
      return Promise.resolve([]);
    }
    return this.eventEmitter.emitAsync(eventName, payload);
  }

  listenerCount(eventName: ScanEventName): number {
    return this.eventEmitter.listenerCount(eventName);
  }

  removeAllListeners(eventName?: ScanEventName): void {
    this.eventEmitter.removeAllListeners(eventName);
  }

  async startFullScan(options: ScanOptions = {}): Promise<ScanResult> {
    return this.startScan({
      folderId: undefined,
      workspaceId: options.workspaceId ?? undefined,
      abortSignal: options.abortSignal ?? undefined,
    });
  }

  async startFolderScan(
    folderId: WorkspaceFolderId,
    options: ScanOptions = {}
  ): Promise<ScanResult> {
    return this.startScan({
      folderId,
      workspaceId: options.workspaceId ?? undefined,
      abortSignal: options.abortSignal ?? undefined,
    });
  }

  async requestIncrementalRefresh(params: {
    changes: readonly {
      type: FileChangeType;
      absolutePath: string;
      previousAbsolutePath?: string;
      timestamp?: number;
    }[];
    workspaceId?: string;
  }): Promise<IncrementalRefreshResult> {
    this.throwIfDisposed();
    if (!this.config.incrementalRefresh.enabled) {
      throw new IncrementalRefreshError('Incremental refresh is disabled');
    }

    const workspaceId = params.workspaceId ?? this.latestResult?.workspaceId;
    if (!workspaceId) {
      return this.emptyIncrementalResult(true);
    }

    const workspace = await this.resolveWorkspace().catch(() => null);
    if (!workspace) {
      return this.emptyIncrementalResult(true);
    }

    if (!this.index.isComplete() || this.index.getWorkspaceId() !== workspaceId) {
      return this.emptyIncrementalResult(true);
    }

    const changes = params.changes.slice(0, this.config.incrementalRefresh.maxChangesPerBatch);
    const errors: IncrementalError[] = [];
    let filesAdded = 0;
    let filesChanged = 0;
    let filesRemoved = 0;
    const processedPaths = new Set<string>();

    for (const change of changes) {
      const normalized = normalizeAbsolutePath(change.absolutePath);
      if (processedPaths.has(normalized)) {
        continue;
      }
      processedPaths.add(normalized);

      const folder = this.findFolderForPath(workspace, normalized);
      if (!folder) {
        errors.push({
          change: {
            type: change.type,
            absolutePath: change.absolutePath,
            timestamp: change.timestamp ?? Date.now(),
          },
          message: 'Path is outside the associated workspace',
          isFatal: false,
        });
        continue;
      }

      try {
        switch (change.type) {
          case 'created':
            if (await this.handleCreated(workspace, folder, normalized)) {
              filesAdded += 1;
            }
            break;
          case 'changed':
            if (await this.handleChanged(workspace, folder, normalized)) {
              filesChanged += 1;
            }
            break;
          case 'deleted':
            if (this.handleDeleted(normalized)) {
              filesRemoved += 1;
            }
            break;
          case 'renamed':
            if (change.previousAbsolutePath) {
              const removed = this.handleDeleted(normalizeAbsolutePath(change.previousAbsolutePath));
              const added = await this.handleCreated(workspace, folder, normalized);
              if (removed) {
                filesRemoved += 1;
              }
              if (added) {
                filesAdded += 1;
              }
            }
            break;
        }
      } catch (error) {
        errors.push({
          change: {
            type: change.type,
            absolutePath: change.absolutePath,
            timestamp: change.timestamp ?? Date.now(),
          },
          message: error instanceof Error ? error.message : String(error),
          isFatal: false,
        });
      }
    }

    return {
      applied: errors.length === 0,
      requiresFullScan: false,
      changesProcessed: changes.length,
      filesAdded,
      filesChanged,
      filesRemoved,
      errors,
      timestamp: Date.now(),
    };
  }

  async cancel(scanId?: ScanId): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const targets: ActiveScan[] = [];
    if (scanId) {
      const scan = this.activeScans.get(scanId);
      if (scan) {
        targets.push(scan);
      }
    } else {
      for (const scan of this.activeScans.values()) {
        targets.push(scan);
      }
    }

    let cancelledAny = false;
    for (const scan of targets) {
      if (isTerminalScanState(scan.state)) {
        continue;
      }
      cancelledAny = true;
      this.transitionScanState(scan, 'cancelling');
      try {
        scan.abortController.abort();
      } catch {
        // AbortController.abort() does not throw; defensive only.
      }
      this.transitionScanState(scan, 'cancelled');
      this.emitScanCancelled(scan);
    }

    if (!scanId) {
      for (const queued of this.queue) {
        this.transitionQueuedToCancelled(queued);
        cancelledAny = true;
      }
      this.queue.length = 0;
    } else {
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        if (this.queue[i]!.scanId === scanId) {
          this.transitionQueuedToCancelled(this.queue[i]!);
          this.queue.splice(i, 1);
          cancelledAny = true;
        }
      }
    }

    this.transitionOrchestratorState();
    return cancelledAny;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const scan of this.activeScans.values()) {
      if (!isTerminalScanState(scan.state)) {
        try {
          scan.abortController.abort();
        } catch {
          // Ignore.
        }
      }
    }
    this.activeScans.clear();

    for (const queued of this.queue) {
      try {
        queued.reject(new ScanCancelledError('Orchestrator disposed', { scanId: queued.scanId }));
      } catch {
        // Ignore rejection errors during disposal.
      }
    }
    this.queue.length = 0;

    try {
      this.workspaceDiscovery.dispose();
    } catch {
      // Ignore.
    }

    for (const engine of this.ignoreEngines.values()) {
      try {
        engine.dispose();
      } catch {
        // Ignore.
      }
    }
    this.ignoreEngines.clear();

    this.eventEmitter.removeAllListeners();
    this.state = 'disposed';
    this.latestProgress = null;
  }

  /* ======================== Scan execution ======================== */

  private async startScan(params: {
    folderId: WorkspaceFolderId | undefined;
    workspaceId: string | undefined;
    abortSignal: AbortSignal | undefined;
  }): Promise<ScanResult> {
    this.throwIfDisposed();

    const workspace = await this.resolveWorkspace();
    const workspaceId = params.workspaceId ?? workspace.id;

    const existing = this.findActiveScanForWorkspace(workspaceId);
    if (existing) {
      if (this.config.duplicateScanBehavior === 'reject') {
        throw new InvalidWorkspaceStateError(
          `A scan is already active for workspace ${workspaceId}`,
          { scanId: existing.scanId }
        );
      }
      if (this.config.duplicateScanBehavior === 'cancel-existing') {
        await this.cancel(existing.scanId);
      }
    }

    const abortController = new AbortController();
    if (params.abortSignal) {
      params.abortSignal.addEventListener('abort', () => {
        abortController.abort();
      });
    }

    const scanId = createScanId(randomUUID());
    const startTime = Date.now();

    const scan: ActiveScan = {
      scanId,
      workspaceId,
      folderId: params.folderId,
      abortController,
      state: 'queued',
      startTime,
      stage: 'initializing',
      progress: initialProgress(scanId, workspaceId, startTime),
      lastEmitTime: startTime,
      resolve: () => {},
      reject: () => {},
    };

    const resultPromise = new Promise<ScanResult>((resolve, reject) => {
      scan.resolve = resolve;
      scan.reject = reject;
    });

    let runNow = false;
    switch (this.config.concurrencyPolicy) {
      case 'cancel-previous':
        await this.cancelAllActive();
        runNow = true;
        break;
      case 'queue':
        runNow = this.getRunningScanCount() === 0;
        if (!runNow) {
          this.enqueue(scan);
        }
        break;
      case 'allow-all':
        if (this.getRunningScanCount() < this.config.maxConcurrentScans) {
          runNow = true;
        } else {
          this.enqueue(scan);
        }
        break;
    }

    if (this.queue.length > this.config.maxQueuedScans) {
      const overflowIndex = this.queue.findIndex((q) => q.scanId === scanId);
      if (overflowIndex >= 0) {
        this.queue.splice(overflowIndex, 1);
      }
      this.activeScans.delete(scanId);
      throw new QueueOverflowError(
        `Scan queue is full (max ${this.config.maxQueuedScans} queued scans)`,
        { scanId }
      );
    }

    this.activeScans.set(scanId, scan);
    this.transitionScanState(scan, 'queued');
    this.transitionOrchestratorState();
    this.emitScanStarted(scan, workspaceId);

    if (runNow) {
      void this.runScan(scan);
    } else {
      this.processQueue();
    }

    return resultPromise;
  }

  private async runScan(scan: ActiveScan): Promise<void> {
    const signal = scan.abortController.signal;
    try {
      this.transitionScanState(scan, 'scanning');
      let result: ScanResult;
      if (scan.folderId) {
        result = await this.runFolderScan(scan);
      } else {
        result = await this.runFullScan(scan);
      }

      // Late-completion guard: a cancelled scan must never be reported as completed.
      if (signal.aborted && result.state === 'completed') {
        result = this.buildCancelledResult(scan);
      }

      // Transition to the final state (validated by the state machine).
      this.transitionScanState(scan, result.state);
      this.onScanSucceeded(scan, result);
    } catch (error) {
      if (signal.aborted || error instanceof ScanCancelledError || isAbortError(error)) {
        const result = this.buildCancelledResult(scan);
        this.transitionScanState(scan, result.state);
        this.onScanSucceeded(scan, result);
      } else {
        this.onScanFailed(scan, error as Error);
      }
    } finally {
      this.activeScans.delete(scan.scanId);
      this.transitionOrchestratorState();
      this.processQueue();
    }
  }

  private async runFullScan(scan: ActiveScan): Promise<ScanResult> {
    const signal = scan.abortController.signal;
    const startTime = scan.startTime;
    const assertNotAborted = (): void => {
      if (signal.aborted) {
        throw new ScanCancelledError(`Scan ${scan.scanId} was cancelled`, { scanId: scan.scanId });
      }
    };

    let stage: ScanStage = 'initializing';
    let operation = 'Initializing scan';
    this.emitProgress(scan, stage, operation);

    // 1. Resolve workspace.
    stage = 'discovering-workspace';
    operation = 'Discovering workspace';
    this.emitProgress(scan, stage, operation);
    assertNotAborted();

    const workspace = await this.resolveWorkspace();
    assertNotAborted();

    // 2. Analyze projects.
    stage = 'analyzing-projects';
    operation = 'Analyzing project manifests';
    this.emitProgress(scan, stage, operation);
    assertNotAborted();

    const folderUris = workspace.folders.map((f) => normalizeAbsolutePath(f.uri));
    let projectRoots: readonly ProjectRoot[] = [];
    try {
      projectRoots = await this.projectAnalyzer.analyzeProjectRoots(folderUris);
    } catch (error) {
      this.logger.error('Project analysis failed, continuing without project info', {
        error: error instanceof Error ? error.message : String(error),
      });
      projectRoots = [];
    }
    assertNotAborted();

    // 3. Discover files per folder.
    stage = 'discovering-files';
    operation = 'Discovering files';
    this.emitProgress(scan, stage, operation);

    const allFiles: FileMetadata[] = [];
    const folderResults: FolderScanResult[] = [];
    const seenPaths = new Set<string>();
    let cancelled = false;
    let failed = false;
    let directoriesProcessed = 0;
    let filesExcluded = 0;
    const errors: DiscoveryError[] = [];

    for (const folder of workspace.folders) {
      assertNotAborted();

      stage = 'discovering-files';
      operation = `Discovering files in ${folder.name}`;
      this.emitProgress(scan, stage, operation, {
        workspaceFolderId: folder.id,
        directoriesProcessed,
        filesDiscovered: allFiles.length,
        filesExcluded,
      });

      const folderResult = await this.discoverFolder(folder, projectRoots, signal);
      directoriesProcessed += folderResult.directoriesProcessed;
      filesExcluded += folderResult.filesExcluded;
      errors.push(...folderResult.errors);

      if (folderResult.cancelled) {
        cancelled = true;
        break;
      }
      if (!folderResult.completed) {
        failed = true;
      }

      for (const file of folderResult.files) {
        const key = normalizeAbsolutePath(file.absolutePath);
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          allFiles.push(file);
        }
      }

      folderResults.push({
        workspaceFolderId: folder.id,
        workspaceFolderUri: folder.uri,
        files: folderResult.files,
        count: folderResult.count,
        directoriesProcessed: folderResult.directoriesProcessed,
        filesExcluded: folderResult.filesExcluded,
        completed: folderResult.completed,
        cancelled: folderResult.cancelled,
        truncated: folderResult.truncated,
        errors: folderResult.errors,
      });

      this.emitProgress(scan, stage, `Discovered files in ${folder.name}`, {
        workspaceFolderId: folder.id,
        directoriesProcessed,
        filesDiscovered: allFiles.length,
        filesExcluded,
      });
    }

    assertNotAborted();

    // 4. Update scan results.
    stage = 'updating-scan-results';
    operation = 'Updating scan results';
    this.emitProgress(scan, stage, operation, {
      directoriesProcessed,
      filesDiscovered: allFiles.length,
      filesExcluded,
    });

    const finalState: ScanState = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    const endTime = Date.now();

    const result: ScanResult = {
      scanId: scan.scanId,
      workspaceId: workspace.id,
      state: finalState,
      stage: finalState === 'completed' ? 'completed' : finalState === 'cancelled' ? 'cancelled' : 'failed',
      files: allFiles,
      count: allFiles.length,
      projectRoots,
      truncated: folderResults.some((f) => f.truncated),
      cancelled,
      completed: finalState === 'completed',
      failed: finalState === 'failed',
      errors,
      folderResults,
      startTime,
      endTime,
      durationMs: endTime - startTime,
    };

    if (finalState === 'completed') {
      this.index.replaceResults(allFiles, workspace.id);
      this.latestResult = result;
    } else {
      this.index.markPartial(workspace.id);
    }

    stage = finalState === 'completed' ? 'completed' : finalState === 'cancelled' ? 'cancelled' : 'failed';
    operation =
      finalState === 'completed'
        ? 'Scan completed'
        : finalState === 'cancelled'
          ? 'Scan cancelled'
          : 'Scan failed';
    this.emitProgress(scan, stage, operation, {
      directoriesProcessed,
      filesDiscovered: allFiles.length,
      filesExcluded,
      completed: finalState === 'completed',
      cancelled: finalState === 'cancelled',
    });

    return result;
  }

  private async runFolderScan(scan: ActiveScan): Promise<ScanResult> {
    const signal = scan.abortController.signal;
    const startTime = scan.startTime;
    const assertNotAborted = (): void => {
      if (signal.aborted) {
        throw new ScanCancelledError(`Scan ${scan.scanId} was cancelled`, { scanId: scan.scanId });
      }
    };

    const workspace = await this.resolveWorkspace();
    assertNotAborted();

    const folder = workspace.folders.find((f) => f.id === scan.folderId);
    if (!folder) {
      throw new InvalidWorkspaceStateError(
        `Workspace folder ${scan.folderId} not found`,
        { scanId: scan.scanId }
      );
    }

    this.emitProgress(scan, 'discovering-files', `Discovering files in ${folder.name}`, {
      workspaceFolderId: folder.id,
    });
    assertNotAborted();

    const folderUris = workspace.folders.map((f) => normalizeAbsolutePath(f.uri));
    let projectRoots: readonly ProjectRoot[] = [];
    try {
      projectRoots = await this.projectAnalyzer.analyzeProjectRoots(folderUris);
    } catch {
      projectRoots = [];
    }
    assertNotAborted();

    const folderResult = await this.discoverFolder(folder, projectRoots, signal);

    const allFiles: FileMetadata[] = [];
    const seenPaths = new Set<string>();
    for (const file of folderResult.files) {
      const key = normalizeAbsolutePath(file.absolutePath);
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        allFiles.push(file);
      }
    }

    const cancelled = folderResult.cancelled;
    const failed = !folderResult.completed && !folderResult.cancelled;
    const finalState: ScanState = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    const endTime = Date.now();

    const result: ScanResult = {
      scanId: scan.scanId,
      workspaceId: workspace.id,
      state: finalState,
      stage: finalState === 'completed' ? 'completed' : finalState === 'cancelled' ? 'cancelled' : 'failed',
      files: allFiles,
      count: allFiles.length,
      projectRoots,
      truncated: folderResult.truncated,
      cancelled,
      completed: finalState === 'completed',
      failed: finalState === 'failed',
      errors: folderResult.errors,
      folderResults: [
        {
          workspaceFolderId: folder.id,
          workspaceFolderUri: folder.uri,
          files: folderResult.files,
          count: folderResult.count,
          directoriesProcessed: folderResult.directoriesProcessed,
          filesExcluded: folderResult.filesExcluded,
          completed: folderResult.completed,
          cancelled: folderResult.cancelled,
          truncated: folderResult.truncated,
          errors: folderResult.errors,
        },
      ],
      startTime,
      endTime,
      durationMs: endTime - startTime,
    };

    if (finalState === 'completed') {
      this.index.replaceResults(allFiles, workspace.id);
      this.latestResult = result;
    } else {
      this.index.markPartial(workspace.id);
    }

    this.emitProgress(scan, finalState === 'completed' ? 'completed' : finalState === 'cancelled' ? 'cancelled' : 'failed', finalState === 'completed' ? 'Folder scan completed' : finalState === 'cancelled' ? 'Folder scan cancelled' : 'Folder scan failed', {
      workspaceFolderId: folder.id,
      directoriesProcessed: folderResult.directoriesProcessed,
      filesDiscovered: allFiles.length,
      filesExcluded: folderResult.filesExcluded,
      completed: finalState === 'completed',
      cancelled: finalState === 'cancelled',
    });

    return result;
  }

  private async discoverFolder(
    folder: WorkspaceFolder,
    projectRoots: readonly ProjectRoot[],
    signal: AbortSignal
  ): Promise<FolderScanResult> {
    const projectId = this.findProjectId(folder, projectRoots);
    const serviceOptions: FileDiscoveryOptions = {
      fileSystem: this.fileSystem,
      workspaceFolder: folder,
      config: {},
      signal,
    };
    if (projectId !== undefined) {
      serviceOptions.projectId = projectId;
    }
    const service = createFileDiscoveryService(serviceOptions);

    const result = await service.discover();

    return {
      workspaceFolderId: folder.id,
      workspaceFolderUri: folder.uri,
      files: result.files,
      count: result.count,
      directoriesProcessed: 1,
      filesExcluded: 0,
      completed: result.completed,
      cancelled: result.cancelled,
      truncated: result.truncated,
      errors: result.errors,
    };
  }

  /* ======================== Incremental refresh helpers ======================== */

  private async handleCreated(
    workspace: Workspace,
    folder: WorkspaceFolder,
    normalizedPath: string
  ): Promise<boolean> {
    const relativePath = this.relativePathFor(folder, normalizedPath);
    if (relativePath === undefined) {
      return false;
    }

    const ignoreEngine = await this.getIgnoreEngine(folder);
    const excluded = ignoreEngine.isExcluded(relativePath, { isDirectory: false });
    if (excluded.ignored) {
      return false;
    }

    let stat;
    try {
      stat = await this.fileSystem.stat(normalizedPath);
    } catch {
      return false;
    }
    if (stat.type !== 'file') {
      return false;
    }

    const projectId = this.findProjectId(folder, []);
    const metadata = this.collectMetadata(folder, projectId, normalizedPath, relativePath, stat);
    this.index.upsertMetadata(metadata);
    return true;
  }

  private async handleChanged(
    workspace: Workspace,
    folder: WorkspaceFolder,
    normalizedPath: string
  ): Promise<boolean> {
    const existing = this.index.getByPath(normalizedPath);
    if (!existing) {
      return this.handleCreated(workspace, folder, normalizedPath);
    }

    const relativePath = this.relativePathFor(folder, normalizedPath);
    if (relativePath === undefined) {
      return false;
    }

    const ignoreEngine = await this.getIgnoreEngine(folder);
    const excluded = ignoreEngine.isExcluded(relativePath, { isDirectory: false });
    if (excluded.ignored) {
      this.index.removeFile(existing.id);
      return true;
    }

    let stat;
    try {
      stat = await this.fileSystem.stat(normalizedPath);
    } catch {
      return false;
    }
    if (stat.type !== 'file') {
      return false;
    }

    const projectId = this.findProjectId(folder, []);
    const metadata = this.collectMetadata(folder, projectId, normalizedPath, relativePath, stat);
    this.index.upsertMetadata(metadata);
    return true;
  }

  private handleDeleted(normalizedPath: string): boolean {
    const existing = this.index.getByPath(normalizedPath);
    if (existing) {
      this.index.removeFile(existing.id);
      return true;
    }
    return false;
  }

  private collectMetadata(
    folder: WorkspaceFolder,
    projectId: string | undefined,
    absolutePath: string,
    relativePath: string,
    stat: { size: number; mtime: number; type: string }
  ): FileMetadata {
    const baseName = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
    const dotIndex = baseName.lastIndexOf('.');
    const name = dotIndex <= 0 || dotIndex === baseName.length - 1 ? baseName : baseName.slice(0, dotIndex);
    const extension = dotIndex <= 0 || dotIndex === baseName.length - 1 ? '' : baseName.slice(dotIndex + 1).toLowerCase();
    const isHidden = baseName.startsWith('.');
    const workspaceId = this.latestResult?.workspaceId ?? '';
    return {
      id: `${workspaceId}:${relativePath}`,
      workspaceId,
      workspaceFolderId: folder.id,
      ...(projectId !== undefined ? { projectId } : {}),
      absolutePath: normalizeAbsolutePath(absolutePath),
      uri: `file:///${normalizeAbsolutePath(absolutePath).replace(/^\/+/, '')}`,
      relativePath,
      name,
      extension,
      size: stat.size,
      mtime: stat.mtime ?? null,
      language: null,
      category: 'other',
      isHidden,
      isManifest: false,
      isConfig: false,
      isBinary: false,
      isSensitive: false,
      sourceExcluded: false,
    } as FileMetadata;
  }

  private async getIgnoreEngine(folder: WorkspaceFolder): Promise<IgnoreEngine> {
    const existing = this.ignoreEngines.get(folder.id);
    if (existing) {
      return existing;
    }
    const root = normalizeAbsolutePath(folder.uri.replace(/^file:\/\//, ''));
    const engine = new IgnoreEngine({
      fileSystem: this.fileSystem,
      workspaceFolder: folder,
      root,
      config: {
        enableMandatorySafetyExclusions: true,
        enableDefaultExclusions: true,
        userExclusions: [],
        caseSensitive: false,
      },
      logger: this.logger,
    });
    this.ignoreEngines.set(folder.id, engine);
    return engine;
  }

  private relativePathFor(folder: WorkspaceFolder, absolutePath: string): string | undefined {
    const root = normalizeAbsolutePath(folder.uri.replace(/^file:\/\//, ''));
    const normalized = normalizeAbsolutePath(absolutePath);
    if (normalized === root) {
      return '';
    }
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1);
    }
    return undefined;
  }

  private findProjectId(folder: WorkspaceFolder, projectRoots: readonly ProjectRoot[]): string | undefined {
    const folderPath = normalizeAbsolutePath(folder.uri.replace(/^file:\/\//, ''));
    for (const root of projectRoots) {
      const rootPath = normalizeAbsolutePath(root.path);
      if (folderPath === rootPath || folderPath.startsWith(`${rootPath}/`)) {
        return root.name;
      }
    }
    return undefined;
  }

  private findFolderForPath(workspace: Workspace, normalizedPath: string): WorkspaceFolder | undefined {
    for (const folder of workspace.folders) {
      const root = normalizeAbsolutePath(folder.uri.replace(/^file:\/\//, ''));
      if (isPathUnderRoot(root, normalizedPath)) {
        return folder;
      }
    }
    return undefined;
  }

  /* ======================== Queue & state management ======================== */

  private enqueue(scan: QueuedScan): void {
    this.queue.push(scan);
  }

  private getRunningScanCount(): number {
    let count = 0;
    for (const scan of this.activeScans.values()) {
      if (scan.state === 'scanning' || scan.state === 'cancelling') {
        count += 1;
      }
    }
    return count;
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      let canRun = false;
      switch (this.config.concurrencyPolicy) {
        case 'queue':
          canRun = this.getRunningScanCount() === 0;
          break;
        case 'allow-all':
          canRun = this.getRunningScanCount() < this.config.maxConcurrentScans;
          break;
        case 'cancel-previous':
          canRun = false;
          break;
      }
      if (!canRun) {
        break;
      }
      this.queue.shift();
      const active: ActiveScan = {
        ...next,
        state: 'queued',
        startTime: Date.now(),
        stage: 'initializing',
        progress: initialProgress(next.scanId, next.workspaceId, Date.now()),
        lastEmitTime: Date.now(),
      };
      this.activeScans.set(active.scanId, active);
      this.transitionScanState(active, 'queued');
      this.transitionOrchestratorState();
      this.emitScanStarted(active, active.workspaceId);
      void this.runScan(active);
    }
  }

  private async cancelAllActive(): Promise<void> {
    for (const scan of this.activeScans.values()) {
      if (!isTerminalScanState(scan.state)) {
        scan.abortController.abort();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  private transitionScanState(scan: ActiveScan, newState: ScanState): void {
    const previous = scan.state;
    if (previous === newState) {
      return;
    }
    if (!this.isValidTransition(previous, newState)) {
      this.logger.error('Invalid scan state transition', {
        scanId: scan.scanId,
        previous,
        newState,
      });
      return;
    }
    scan.state = newState;
    if (newState === 'completed' || newState === 'cancelled' || newState === 'failed') {
      scan.progress = {
        ...scan.progress,
        state: newState,
        completed: newState === 'completed',
        cancelled: newState === 'cancelled',
        elapsedTime: Date.now() - scan.startTime,
      };
    }
    this.emitScanStateChanged(scan, previous, newState);
    this.latestProgress = scan.progress;
    this.transitionOrchestratorState();
  }

  private transitionQueuedToCancelled(queued: QueuedScan): void {
    try {
      queued.reject(new ScanCancelledError('Scan cancelled', { scanId: queued.scanId }));
    } catch {
      // Ignore.
    }
    queued.abortController.abort();
  }

  private isValidTransition(previous: ScanState, next: ScanState): boolean {
    const allowed: Record<ScanState, readonly ScanState[]> = {
      idle: ['queued', 'disposed'],
      queued: ['scanning', 'cancelled', 'disposed'],
      scanning: ['cancelling', 'cancelled', 'completed', 'failed', 'disposed'],
      cancelling: ['cancelled', 'disposed'],
      completed: ['disposed'],
      cancelled: ['disposed'],
      failed: ['disposed'],
      disposed: [],
    };
    return (allowed[previous] ?? []).includes(next);
  }

  private transitionOrchestratorState(): void {
    if (this.disposed) {
      this.state = 'disposed';
      return;
    }
    let aggregate: ScanState = 'idle';
    for (const scan of this.activeScans.values()) {
      if (isActiveScanState(scan.state)) {
        aggregate = 'scanning';
        break;
      }
    }
    if (aggregate === 'idle' && this.queue.length > 0) {
      aggregate = 'queued';
    }
    this.state = aggregate;
  }

  private currentScanId(): ScanId | null {
    for (const scan of this.activeScans.values()) {
      if (isActiveScanState(scan.state)) {
        return scan.scanId;
      }
    }
    return null;
  }

  private findActiveScanForWorkspace(workspaceId: string): ActiveScan | undefined {
    for (const scan of this.activeScans.values()) {
      if (scan.workspaceId === workspaceId && isActiveScanState(scan.state)) {
        return scan;
      }
    }
    return undefined;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new ScanError(ScanErrorCode.DISPOSAL_FAILED, 'Orchestrator has been disposed');
    }
  }

  /* ======================== Event emission ======================== */

  private emitScanStarted(scan: ActiveScan, workspaceId: string): void {
    this.eventEmitter.emit('scan:started', { scanId: scan.scanId, workspaceId, timestamp: Date.now() });
  }

  private emitScanStateChanged(scan: ActiveScan, previous: ScanState, newState: ScanState): void {
    this.eventEmitter.emit('scan:state-changed', {
      scanId: scan.scanId,
      previousState: previous,
      newState,
      timestamp: Date.now(),
    });
  }

  private emitScanCancelled(scan: ActiveScan): void {
    this.eventEmitter.emit('scan:cancelled', { scanId: scan.scanId, timestamp: Date.now() });
  }

  private emitProgress(
    scan: ActiveScan,
    stage: ScanStage,
    operation: string,
    overrides: Partial<
      Pick<
        ScanProgress,
        'workspaceFolderId' | 'directoriesProcessed' | 'filesDiscovered' | 'filesExcluded' | 'completed' | 'cancelled' | 'errors'
      >
    > = {}
  ): void {
    const now = Date.now();
    const progress: ScanProgress = {
      scanId: scan.scanId,
      workspaceId: scan.workspaceId,
      ...(overrides.workspaceFolderId !== undefined
        ? { workspaceFolderId: overrides.workspaceFolderId }
        : {}),
      state: scan.state,
      stage,
      operation,
      directoriesProcessed: overrides.directoriesProcessed ?? 0,
      filesDiscovered: overrides.filesDiscovered ?? 0,
      filesExcluded: overrides.filesExcluded ?? 0,
      errors: overrides.errors ?? [],
      startTime: scan.startTime,
      elapsedTime: now - scan.startTime,
      completed: overrides.completed ?? false,
      cancelled: overrides.cancelled ?? false,
      timestamp: now,
    };
    scan.stage = stage;
    scan.progress = progress;
    this.latestProgress = progress;
    this.eventEmitter.emit('scan:progress', { progress, timestamp: now });
  }

  private onScanSucceeded(scan: ActiveScan, result: ScanResult): void {
    this.latestResult = result;
    this.latestProgress = scan.progress;
    this.eventEmitter.emit('scan:completed', { scanId: scan.scanId, result, timestamp: Date.now() });
    try {
      scan.resolve(result);
    } catch {
      // Ignore resolution errors.
    }
  }

  private onScanFailed(scan: ActiveScan, error: Error): void {
    this.transitionScanState(scan, 'failed');
    this.eventEmitter.emit('scan:failed', {
      scanId: scan.scanId,
      error,
      context: 'scan-execution',
      timestamp: Date.now(),
    });
    try {
      const scanError = isScanError(error) ? error : new ScanError(ScanErrorCode.FILE_DISCOVERY_FAILED, error instanceof Error ? error.message : String(error), { cause: error instanceof Error ? error : undefined });
      scan.reject(scanError);
    } catch {
      // Ignore rejection errors.
    }
  }

  private buildCancelledResult(scan: ActiveScan): ScanResult {
    return {
      scanId: scan.scanId,
      workspaceId: scan.workspaceId,
      state: 'cancelled',
      stage: 'cancelled',
      files: [],
      count: 0,
      projectRoots: [],
      truncated: false,
      cancelled: true,
      completed: false,
      failed: false,
      errors: [],
      folderResults: [],
      startTime: scan.startTime,
      endTime: Date.now(),
      durationMs: Date.now() - scan.startTime,
    };
  }

  private emptyIncrementalResult(requiresFullScan: boolean): IncrementalRefreshResult {
    return {
      applied: !requiresFullScan,
      requiresFullScan,
      changesProcessed: 0,
      filesAdded: 0,
      filesChanged: 0,
      filesRemoved: 0,
      errors: [],
      timestamp: Date.now(),
    };
  }

  private async resolveWorkspace(): Promise<Workspace> {
    if (this.cachedWorkspace) {
      return this.cachedWorkspace;
    }
    const existing = this.workspaceDiscovery.getCurrentWorkspace();
    if (existing) {
      this.cachedWorkspace = existing;
      return existing;
    }
    await this.workspaceDiscovery.initialize();
    const workspace = this.workspaceDiscovery.getCurrentWorkspace();
    if (!workspace) {
      throw new WorkspaceDiscoveryError('Workspace discovery returned no workspace');
    }
    this.cachedWorkspace = workspace;
    return workspace;
  }
}

export function createWorkspaceScanOrchestrator(
  provider: WorkspaceProvider,
  fileSystem: FileSystemProvider,
  options?: WorkspaceScanOrchestratorOptions
): WorkspaceScanOrchestrator {
  return new WorkspaceScanOrchestrator(provider, fileSystem, options);
}
