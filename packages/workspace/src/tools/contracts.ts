import type { DiscoveryError } from '../types.js';
import type { FileReadConfig } from './config.js';
import type { DirectoryListConfig } from './config.js';
import type { CodeSearchConfig } from './search-config.js';

/**
 * Kind of read/search/list tool supported in Phase 09.
 */
export type ToolKind = 'read' | 'list' | 'search';

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
 * A single match within a searched file.
 *
 * Line numbers are one-based. Columns are zero-based, with `startColumn`
 * inclusive and `endColumn` exclusive. `matchedText` is the exact substring
 * that matched (possibly truncated for very long matches).
 */
export interface SearchMatch {
  readonly lineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly matchedText: string;
  /** Surrounding context lines (before and after the match), if requested. */
  readonly context: readonly SearchContextLine[] | undefined;
}

/** A single context line surrounding a match. */
export interface SearchContextLine {
  readonly lineNumber: number;
  readonly text: string;
}

/**
 * The result of searching a single file.
 */
export interface SearchFileResult {
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly matches: readonly SearchMatch[];
  readonly matchCount: number;
  /** Whether per-file match limit was reached for this file. */
  readonly truncated: boolean;
  /** Whether the file was skipped and not searched. */
  readonly skipped: boolean;
  /** Reason the file was skipped, if any. */
  readonly skipReason: 'binary' | 'sensitive' | 'tooLarge' | 'readError' | 'ignored' | undefined;
}

/**
 * Structured result of a code search.
 */
export interface CodeSearchResult {
  readonly kind: 'search';
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly mode: 'literal' | 'regex';
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly files: readonly SearchFileResult[];
  readonly filesSearched: number;
  readonly filesSkipped: number;
  readonly totalMatches: number;
  /** Whether any resource limit caused truncation. */
  readonly truncated: boolean;
  /** Which limit was reached, if any. */
  readonly limitReached: 'maxCandidateFiles' | 'maxTotalBytesRead' | 'maxTotalResults' | 'maxOutputSize' | undefined;
  readonly cancelled: boolean;
  readonly completed: boolean;
  readonly errors: readonly DiscoveryError[];
}

/**
 * Options for searching workspace source files.
 */
export interface CodeSearchOptions {
  readonly workspaceFolder: { readonly uri: string; readonly id: string };
  readonly query: string;
  readonly mode: 'literal' | 'regex';
  readonly caseSensitive?: boolean | undefined;
  readonly wholeWord?: boolean | undefined;
  /** Number of context lines to include around each match. */
  readonly contextLines?: number | undefined;
  readonly includePatterns?: readonly string[] | undefined;
  readonly excludePatterns?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly config?: Partial<CodeSearchConfig> | undefined;
}

/**
 * Union of tool results returned by Phase 09 capabilities.
 */
export type ToolResult = ReadFileResult | ListDirectoryResult | CodeSearchResult;
