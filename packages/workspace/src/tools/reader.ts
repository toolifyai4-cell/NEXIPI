import type { FileStat, FileSystemProvider } from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
import { IgnoreEngine } from '../ignore/ignore-engine.js';
import {
  isBinaryContent,
  isBinaryExtension,
  isSensitiveFileName,
  splitNameExtension,
  computeWorkspaceId,
  normalizePath,
  isChildOf,
  relativePath,
} from './classification.js';
import {
  defaultFileReadConfig,
  type FileReadConfig,
  safeValidateFileReadConfig,
} from './config.js';
import type { ReadFileOptions, ReadFileResult } from './contracts.js';
import { safeValidateReadFileInput } from './schemas.js';
import { ToolErrorCode, createToolError } from './errors.js';

function checkCancelled(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', { path });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

/**
 * Splits content into lines while preserving original line endings (LF and
 * CRLF). The final line without a trailing newline is included. An empty
 * string yields zero lines.
 */
function splitLinesPreserveEndings(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  const len = content.length;
  while (i < len) {
    const ch = content[i];
    if (ch === '\r') {
      if (i + 1 < len && content[i + 1] === '\n') {
        lines.push(content.slice(start, i + 2));
        i += 2;
      } else {
        lines.push(content.slice(start, i + 1));
        i += 1;
      }
      start = i;
    } else if (ch === '\n') {
      lines.push(content.slice(start, i + 1));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < len) {
    lines.push(content.slice(start));
  }
  return lines;
}

export class FileReader {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: FileReadConfig;
  private readonly workspaceId: string;

  constructor(options: {
    fileSystem: FileSystemProvider;
    workspaceFolder: WorkspaceFolder;
    config?: Partial<FileReadConfig>;
  }) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    const configValidation = safeValidateFileReadConfig(options.config ?? {});
    if (!configValidation.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid read config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
      );
    }
    this.config = { ...defaultFileReadConfig, ...configValidation.data };
    this.workspaceId = computeWorkspaceId(options.workspaceFolder.uri);
  }

  getConfig(): Readonly<FileReadConfig> {
    return { ...this.config };
  }

  async readFile(options: ReadFileOptions): Promise<ReadFileResult> {
    const input = safeValidateReadFileInput(options);
    if (!input.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid read arguments: ${input.error.issues.map(i => i.message).join(', ')}`,
        { path: options.uri }
      );
    }
    const { lineStart, lineEnd } = input.data;

    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Reversed line range: start ${lineStart} is after end ${lineEnd}`,
        { path: options.uri }
      );
    }

    checkCancelled(options.signal, options.uri);

    const absPath = normalizePath(options.uri);
    const root = normalizePath(this.workspaceFolder.uri);

    // Boundary protection: the requested path must be within the workspace root.
    if (!isChildOf(root, absPath)) {
      throw createToolError(
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE,
        `Path is outside the workspace root`,
        { path: options.uri }
      );
    }

    checkCancelled(options.signal, options.uri);

    let stat: FileStat;
    try {
      stat = await this.fileSystem.stat(absPath);
    } catch (error) {
      if (isAbortError(error)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Read cancelled', {
          path: options.uri,
        });
      }
      throw createToolError(
        ToolErrorCode.TOOL_FILE_NOT_FOUND,
        `File not found: ${error instanceof Error ? error.message : String(error)}`,
        { path: options.uri, cause: error instanceof Error ? error : undefined }
      );
    }

    checkCancelled(options.signal, options.uri);

    // Reject directories and symlinks (unless symlinks are explicitly followed).
    if (stat.type !== 'file') {
      if (stat.type === 'symbolicLink' && !this.config.followSymlinks) {
        throw createToolError(
          ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED,
          'Symbolic links are not allowed for reading',
          { path: options.uri }
        );
      }
      throw createToolError(ToolErrorCode.TOOL_NOT_A_FILE, 'Path is not a file', {
        path: options.uri,
      });
    }

    const rel = relativePath(root, absPath);
    if (rel === undefined) {
      throw createToolError(
        ToolErrorCode.TOOL_PATH_OUTSIDE_WORKSPACE,
        'Path escapes workspace root boundary',
        { path: options.uri }
      );
    }

    // Ignore-engine exclusion check (respects .gitignore and safety exclusions).
    if (this.config.respectIgnoreRules) {
      const ignoreEngine = new IgnoreEngine({
        fileSystem: this.fileSystem,
        workspaceFolder: this.workspaceFolder,
        root,
        config: {
          enableMandatorySafetyExclusions: true,
          enableDefaultExclusions: true,
          userExclusions: [],
          caseSensitive: false,
        },
      });
      try {
        await ignoreEngine.loadGitignore(root);
      } catch {
        // Unreadable gitignore must not block the read.
      }
      const exclusion = ignoreEngine.isExcluded(rel, { isDirectory: false });
      if (exclusion.ignored) {
        throw createToolError(
          ToolErrorCode.TOOL_FILE_IGNORED,
          `File is excluded by ignore rules (${exclusion.reason})`,
          { path: options.uri }
        );
      }
    }

    // Sensitive-file protection.
    if (this.config.respectSensitiveFiles) {
      const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
      const { extension } = splitNameExtension(baseName);
      if (isSensitiveFileName(baseName, extension)) {
        throw createToolError(
          ToolErrorCode.TOOL_FILE_SENSITIVE,
          'Sensitive file access is not allowed',
          { path: options.uri }
        );
      }
    }

    // Pre-read size limit enforced from stat metadata before any content is read.
    if (stat.size > this.config.maxFileSize) {
      throw createToolError(
        ToolErrorCode.TOOL_FILE_TOO_LARGE,
        `File size ${stat.size} bytes exceeds the maximum of ${this.config.maxFileSize} bytes`,
        { path: options.uri }
      );
    }

    checkCancelled(options.signal, options.uri);

    let content: string;
    try {
      content = await this.fileSystem.readFile(absPath);
    } catch (error) {
      if (isAbortError(error)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Read cancelled', {
          path: options.uri,
        });
      }
      throw createToolError(
        ToolErrorCode.TOOL_FILESYSTEM_ERROR,
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        { path: options.uri, cause: error instanceof Error ? error : undefined }
      );
    }

    checkCancelled(options.signal, options.uri);

    // Binary detection on the decoded content.
    let binary = false;
    if (this.config.enableBinaryDetection) {
      const ext = splitNameExtension(absPath.slice(absPath.lastIndexOf('/') + 1)).extension;
      binary = isBinaryExtension(ext) || isBinaryContent(content);
      if (binary) {
        throw createToolError(
          ToolErrorCode.TOOL_FILE_BINARY,
          'Binary file content is not allowed for reading',
          { path: options.uri }
        );
      }
    }

    const lines = splitLinesPreserveEndings(content);
    const totalLines = lines.length;

    // Secondary line-count safety net (files with many short lines).
    if (totalLines > this.config.maxLineCount) {
      throw createToolError(
        ToolErrorCode.TOOL_FILE_TOO_LARGE,
        `File line count ${totalLines} exceeds the maximum of ${this.config.maxLineCount} lines`,
        { path: options.uri }
      );
    }

    // Apply the requested one-based inclusive line range.
    const start = lineStart !== undefined ? lineStart : 1;
    const end = lineEnd !== undefined ? lineEnd : totalLines;

    let firstLine: number | null = null;
    let lastLine: number | null = null;
    let selected: string[] = [];

    if (start > totalLines) {
      // Range begins beyond the file: return empty content.
      selected = [];
    } else {
      const clampedEnd = Math.min(end, totalLines);
      selected = lines.slice(start - 1, clampedEnd);
      firstLine = start;
      lastLine = clampedEnd;
    }

    let returnedContent = selected.join('');
    let truncated = false;

    // Output-size limit on the returned content.
    if (returnedContent.length > this.config.maxOutputSize) {
      returnedContent = returnedContent.slice(0, this.config.maxOutputSize);
      truncated = true;
    }

    // Recompute returned line count from the (possibly truncated) content.
    const returnedLines = splitLinesPreserveEndings(returnedContent);

    return {
      kind: 'read',
      uri: options.uri,
      absolutePath: absPath,
      relativePath: rel,
      size: stat.size,
      lineCount: totalLines,
      returnedLineCount: returnedLines.length,
      firstLine,
      lastLine,
      content: returnedContent,
      truncated,
      binary: false,
      encoding: 'utf-8',
      cancelled: false,
    };
  }

  private dispose(): void {
    // No resources to release at this layer; the FileSystemProvider owns its lifecycle.
  }
}

export function createFileReader(options: {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<FileReadConfig>;
}): FileReader {
  return new FileReader(options);
}
