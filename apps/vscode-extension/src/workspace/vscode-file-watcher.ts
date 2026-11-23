import * as vscode from 'vscode';

/**
 * A normalized filesystem watch event produced by {@link VSCodeFileWatcher}.
 *
 * `absolutePath` is preserved as a `vscode.Uri.toString()` string so remote /
 * virtual URIs are handled the same way as local `file://` URIs.
 */
export interface FileWatchEvent {
  readonly type: 'created' | 'changed' | 'deleted' | 'renamed';
  readonly absolutePath: string;
  readonly previousAbsolutePath?: string;
  readonly timestamp: number;
}

/**
 * Callback subscribed to watcher events.
 */
export type FileWatchListener = (event: FileWatchEvent) => void;

/**
 * Handle returned by {@link VSCodeFileWatcher.onEvent}.
 */
export interface FileWatchSubscription {
  dispose(): void;
}

/**
 * VS Code implementation of a filesystem watcher.
 *
 * Wraps `vscode.workspace.createFileSystemWatcher` and forwards VS Code's
 * separate create / change / delete / rename event streams as normalized
 * {@link FileWatchEvent} values. Rename events are surfaced through VS Code's
 * `onDidRename` API as `renamed` events carrying `previousAbsolutePath`; no
 * rename API is invented in the workspace domain package.
 */
/**
 * Shape of the rename-capable file system watcher. The installed
 * `@types/vscode` does not declare `FileSystemWatcher.onDidRename`, but the
 * VS Code API provides it at runtime, so we access it defensively through a
 * structural cast rather than inventing a domain-level rename API.
 */
interface RenameCapableFileSystemWatcher extends vscode.FileSystemWatcher {
  onDidRename?: (
    listener: (e: { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }) => unknown
  ) => vscode.Disposable;
}

export class VSCodeFileWatcher {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly listeners = new Set<FileWatchListener>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(baseUri: vscode.Uri) {
    const glob = new vscode.RelativePattern(baseUri, '**');
    this.watcher = vscode.workspace.createFileSystemWatcher(glob);

    const emit = (type: FileWatchEvent['type'], uri: vscode.Uri, previousUri?: vscode.Uri): void => {
      if (this.disposed) {
        return;
      }
      const event: FileWatchEvent = {
        type,
        absolutePath: uri.toString(),
        ...(previousUri ? { previousAbsolutePath: previousUri.toString() } : {}),
        timestamp: Date.now(),
      };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Listener errors must not break other watcher listeners.
        }
      }
    };

    const renameCapable = this.watcher as unknown as RenameCapableFileSystemWatcher;

    this.disposables.push(
      this.watcher.onDidCreate((uri) => emit('created', uri)),
      this.watcher.onDidChange((uri) => emit('changed', uri)),
      this.watcher.onDidDelete((uri) => emit('deleted', uri))
    );

    // VS Code exposes a separate rename event API; handle it when available.
    if (typeof renameCapable.onDidRename === 'function') {
      this.disposables.push(
        renameCapable.onDidRename(({ oldUri, newUri }) => emit('renamed', newUri, oldUri))
      );
    }
  }

  /**
   * Subscribe to watcher events. Returns a subscription that removes the
   * listener when disposed.
   */
  onEvent(listener: FileWatchListener): FileWatchSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.listeners.clear();
    this.watcher.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
