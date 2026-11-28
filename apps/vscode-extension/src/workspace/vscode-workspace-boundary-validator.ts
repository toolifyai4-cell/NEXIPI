import * as vscode from 'vscode';
import type { WorkspaceFolder } from '@nexipi/workspace';
import type { FileSystemProvider } from '@nexipi/workspace';
import { validateWorkspaceBoundary, validateSymlinkFreePath, normalizePath } from '@nexipi/workspace';
import type { WorkspaceBoundaryValidator } from '@nexipi/models/tools';

export class VSCodeWorkspaceBoundaryValidator implements WorkspaceBoundaryValidator {
  constructor(
    private readonly workspaceAdapters: Map<string, { folder: WorkspaceFolder }>,
    private readonly fileSystem: FileSystemProvider
  ) {}

  async validate(workingDirectory: string, workspaceId: string): Promise<void> {
    const adapterSet = this.workspaceAdapters.get(workspaceId);
    if (adapterSet === undefined) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const folderUri = adapterSet.folder.uri;
    const targetUri = vscode.Uri.file(workingDirectory).toString();

    // Lexical boundary check: target must resolve inside the workspace root.
    validateWorkspaceBoundary(folderUri, targetUri);

    // Symlink check: walk from workspace root to target without following symlinks.
    const root = normalizePath(folderUri);
    const target = normalizePath(workingDirectory);
    await validateSymlinkFreePath(this.fileSystem, root, target, undefined);
  }
}