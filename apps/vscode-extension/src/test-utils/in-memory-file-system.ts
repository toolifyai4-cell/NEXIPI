import type { FileSystemProvider, FileStat } from '@nexipi/workspace';

type FileType = 'file' | 'directory' | 'symbolicLink';
const FileTypeValues = {
  File: 'file' as FileType,
  Directory: 'directory' as FileType,
  SymbolicLink: 'symbolicLink' as FileType,
} as const;

/**
 * In-memory filesystem provider for testing.
 * Simulates a VS Code filesystem with basic file operations.
 */
export class InMemoryFileSystemProvider implements FileSystemProvider {
  private files = new Map<string, { content: Uint8Array; mtime: number; type: FileType }>();
  private directories = new Set<string>();

  constructor() {
    // Ensure root directory exists
    this.directories.add('/');
  }

  private normalizePath(path: string): string {
    // Remove file:// prefix if present
    let normalized = path.replace(/^file:\/\//, '');
    // Normalize path separators
    normalized = normalized.replace(/\\/g, '/');
    // Remove trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  private ensureDirectory(path: string): void {
    const parts = path.split('/').filter(p => p.length > 0);
    let current = '/';
    this.directories.add(current);
    for (const part of parts) {
      current = current === '/' ? `/${part}` : `${current}/${part}`;
      this.directories.add(current);
    }
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const normalized = this.normalizePath(path);
    this.ensureDirectory(normalized.substring(0, normalized.lastIndexOf('/')) || '/');
    const contentBytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.set(normalized, {
      content: contentBytes,
      mtime: Date.now(),
      type: FileTypeValues.File,
    });
  }

  readFile(path: string): Uint8Array {
    const normalized = this.normalizePath(path);
    const file = this.files.get(normalized);
    if (!file) {
      const error = new Error(`File not found: ${normalized}`) as any;
      error.code = 'ENOENT';
      throw error;
    }
    return file.content;
  }

  deleteFile(path: string): void {
    const normalized = this.normalizePath(path);
    this.files.delete(normalized);
  }

  createDirectory(path: string): void {
    const normalized = this.normalizePath(path);
    this.directories.add(normalized);
    this.ensureDirectory(normalized);
  }

  readDirectory(path: string): [string, FileType][] {
    const normalized = this.normalizePath(path);
    if (!this.directories.has(normalized)) {
      const error = new Error(`Directory not found: ${normalized}`) as any;
      error.code = 'ENOENT';
      throw error;
    }
    
    const entries: [string, FileType][] = [];
    const prefix = normalized === '/' ? '' : `${normalized}/`;
    const prefixLen = prefix.length;
    
    // Check files
    for (const [filePath, fileInfo] of this.files.entries()) {
      if (filePath.startsWith(prefix)) {
        const relative = filePath.substring(prefixLen);
        if (!relative.includes('/')) {
          entries.push([relative, fileInfo.type]);
        }
      }
    }
    
    // Check subdirectories
    for (const dirPath of this.directories) {
      if (dirPath !== normalized && dirPath.startsWith(prefix)) {
        const relative = dirPath.substring(prefixLen);
        if (!relative.includes('/')) {
          entries.push([relative, FileTypeValues.Directory]);
        }
      }
    }
    
    return entries;
  }

  stat(path: string): FileStat {
    const normalized = this.normalizePath(path);
    
    if (this.files.has(normalized)) {
      const file = this.files.get(normalized)!;
      return {
        type: file.type,
        ctime: file.mtime,
        mtime: file.mtime,
        size: file.content.length,
        permissions: 0o644,
      };
    }
    
    if (this.directories.has(normalized)) {
      return {
        type: FileTypeValues.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
        permissions: 0o755,
      };
    }
    
    const error = new Error(`Not found: ${normalized}`) as any;
    error.code = 'ENOENT';
    throw error;
  }

  lstat(path: string): FileStat {
    return this.stat(path);
  }

  exists(path: string): boolean {
    const normalized = this.normalizePath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  isSymbolicLink(path: string): boolean {
    return false;
  }

  readSymbolicLink(path: string): string {
    throw new Error('Symbolic links not supported');
  }

  dispose(): void {
    this.files.clear();
    this.directories.clear();
    this.directories.add('/');
  }
}