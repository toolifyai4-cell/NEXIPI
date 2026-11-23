import type { WorkspaceFolder } from '../types.js';

export interface WorkspaceProvider {
  getWorkspaceFolders(): Promise<readonly WorkspaceFolder[]>;
  onWorkspaceFoldersChange(listener: (event: WorkspaceFoldersChangeEvent) => void): WorkspaceProviderSubscription;
  dispose(): void;
}

export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[];
  readonly removed: readonly WorkspaceFolder[];
  readonly changed: readonly WorkspaceFolder[];
  readonly timestamp: number;
}

export interface WorkspaceProviderSubscription {
  unsubscribe(): void;
}

export interface FileSystemProvider {
  readFile(uri: string): Promise<string>;
  readDirectory(uri: string): Promise<readonly DirectoryEntry[]>;
  stat(uri: string): Promise<FileStat>;
  exists(uri: string): Promise<boolean>;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symbolicLink';
}

export interface FileStat {
  readonly type: 'file' | 'directory' | 'symbolicLink';
  readonly size: number;
  readonly mtime: number;
  readonly ctime: number;
}

export function isFileSystemProvider(obj: unknown): obj is FileSystemProvider {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as FileSystemProvider).readFile === 'function' &&
    typeof (obj as FileSystemProvider).readDirectory === 'function' &&
    typeof (obj as FileSystemProvider).stat === 'function' &&
    typeof (obj as FileSystemProvider).exists === 'function'
  );
}