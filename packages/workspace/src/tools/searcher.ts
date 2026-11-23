import type {
  DirectoryEntry,
  FileStat,
  FileSystemProvider,
} from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
import { IgnoreEngine } from '../ignore/ignore-engine.js';
import {
  isBinaryContent,
  isBinaryExtension,
  isSensitiveFileName,
  splitNameExtension,
  normalizePath,
  isChildOf,
  relativePath,
  matchesIncludePatterns,
} from './classification.js';
import { validateSymlinkFreePath } from './path-security.js';
import { defaultCodeSearchConfig, type CodeSearchConfig, safeValidateCodeSearchConfig } from './search-config.js';
import {
  CodeSearchInput,
  safeValidateCodeSearchInput,
} from './search-schemas.js';
import type {
  CodeSearchOptions,
  CodeSearchResult,
  SearchContextLine,
  SearchFileResult,
  SearchMatch,
} from './contracts.js';
import {
  ToolErrorCode,
  createToolError,
  isToolErrorCode,
} from './errors.js';
import {
  compileRestrictedRegex,
  findFirstMatch,
} from './regex-engine.js';

function checkCancelled(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Search cancelled', { path });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

function isCancelledError(error: unknown): boolean {
  return isAbortError(error) || isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED);
}

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

interface LineMatch {
  readonly index: number;
  readonly text: string;
}

type LineFinder = (segment: string) => LineMatch | null;

function buildLiteralMatcher(query: string, caseSensitive: boolean): LineFinder {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(escaped, flags);
  return (segment: string): LineMatch | null => {
    re.lastIndex = 0;
    const m = re.exec(segment);
    if (!m) {
      return null;
    }
    return { index: m.index!, text: m[0]! };
  };
}

function buildRegexFinder(
  segment: string,
  compiled: ReturnType<typeof compileRestrictedRegex>
): LineMatch | null {
  const found = findFirstMatch(segment, compiled, 0);
  if (!found) {
    return null;
  }
  return { index: found.start, text: segment.slice(found.start, found.end) };
}

function isSensitiveFile(absPath: string): boolean {
  const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
  const { extension } = splitNameExtension(baseName);
  return isSensitiveFileName(baseName, extension);
}

function isBinaryByExtension(absPath: string): boolean {
  const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
  const { extension } = splitNameExtension(baseName);
  return isBinaryExtension(extension);
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }
  return line.slice(0, maxLength);
}

function isWordBoundary(line: string, start: number, end: number): boolean {
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  // A word boundary exists at a position when the word-ness changes across it,
  // treating out-of-bounds as non-word.
  const boundaryAt = (pos: number): boolean => {
    const prev = pos === 0 ? false : isWord(line[pos - 1]);
    const curr = pos === line.length ? false : isWord(line[pos]);
    return prev !== curr;
  };
  return boundaryAt(start) && boundaryAt(end);
}

function buildContext(lines: string[], matchIndex: number, ctx: number): SearchContextLine[] {
  const result: SearchContextLine[] = [];
  const start = Math.max(0, matchIndex - ctx);
  const end = Math.min(lines.length, matchIndex + ctx + 1);
  for (let i = start; i < end; i++) {
    if (i === matchIndex) {
      continue;
    }
    result.push({ lineNumber: i + 1, text: lines[i]! });
  }
  return result;
}

export class CodeSearcher {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: CodeSearchConfig;
  private readonly workspaceId: string;

