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
  /**
   * Returns file status without following symbolic links.
   *
   * When `uri` is a symbolic link, the returned `FileStat.type` MUST be
   * `'symbolicLink'`. Providers whose underlying filesystem API follows
   * symlinks by default (e.g. `stat`) MUST implement this by inspecting the
   * link itself rather than its target. If a provider cannot reliably
   * determine whether the path is a symbolic link without following it, it
   * MUST throw an error so callers can fail closed.
   */
  lstat(uri: string): Promise<FileStat>;
  exists(uri: string): Promise<boolean>;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symbolicLink';
}

export interface FileStat {
  /**
   * Entry type. For `lstat`, this reports the link itself (`'symbolicLink'`)
   * when the path is a symbolic link, never the link's target. For `stat`,
   * providers may follow symlinks and report the target type; callers that
   * must not follow symlinks should use `lstat` instead.
   */
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
    typeof (obj as FileSystemProvider).lstat === 'function' &&
    typeof (obj as FileSystemProvider).exists === 'function'
  );
}