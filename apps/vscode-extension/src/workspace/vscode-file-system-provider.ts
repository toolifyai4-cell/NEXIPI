import * as vscode from 'vscode';
import type {
  DirectoryEntry,
  FileStat,
  FileSystemProvider,
} from '@nexipi/workspace';

/**
 * VS Code implementation of the {@link FileSystemProvider} abstraction.
 *
 * Bridges VS Code's `vscode.workspace.fs` API to the workspace package's
 * filesystem abstraction. URIs are accepted either as full `vscode.Uri`
 * strings (e.g. `file:///root/a.ts`) or as scheme-stripped absolute paths
 * (e.g. `/root/a.ts`); scheme-stripped paths are reconstituted as `file://`
 * URIs before being handed to VS Code so that remote / virtual URIs pass
 * through unchanged.
 */
export class VSCodeFileSystemProvider implements FileSystemProvider {
  async readFile(uri: string): Promise<string> {
    const data = await vscode.workspace.fs.readFile(toVsCodeUri(uri));
    return Buffer.from(data).toString('utf8');
  }

  async readDirectory(uri: string): Promise<readonly DirectoryEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(toVsCodeUri(uri));
    return entries.map(([name, type]) => ({
      name,
      type: toDirectoryEntryType(type),
    }));
  }

  async stat(uri: string): Promise<FileStat> {
    const stat = await vscode.workspace.fs.stat(toVsCodeUri(uri));
    return {
      type: toFileStatType(stat.type),
      size: stat.size,
      mtime: stat.mtime,
      ctime: stat.ctime,
    };
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(toVsCodeUri(uri));
      return true;
    } catch {
      return false;
    }
  }
}

function toVsCodeUri(uri: string): vscode.Uri {
  const parsed = vscode.Uri.parse(uri);
  if (parsed.scheme && parsed.scheme !== '') {
    return parsed;
  }
  // Scheme-stripped absolute path (the workspace package's internal
  // convention). Reconstitute a file:// URI so VS Code can resolve it.
  return vscode.Uri.parse('file://' + uri);
}

function toDirectoryEntryType(type: vscode.FileType): DirectoryEntry['type'] {
  switch (type) {
    case vscode.FileType.File:
      return 'file';
    case vscode.FileType.Directory:
      return 'directory';
    case vscode.FileType.SymbolicLink:
      return 'symbolicLink';
    default:
      return 'file';
  }
}

function toFileStatType(type: vscode.FileType): FileStat['type'] {
  return toDirectoryEntryType(type);
}
