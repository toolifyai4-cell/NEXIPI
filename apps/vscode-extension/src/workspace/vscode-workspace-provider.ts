import * as vscode from 'vscode';
import type {
  WorkspaceFolder,
  WorkspaceFoldersChangeEvent,
  WorkspaceProvider,
  WorkspaceProviderSubscription,
} from '@nexipi/workspace';
import { createWorkspaceFolderId } from '@nexipi/workspace';

/**
 * VS Code implementation of the {@link WorkspaceProvider} abstraction.
 *
 * Exposes VS Code workspace folders as {@link WorkspaceFolder} values and
 * forwards `vscode.workspace.onDidChangeWorkspaceFolders` notifications as
 * {@link WorkspaceFoldersChangeEvent} values.
 *
 * URIs are preserved as `vscode.Uri.toString()` strings so remote / virtual
 * workspace URIs (e.g. `ssh://`, `vscode-remote://`) are handled in the same
 * way as local `file://` URIs. No assumption is made that every workspace URI
 * is a local filesystem path.
 */
export class VSCodeWorkspaceProvider implements WorkspaceProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  async getWorkspaceFolders(): Promise<readonly WorkspaceFolder[]> {
    this.throwIfDisposed();
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.map((folder, index) => toWorkspaceFolder(folder, index));
  }

  onWorkspaceFoldersChange(
    listener: (event: WorkspaceFoldersChangeEvent) => void
  ): WorkspaceProviderSubscription {
    this.throwIfDisposed();

    const disposable = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      listener({
        added: event.added.map((folder) => toWorkspaceFolder(folder, folder.index)),
        removed: event.removed.map((folder) => toWorkspaceFolder(folder, folder.index)),
        // VS Code reports folder renames as a remove + add pair; it has no
        // separate "folder changed" notification, so this stays empty here.
        changed: [],
        timestamp: Date.now(),
      });
    });

    this.disposables.push(disposable);
    return { unsubscribe: () => disposable.dispose() };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error('VSCodeWorkspaceProvider has been disposed');
    }
  }
}

function toWorkspaceFolder(folder: vscode.WorkspaceFolder, index: number): WorkspaceFolder {
  return {
    id: createWorkspaceFolderId(folder.uri.toString()),
    uri: folder.uri.toString(),
    name: folder.name,
    index,
  };
}
