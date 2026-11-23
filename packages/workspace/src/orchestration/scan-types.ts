import { z } from 'zod';
import type { EventMap, EventName, Logger } from '@nexipi/core';
import type {
  WorkspaceFolderId,
  FileMetadata,
  DiscoveryError,
  ProjectRoot,
} from '../types.js';
import type { WorkspaceScanConfig } from '../config.js';

/**
 * Unique identifier for a scan.
 */
export type ScanId = string & { readonly __brand: unique symbol };

export function createScanId(id: string): ScanId {
  return id as ScanId;
}

/**
 * Deterministic scan lifecycle states.
 *
 * Transitions:
 *   idle -> queued -> scanning -> completed
 *   idle -> cancelled            (cancel before start)
 *   queued -> scanning           (dequeued)
 *   queued -> cancelled          (cancel while queued)
 *   scanning -> cancelling       (cancel during execution)
 *   scanning -> completed        (success)
 *   scanning -> failed           (error)
 *   cancelling -> cancelled      (cancellation finished)
 *   * -> disposed                (terminal, from any non-disposed state)
 *
 * A cancelled or failed scan is never reported as completed.
 */
export type ScanState =
  | 'idle'
  | 'queued'
  | 'scanning'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'disposed';

export const ScanStateSchema = z.enum([
  'idle',
  'queued',
  'scanning',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'disposed',
]);

export function isTerminalScanState(state: ScanState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed' || state === 'disposed';
}

export function isActiveScanState(state: ScanState): boolean {
  return state === 'queued' || state === 'scanning' || state === 'cancelling';
}

export function isCompletedScanState(state: ScanState): boolean {
  return state === 'completed';
}

export function isCancelledScanState(state: ScanState): boolean {
  return state === 'cancelled';
}

export function isFailedScanState(state: ScanState): boolean {
  return state === 'failed';
}

/**
 * Progress stages reported during a scan. Stage-based (no fabricated
 * percentages) because the total workload is unknown up front.
 */
export type ScanStage =
  | 'initializing'
  | 'discovering-workspace'
  | 'analyzing-projects'
  | 'discovering-files'
  | 'collecting-metadata'
  | 'applying-exclusions'
  | 'updating-scan-results'
  | 'completed'
  | 'cancelled'
  | 'failed';

/**
 * File change types supported by incremental refresh.
 */
export type FileChangeType = 'created' | 'changed' | 'deleted' | 'renamed';

export interface FileChange {
  readonly type: FileChangeType;
  readonly absolutePath: string;
  readonly previousAbsolutePath?: string;
  readonly workspaceFolderId?: WorkspaceFolderId;
  readonly timestamp: number;
}

export interface FileChangeNotification {
  readonly changes: readonly FileChange[];
  readonly workspaceId: string;
  readonly timestamp: number;
}

/**
 * Typed progress event emitted throughout a scan. No sensitive file contents
 * or credentials are ever included in the payload.
 */
export interface ScanProgress {
  readonly scanId: ScanId;
  readonly workspaceId: string;
  readonly workspaceFolderId?: WorkspaceFolderId;
  readonly state: ScanState;
  readonly stage: ScanStage;
  readonly operation: string;
  readonly directoriesProcessed: number;
  readonly filesDiscovered: number;
  readonly filesExcluded: number;
  readonly errors: readonly DiscoveryError[];
  readonly startTime: number;
  readonly elapsedTime: number | null;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly timestamp: number;
}

export interface ScanProgressOutput extends Omit<ScanProgress, 'scanId' | 'workspaceFolderId'> {
  readonly scanId: string;
  readonly workspaceFolderId?: string;
}

/**
 * Result of scanning a single workspace folder. Errors are isolated per
 * folder so one folder's failure does not abort the whole scan.
 */
export interface FolderScanResult {
  readonly workspaceFolderId: WorkspaceFolderId;
  readonly workspaceFolderUri: string;
  readonly files: readonly FileMetadata[];
  readonly count: number;
  readonly directoriesProcessed: number;
  readonly filesExcluded: number;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly errors: readonly DiscoveryError[];
}

/**
 * Complete scan result produced only after a successful full scan.
 */
export interface ScanResult {
  readonly scanId: ScanId;
  readonly workspaceId: string;
  readonly state: ScanState;
  readonly stage: ScanStage;
  readonly files: readonly FileMetadata[];
  readonly count: number;
  readonly projectRoots: readonly ProjectRoot[];
  readonly truncated: boolean;
  readonly cancelled: boolean;
  readonly completed: boolean;
  readonly failed: boolean;
  readonly errors: readonly DiscoveryError[];
  readonly folderResults: readonly FolderScanResult[];
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
}

/**
 * Result of an incremental refresh operation.
 */
export interface IncrementalRefreshResult {
  readonly applied: boolean;
  readonly requiresFullScan: boolean;
  readonly changesProcessed: number;
  readonly filesAdded: number;
  readonly filesChanged: number;
  readonly filesRemoved: number;
  readonly errors: readonly IncrementalError[];
  readonly timestamp: number;
}

export interface IncrementalError {
  readonly change: FileChange;
  readonly message: string;
  readonly isFatal: boolean;
}

/**
 * Typed events emitted by the orchestrator. Follows the same conventions as
 * `WorkspaceEventMap`.
 */
export interface ScanEventMap extends EventMap {
  'scan:progress': { progress: ScanProgress; timestamp: number };
  'scan:state-changed': {
    scanId: ScanId;
    previousState: ScanState;
    newState: ScanState;
    timestamp: number;
  };
  'scan:started': { scanId: ScanId; workspaceId: string; timestamp: number };
  'scan:completed': { scanId: ScanId; result: ScanResult; timestamp: number };
  'scan:cancelled': { scanId: ScanId; timestamp: number };
  'scan:failed': { scanId: ScanId; error: Error; context: string; timestamp: number };
}

export type ScanEventName = EventName & keyof ScanEventMap;

export interface ScanEventEmitter {
  on<T extends ScanEventName>(
    eventName: T,
    listener: (payload: ScanEventMap[T]) => void | Promise<void>
  ): { unsubscribe(): void };
  off<T extends ScanEventName>(
    eventName: T,
    listener: (payload: ScanEventMap[T]) => void | Promise<void>
  ): boolean;
  emit<T extends ScanEventName>(eventName: T, payload: ScanEventMap[T]): void;
  emitAsync<T extends ScanEventName>(eventName: T, payload: ScanEventMap[T]): Promise<void[]>;
  listenerCount(eventName: ScanEventName): number;
  removeAllListeners(eventName?: ScanEventName): void;
}

/**
 * Input to `startFullScan` / `startFolderScan`.
 */
export interface ScanOptions {
  readonly workspaceId?: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * Status snapshot returned by `getStatus`.
 */
export interface OrchestratorStatus {
  readonly state: ScanState;
  readonly currentScanId: ScanId | null;
  readonly activeScanCount: number;
  readonly queuedScanCount: number;
  readonly disposed: boolean;
}

/**
 * Options accepted by the orchestrator constructor.
 */
export interface WorkspaceScanOrchestratorOptions {
  readonly config?: Partial<WorkspaceScanConfig>;
  readonly logger?: Logger;
}

export interface ValidatedWorkspaceScanConfig extends WorkspaceScanConfig {}

export function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isPathUnderRoot(root: string, candidate: string): boolean {
  const r = normalizeAbsolutePath(root);
  const c = normalizeAbsolutePath(candidate);
  return c === r || c.startsWith(`${r}/`);
}
