import { createLogger, type Logger } from '@nexipi/core';
import type {
  WorkspaceProvider,
  WorkspaceFoldersChangeEvent,
  WorkspaceProviderSubscription,
  FileSystemProvider,
} from './workspace-provider.js';
import type {
  Workspace,
  WorkspaceFolder,
  WorkspaceFolderId,
  WorkspaceChangeEvent,
} from '../types.js';
import type { WorkspaceEventEmitter } from '../events/workspace-events.js';
import type { WorkspaceDiscoveryConfig } from '../config.js';
import { createWorkspaceFolderId } from '../types.js';

export interface WorkspaceDiscoveryOptions {
  provider: WorkspaceProvider;
  fileSystem: FileSystemProvider;
  config?: Partial<WorkspaceDiscoveryConfig>;
  logger?: Logger;
  eventEmitter?: WorkspaceEventEmitter;
}

export class WorkspaceDiscovery {
  private readonly provider: WorkspaceProvider;
  private readonly fileSystem: FileSystemProvider;
  private readonly config: WorkspaceDiscoveryConfig;
  private readonly logger: Logger;
  private readonly eventEmitter: WorkspaceEventEmitter;
  private currentWorkspace: Workspace | null = null;
  private subscription: WorkspaceProviderSubscription | null = null;
  private disposed = false;

  constructor(options: WorkspaceDiscoveryOptions) {
    this.provider = options.provider;
    this.fileSystem = options.fileSystem;
    this.config = {
      enabled: true,
      maxDepth: 3,
      includeHidden: false,
      followSymlinks: false,
      workspaceLessMode: 'temporary',
      ...options.config,
    };
    this.logger = options.logger ?? createLogger({ name: 'workspace-discovery', version: '0.0.1', logLevel: 'info' });
    this.eventEmitter = options.eventEmitter ?? createWorkspaceEventEmitter();
  }

  private get createWorkspaceEventEmitter(): () => WorkspaceEventEmitter {
    return () => {
      const { createEventEmitter } = require('@nexipi/core');
      return createEventEmitter<import('../events/workspace-events.js').WorkspaceEventMap>();
    };
  }

  async initialize(): Promise<Workspace> {
    if (this.disposed) {
      throw new Error('WorkspaceDiscovery has been disposed');
    }

    const folders = await this.provider.getWorkspaceFolders();
    const workspace = this.buildWorkspace(folders);
    this.currentWorkspace = workspace;

    this.subscription = this.provider.onWorkspaceFoldersChange((event) => {
      this.handleWorkspaceChange(event);
    });

    this.logger.info('Workspace discovered', {
      folderCount: workspace.folders.length,
      isMultiRoot: workspace.isMultiRoot,
      workspaceId: workspace.id,
    });

    this.eventEmitter.emit('workspace:discovered', { workspace, timestamp: Date.now() });
    return workspace;
  }

  getCurrentWorkspace(): Workspace | null {
    return this.currentWorkspace;
  }

  getEventEmitter(): WorkspaceEventEmitter {
    return this.eventEmitter;
  }

  private buildWorkspace(folders: readonly WorkspaceFolder[]): Workspace {
    const sortedFolders = [...folders].sort((a, b) => a.index - b.index);
    const folderUris = sortedFolders.map((f) => this.normalizeUri(f.uri));
    const workspaceId = this.computeWorkspaceId(folderUris);

    const workspaceFolders: WorkspaceFolder[] = sortedFolders.map((folder, index) => ({
      ...folder,
      id: createWorkspaceFolderId(this.computeFolderId(folder.uri, workspaceId)),
      index,
    }));

    return {
      folders: workspaceFolders,
      isMultiRoot: workspaceFolders.length > 1,
      id: workspaceId,
      timestamp: Date.now(),
    };
  }

  private normalizeUri(uri: string): string {
    return uri.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  }

  private computeFolderId(uri: string, workspaceId: string): string {
    const normalized = this.normalizeUri(uri);
    let hash = 0;
    const str = `${workspaceId}:${normalized}`;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `folder_${Math.abs(hash).toString(36)}`;
  }

  private computeWorkspaceId(folderUris: readonly string[]): string {
    const sorted = [...folderUris].sort();
    const combined = sorted.join('|');
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `ws_${Math.abs(hash).toString(36)}`;
  }

  private handleWorkspaceChange(event: WorkspaceFoldersChangeEvent): void {
    if (this.disposed || !this.currentWorkspace) {
      return;
    }

    const previousWorkspace = this.currentWorkspace;
    const allFolders = new Map<string, WorkspaceFolder>();

    for (const folder of previousWorkspace.folders) {
      allFolders.set(folder.uri, folder);
    }

    const changeEvents: WorkspaceChangeEvent[] = [];

    for (const folder of event.removed) {
      const removed = allFolders.get(folder.uri);
      if (removed) {
        allFolders.delete(folder.uri);
        changeEvents.push({
          type: 'removed',
          folder: removed,
          timestamp: event.timestamp,
        });
      }
    }

    for (const folder of event.added) {
      allFolders.set(folder.uri, folder);
      changeEvents.push({
        type: 'added',
        folder,
        timestamp: event.timestamp,
      });
    }

    for (const folder of event.changed) {
      const previous = allFolders.get(folder.uri);
      allFolders.set(folder.uri, folder);
      if (previous) {
        changeEvents.push({
          type: 'changed',
          folder,
          previousFolder: previous,
          timestamp: event.timestamp,
        });
      }
    }

    const newFolders = Array.from(allFolders.values()).sort((a, b) => a.index - b.index);
    const newWorkspace = this.buildWorkspace(newFolders);
    this.currentWorkspace = newWorkspace;

    for (const changeEvent of changeEvents) {
      this.eventEmitter.emit('workspace:changed', { event: changeEvent, timestamp: event.timestamp });
      this.logger.info('Workspace folder changed', {
        type: changeEvent.type,
        folderUri: changeEvent.folder.uri,
        workspaceId: newWorkspace.id,
      });
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.currentWorkspace = null;
    this.logger.info('WorkspaceDiscovery disposed');
  }
}

function createWorkspaceEventEmitter(): WorkspaceEventEmitter {
  const { createEventEmitter } = require('@nexipi/core');
  return createEventEmitter<import('../events/workspace-events.js').WorkspaceEventMap>();
}