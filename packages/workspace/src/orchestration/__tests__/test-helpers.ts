import type {
  FileSystemProvider,
  DirectoryEntry,
  FileStat,
  WorkspaceProvider,
  WorkspaceProviderSubscription,
  WorkspaceFoldersChangeEvent,
} from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';
import { WorkspaceScanOrchestrator } from '../workspace-scan-orchestrator.js';
import type { ScanProgress, ScanResult, WorkspaceScanOrchestratorOptions } from '../scan-types.js';

export function makeEntry(name: string, type: DirectoryEntry['type']): DirectoryEntry {
  return { name, type };
}

export function makeWorkspaceFolder(
  uri: string,
  name: string,
  index: number = 0
): WorkspaceFolder {
  return {
    id: createWorkspaceFolderId(uri),
    uri,
    name,
    index,
  };
}

export interface StatLike {
  type: 'file' | 'directory' | 'symbolicLink';
  size: number;
  mtime: number;
}

export class VirtualFileSystem implements FileSystemProvider {
  private readonly rootPath: string;
  private readonly files = new Map<string, string>();
  private readonly dirs = new Map<string, DirectoryEntry[]>();
  private readonly stats = new Map<string, FileStat & { ctime: number }>();
  private readDirectoryGate: { resolve: () => void; promise: Promise<void> } | null = null;

  constructor(tree: Record<string, unknown>, rootUri: string = 'file:///root') {
    this.rootPath = rootUri
      .replace(/\\/g, '/')
      .replace(/^file:\/\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    this.build(tree, this.rootPath);
  }

  private build(node: Record<string, unknown>, prefix: string): void {
    const entries: DirectoryEntry[] = [];
    for (const [key, value] of Object.entries(node)) {
      const full = prefix.length > 0 ? `${prefix}/${key}` : key;
      if (typeof value === 'string') {
        entries.push(makeEntry(key, 'file'));
        this.files.set(full, value);
        this.stats.set(full, { type: 'file', size: value.length, mtime: Date.now(), ctime: Date.now() });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        entries.push(makeEntry(key, 'directory'));
        this.stats.set(full, { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() });
        this.build(value as Record<string, unknown>, full);
      }
    }
    this.dirs.set(prefix, entries);
  }

  setStat(path: string, stat: StatLike): void {
    const key = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    this.stats.set(key, { ...stat, ctime: stat.mtime });
  }

  setReadDirectoryGate(): { promise: Promise<void>; release: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    resolve = resolve!;
    this.readDirectoryGate = { resolve, promise };
    return { promise, release: () => this.readDirectoryGate?.resolve() };
  }

  releaseReadDirectoryGate(): void {
    this.readDirectoryGate?.resolve();
    this.readDirectoryGate = null;
  }

  async readFile(uri: string): Promise<string> {
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const content = this.files.get(key);
    if (content === undefined) {
      throw new Error(`File not found: ${key}`);
    }
    return content;
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    if (this.readDirectoryGate) {
      await this.readDirectoryGate.promise;
    }
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const base = this.dirs.get(key) ?? [];
    if (base.length === 0 && !this.dirs.has(key)) {
      return [];
    }
    return base.map((e) => {
      return { ...e };
    });
  }

  async stat(uri: string): Promise<FileStat> {
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const stat = this.stats.get(key);
    if (!stat) {
      throw new Error(`Stat not found: ${key}`);
    }
    return { type: stat.type, size: stat.size, mtime: stat.mtime, ctime: stat.ctime };
  }

  async exists(uri: string): Promise<boolean> {
    const key = uri.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return this.files.has(key) || this.dirs.has(key);
  }
}

export function makeProvider(folders: readonly WorkspaceFolder[]): WorkspaceProvider {
  const listeners = new Set<(event: WorkspaceFoldersChangeEvent) => void>();
  return {
    getWorkspaceFolders: () => Promise.resolve([...folders]),
    onWorkspaceFoldersChange(listener: (event: WorkspaceFoldersChangeEvent) => void): WorkspaceProviderSubscription {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    dispose(): void {
      listeners.clear();
    },
  };
}

export function createTestOrchestrator(
  provider: WorkspaceProvider,
  fileSystem: FileSystemProvider,
  options?: WorkspaceScanOrchestratorOptions
): WorkspaceScanOrchestrator {
  return new WorkspaceScanOrchestrator(provider, fileSystem, options);
}

export interface CapturedEvents<T> {
  events: T[];
  unsubscribe(): void;
}

export function captureEvents<T>(
  orchestrator: WorkspaceScanOrchestrator,
  eventName: 'scan:progress' | 'scan:state-changed' | 'scan:started' | 'scan:completed' | 'scan:cancelled' | 'scan:failed'
): CapturedEvents<T> {
  const events: T[] = [];
  const sub = orchestrator.on(eventName, (payload: unknown) => {
    events.push(payload as T);
  });
  return { events, unsubscribe: () => sub.unsubscribe() };
}

export function waitForEvent<T>(
  orchestrator: WorkspaceScanOrchestrator,
  eventName: 'scan:progress' | 'scan:state-changed' | 'scan:started' | 'scan:completed' | 'scan:cancelled' | 'scan:failed',
  predicate?: (payload: T) => boolean
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sub = orchestrator.on(eventName, (payload: unknown) => {
      let target: unknown = payload;
      if (target !== null && typeof target === 'object' && 'progress' in target) {
        target = (target as { readonly progress: unknown }).progress;
      }
      const p = target as T;
      if (!predicate || predicate(p)) {
        sub.unsubscribe();
        resolve(p);
      }
    });
    setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`Timed out waiting for event ${eventName}`));
    }, 5000);
  });
}

/**
 * Starts a scan with the VFS read-directory gate closed so the scan blocks at
 * project analysis (the gate blocks `readDirectory`, which manifest discovery
 * needs). Resolves once the `analyzing-projects` progress stage has been
 * emitted (it is emitted before the blocking await). Returns the scan promise
 * and a `release` function to open the gate and let the scan continue.
 */
export async function startScanBlockedAtAnalysis(
  orchestrator: WorkspaceScanOrchestrator,
  vfs: VirtualFileSystem,
  startScan: () => Promise<ScanResult>
): Promise<{ promise: Promise<ScanResult>; release: () => void }> {
  const gate = vfs.setReadDirectoryGate();
  const promise = startScan();
  await waitForEvent<ScanProgress>(orchestrator, 'scan:progress', (e) => e.stage === 'analyzing-projects');
  return { promise, release: () => gate.release() };
}

export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

export async function waitForCondition(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Flush the microtask queue so in-progress async setup (e.g. scan enqueueing) completes. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