  constructor(options: {
    fileSystem: FileSystemProvider;
    workspaceFolder: WorkspaceFolder;
    config?: Partial<CodeSearchConfig>;
  }) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    const configValidation = safeValidateCodeSearchConfig(options.config ?? {});
    if (!configValidation.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid search config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
      );
    }
    this.config = { ...defaultCodeSearchConfig, ...configValidation.data };
    this.workspaceId = computeWorkspaceId(options.workspaceFolder.uri);
  }

  getConfig(): Readonly<CodeSearchConfig> {
    return { ...this.config };
  }

  async search(options: CodeSearchOptions): Promise<CodeSearchResult> {
    const input = safeValidateCodeSearchInput(options);
    if (!input.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid search arguments: ${input.error.issues.map(i => i.message).join(', ')}`,
        { path: options.workspaceFolder?.uri }
      );
    }
    if (!options.workspaceFolder || !options.workspaceFolder.uri) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        'workspaceFolder.uri is required',
        { path: undefined }
      );
    }
    const { query, mode, caseSensitive, wholeWord, contextLines, includePatterns, excludePatterns } = input.data;

    if (query.length > this.config.maxQueryLength) {
      throw createToolError(
        ToolErrorCode.TOOL_QUERY_TOO_LONG,
        `Query length ${query.length} exceeds the maximum of ${this.config.maxQueryLength} characters`,
        { path: options.workspaceFolder.uri }
      );
    }

    checkCancelled(options.signal, options.workspaceFolder.uri);

    const absRoot = normalizePath(this.workspaceFolder.uri);

    checkCancelled(options.signal, options.workspaceFolder.uri);

    // Validate that the workspace root itself is symlink-free.
    let rootStat: FileStat;
    try {
      rootStat = await validateSymlinkFreePath(this.fileSystem, absRoot, absRoot, options.signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Search cancelled', {
          path: options.workspaceFolder.uri,
        });
      }
      throw createToolError(
        ToolErrorCode.TOOL_FILESYSTEM_ERROR,
        `Unable to verify workspace root safely: ${error instanceof Error ? error.message : String(error)}`,
        { path: options.workspaceFolder.uri, cause: error instanceof Error ? error : undefined }
      );
    }
    if (rootStat.type !== 'directory') {
      throw createToolError(ToolErrorCode.TOOL_NOT_A_DIRECTORY, 'Workspace root is not a directory', {
        path: options.workspaceFolder.uri,
      });
    }

    checkCancelled(options.signal, options.workspaceFolder.uri);

    const ignoreEngine = new IgnoreEngine({
      fileSystem: this.fileSystem,
      workspaceFolder: this.workspaceFolder,
      root: absRoot,
      config: {
        enableMandatorySafetyExclusions: true,
        enableDefaultExclusions: true,
        userExclusions: [],
        caseSensitive: false,
      },
    });
    try {
      await ignoreEngine.loadGitignore(absRoot);
    } catch {
      // Unreadable gitignore must not block the search.
    }

    // Compile regex once if needed.
    let compiledRegex: ReturnType<typeof compileRestrictedRegex> | undefined;
    if (mode === 'regex') {
      try {
        compiledRegex = compileRestrictedRegex(query, caseSensitive ?? false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw createToolError(
          message.includes('unsupported') || message.includes('not supported') || message.includes('exceeds')
            ? ToolErrorCode.TOOL_UNSUPPORTED_REGEX
            : ToolErrorCode.TOOL_INVALID_REGEX,
          `Invalid regular expression: ${message}`,
          { path: options.workspaceFolder.uri }
        );
      }
    }

    const literalMatch = mode === 'literal' ? buildLiteralMatcher(query, caseSensitive ?? false) : undefined;

    // Collect candidate files deterministically (sorted traversal).
    const candidates: Array<{ absPath: string; relPath: string; stat: FileStat }> = [];
    const errors: Array<{ path: string; message: string; isFatal: boolean }> = [];
    let candidateTruncated = false;

    await this.traverseForCandidates(
      absRoot,
      '',
      ignoreEngine,
      candidates,
      errors,
      includePatterns,
      excludePatterns,
      options.signal,
      {
        get truncated() {
          return candidateTruncated;
        },
        set truncated(v: boolean) {
          candidateTruncated = v;
        },
      }
    );

    checkCancelled(options.signal, options.workspaceFolder.uri);

    const maxCandidateFiles = this.config.maxCandidateFiles;
    if (candidates.length > maxCandidateFiles) {
      candidates.length = maxCandidateFiles;
      candidateTruncated = true;
    }

    // Search each candidate file.
    const files: SearchFileResult[] = [];
    let filesSearched = 0;
    let filesSkipped = 0;
    let totalMatches = 0;
    let totalBytesRead = 0;
    let truncated = candidateTruncated;
    let limitReached:
      | 'maxCandidateFiles'
      | 'maxTotalBytesRead'
      | 'maxTotalResults'
      | 'maxOutputSize'
      | undefined = candidateTruncated ? 'maxCandidateFiles' : undefined;
    let cancelled = false;
    let completed = false;

    try {
      for (const candidate of candidates) {
        if (cancelled) {
          break;
        }
        checkCancelled(options.signal, candidate.absPath);

        const relPath = candidate.relPath;

        // Sensitive-file protection.
        if (this.config.respectSensitiveFiles && isSensitiveFile(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'sensitive'));
          continue;
        }

        // Binary-file protection by extension.
        if (this.config.respectBinaryFiles && isBinaryByExtension(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'binary'));
          continue;
        }

        // Ignore-rule protection (.gitignore, default, mandatory, user).
        if (this.config.respectIgnoreRules && ignoreEngine.isExcluded(relPath, { isDirectory: false }).ignored) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'ignored'));
          continue;
        }

        // Pre-read size limit from stat metadata.
        if (candidate.stat.size > this.config.maxFileSize) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          continue;
        }

        // Total bytes-read budget.
        if (totalBytesRead + candidate.stat.size > this.config.maxTotalBytesRead) {
          truncated = true;
          limitReached = 'maxTotalBytesRead';
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          break;
        }

        let content: string;
        try {
          content = await this.fileSystem.readFile(candidate.absPath);
        } catch (error) {
          if (isCancelledError(error)) {
            cancelled = true;
            break;
          }
          // A single file read failure does not terminate the whole search.
          filesSkipped++;
          errors.push({
            path: candidate.absPath,
            message: error instanceof Error ? error.message : String(error),
            isFatal: false,
          });
          files.push(makeSkippedFileResult(candidate, 'readError'));
          continue;
        }

        totalBytesRead += Buffer.byteLength(content, 'utf8');
        checkCancelled(options.signal, candidate.absPath);

        // Binary detection on decoded content.
        let binary = false;
        if (this.config.respectBinaryFiles) {
          const ext = splitNameExtension(candidate.absPath.slice(candidate.absPath.lastIndexOf('/') + 1)).extension;
          binary = isBinaryExtension(ext) || isBinaryContent(content);
          if (binary) {
            filesSkipped++;
            files.push(makeSkippedFileResult(candidate, 'binary'));
            continue;
          }
        }

        const fileResult = this.searchFile(
          candidate.absPath,
          relPath,
          content,
          mode,
          caseSensitive ?? false,
          wholeWord ?? false,
          contextLines,
          literalMatch,
          compiledRegex,
          options.signal
        );

        filesSearched++;
        totalMatches += fileResult.matchCount;
        if (fileResult.truncated) {
          truncated = true;
        }
        files.push(fileResult);

        // Total results limit.
        if (totalMatches >= this.config.maxTotalResults) {
          truncated = true;
          limitReached = 'maxTotalResults';
          break;
        }

        // Output-size budget (approximate, based on accumulated payload).
        if (estimateOutputSize(files) > this.config.maxOutputSize) {
          truncated = true;
          limitReached = 'maxOutputSize';
          break;
        }
      }
      completed = !cancelled;
    } catch (error) {
      if (isCancelledError(error)) {
        cancelled = true;
        completed = false;
      } else {
        errors.push({
          path: absRoot,
          message: error instanceof Error ? error.message : String(error),
          isFatal: true,
        });
        completed = false;
      }
    }

    return {
      kind: 'search',
      uri: options.workspaceFolder.uri,
      absolutePath: absRoot,
      relativePath: '',
      mode,
      query,
      caseSensitive: caseSensitive ?? false,
      wholeWord: wholeWord ?? false,
      files,
      filesSearched,
      filesSkipped,
      totalMatches,
      truncated,
      limitReached,
      cancelled,
      completed,
      errors,
    };
  }

  private async traverseForCandidates(
    absDir: string,
    relDir: string,
    ignoreEngine: IgnoreEngine,
    candidates: Array<{ absPath: string; relPath: string; stat: FileStat }>,
    errors: Array<{ path: string; message: string; isFatal: boolean }>,
    includePatterns: readonly string[] | undefined,
    excludePatterns: readonly string[] | undefined,
    signal: AbortSignal | undefined,
    state: { get truncated(): boolean; set truncated(v: boolean) }
  ): Promise<void> {
    if (state.truncated) {
      return;
    }
    checkCancelled(signal, absDir);

    if (!isChildOf(normalizePath(this.workspaceFolder.uri), absDir)) {
      errors.push({ path: absDir, message: 'Path escapes workspace root boundary', isFatal: false });
      return;
    }

    let directoryEntries: readonly DirectoryEntry[];
    try {
      directoryEntries = await this.fileSystem.readDirectory(absDir);
    } catch (error) {
      errors.push({ path: absDir, message: error instanceof Error ? error.message : String(error), isFatal: false });
      return;
    }

    const sorted = [...directoryEntries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (state.truncated) {
        return;
      }
      checkCancelled(signal, absDir);

      if (entry.name.startsWith('.')) {
        continue;
      }

      const absEntry = `${absDir}/${entry.name}`;
      const relEntry = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;

      // Boundary check per entry.
      if (!isChildOf(normalizePath(this.workspaceFolder.uri), absEntry)) {
        errors.push({ path: absEntry, message: 'Entry escapes workspace root boundary', isFatal: false });
        continue;
      }

      // Symbolic links are never followed or traversed.
      if (entry.type === 'symbolicLink') {
        continue;
      }

      if (entry.type === 'directory') {
        if (ignoreEngine.isExcluded(relEntry, { isDirectory: true }).ignored) {
          continue;
        }
        await this.traverseForCandidates(
          absEntry,
          relEntry,
          ignoreEngine,
          candidates,
          errors,
          includePatterns,
          excludePatterns,
          signal,
          state
        );
        continue;
      }

      if (entry.type === 'file') {
        if (ignoreEngine.isExcluded(relEntry, { isDirectory: false }).ignored) {
          continue;
        }
        if (includePatterns && includePatterns.length > 0 && !matchesIncludePatterns(relEntry, includePatterns)) {
          continue;
        }
        if (excludePatterns && excludePatterns.length > 0 && matchesIncludePatterns(relEntry, excludePatterns)) {
          continue;
        }
        let fileStat: FileStat;
        try {
          fileStat = await this.fileSystem.stat(absEntry);
        } catch (error) {
          errors.push({ path: absEntry, message: error instanceof Error ? error.message : String(error), isFatal: false });
          continue;
        }
        candidates.push({ absPath: absEntry, relPath: relEntry, stat: fileStat });
        if (candidates.length >= this.config.maxCandidateFiles) {
          state.truncated = true;
          return;
        }
        continue;
      }
    }
  }

  private searchFile(
    absPath: string,
    relPath: string,
    content: string,
    mode: 'literal' | 'regex',
    caseSensitive: boolean,
    wholeWord: boolean,
    contextLines: number | undefined,
    literalMatch: LineFinder | undefined,
    compiledRegex: ReturnType<typeof compileRestrictedRegex> | undefined,
    signal: AbortSignal | undefined
  ): SearchFileResult {
    const maxMatchesPerFile = this.config.maxMatchesPerFile;
    const maxContextLines = this.config.maxContextLines;
    const ctx = contextLines !== undefined ? Math.min(contextLines, maxContextLines) : 0;
    const maxLineLength = this.config.maxLineLength;

    const lines = splitLinesPreserveEndings(content);
    const matches: SearchMatch[] = [];
    let truncated = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      checkCancelled(signal, absPath);
      if (matches.length >= maxMatchesPerFile) {
        truncated = true;
        break;
      }
      let line = lines[lineIndex]!;
      if (line.length > maxLineLength) {
        line = truncateLine(line, maxLineLength);
      }

      const finder: LineFinder = mode === 'literal' ? literalMatch! : (l) => buildRegexFinder(l, compiledRegex!);

      let searchFrom = 0;
      while (searchFrom <= line.length) {
        checkCancelled(signal, absPath);
        if (matches.length >= maxMatchesPerFile) {
          truncated = true;
          break;
        }
        const segment = line.slice(searchFrom);
        const result = finder(segment);
        if (!result) {
          break;
        }
        const matchStart = searchFrom + result.index;
        const matchText = result.text;
        const matchEnd = matchStart + matchText.length;

        // Guard against zero-length matches to avoid infinite loops.
        if (matchEnd <= matchStart) {
          searchFrom = matchStart + 1;
          continue;
        }

        // Whole-word check.
        if (wholeWord && !isWordBoundary(line, matchStart, matchEnd)) {
          searchFrom = matchEnd;
          continue;
        }

        matches.push({
          lineNumber: lineIndex + 1,
          startColumn: matchStart,
          endColumn: matchEnd,
          matchedText: matchText,
          context: ctx > 0 ? buildContext(lines, lineIndex, ctx) : undefined,
        });

        searchFrom = matchEnd;
      }
      if (truncated) {
        break;
      }
    }

    return {
      uri: `file:///${absPath.replace(/^\/+/, '')}`,
      absolutePath: absPath,
      relativePath: relPath,
      matches,
      matchCount: matches.length,
      truncated,
      skipped: false,
      skipReason: undefined,
    };
  }
}

function makeSkippedFileResult(
  candidate: { absPath: string; relPath: string; stat: FileStat },
  reason: SearchFileResult['skipReason']
): SearchFileResult {
  return {
    uri: `file:///${candidate.absPath.replace(/^\/+/, '')}`,
    absolutePath: candidate.absPath,
    relativePath: candidate.relPath,
    matches: [],
    matchCount: 0,
    truncated: false,
    skipped: true,
    skipReason: reason,
  };
}

function estimateOutputSize(files: readonly SearchFileResult[]): number {
  let size = 0;
  for (const f of files) {
    for (const m of f.matches) {
      size += m.matchedText.length + String(m.lineNumber).length + String(m.startColumn).length + String(m.endColumn).length;
      if (m.context) {
        for (const c of m.context) {
          size += c.text.length + String(c.lineNumber).length;
        }
      }
    }
    size += f.relativePath.length + f.absolutePath.length;
  }
  return size;
}

function computeWorkspaceId(uri: string): string {
  const normalized = uri.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

export function createCodeSearcher(options: {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<CodeSearchConfig>;
}): CodeSearcher {
  return new CodeSearcher(options);
}
