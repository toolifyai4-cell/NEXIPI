import type { DiscoveryError } from '../types.js';
import type { FileReadConfig } from './config.js';
import type { DirectoryListConfig } from './config.js';

/**
 * Kind of read/search tool supported in Phase 09 Stage B.
 */
export type ToolKind = 'read' | 'list';

/**
 * Structured result of reading a file.
 *
 * Line numbers are one-based and inclusive. `content` is the (possibly
 * truncated or range-limited) text. `size` is the actual file size in bytes
 * as reported by the filesystem, independent of `content` length.
 */
export interface ReadFileResult {
  readonly kind: 'read';
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  /** Actual file size in bytes (pre-read stat). */
  readonly size: number;
  /** Total number of lines in the file. */
  readonly lineCount: number;
  /** Number of lines returned in `content`. */
  readonly returnedLineCount: number;
  /** One-based index of the first returned line. */
  readonly firstLine: number | null;
  /** One-based index of the last returned line. */
  readonly lastLine: number | null;
  /** File content (UTF-8), possibly truncated or range-limited. */
  readonly content: string;
  readonly truncated: boolean;
  /** Whether content was detected as binary. */
  readonly binary: boolean;
  /** Encoding used to decode the file. */
  readonly encoding: 'utf-8';
  readonly cancelled: boolean;
}

/**
 * Options for reading a single file.
 */
export interface ReadFileOptions {
  readonly uri: string;
  readonly workspaceFolder: { readonly uri: string; readonly id: string };
  /** One-based inclusive start line. Omitted to read from line 1. */
  readonly lineStart?: number | undefined;
  /** One-based inclusive end line. Omitted to read to the last line. */
  readonly lineEnd?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly config?: Partial<FileReadConfig> | undefined;
}

/**
 * A single directory-listing entry.
 */
export interface DirectoryListingEntry {
  readonly relativePath: string;
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symbolicLink';
  readonly size: number | undefined;
  readonly mtime: number | null;
  readonly language: string | null;
  readonly category: string;
  readonly isBinary: boolean;
  readonly isSensitive: boolean;
  readonly isIgnored: boolean;
}

/**
 * Structured result of listing a directory.
 */
export interface ListDirectoryResult {
  readonly kind: 'list';
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly entries: readonly DirectoryListingEntry[];
  readonly count: number;
  readonly truncated: boolean;
  readonly cancelled: boolean;
  readonly completed: boolean;
  readonly errors: readonly DiscoveryError[];
}

/**
 * Options for listing a directory.
 */
export interface ListDirectoryOptions {
  readonly uri: string;
  readonly workspaceFolder: { readonly uri: string; readonly id: string };
  readonly recursive?: boolean | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxEntries?: number | undefined;
  readonly filterByType?: 'file' | 'directory' | 'all' | undefined;
  /** Optional simple patterns matched against relative path. See matchPattern. */
  readonly includePatterns?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly config?: Partial<DirectoryListConfig> | undefined;
}

/**
 * Union of tool results returned by Stage B capabilities.
 */
export type ToolResult = ReadFileResult | ListDirectoryResult;
