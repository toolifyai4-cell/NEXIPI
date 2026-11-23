import type { DiscoveryError } from '../types.js';
import type { FileStat, FileSystemProvider } from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
import { CodeSearcher } from './searcher.js';
import {
  isBinaryContent,
  isBinaryExtension,
  isSensitiveFileName,
  splitNameExtension,
  normalizePath,
  isChildOf,
  detectLanguage,
} from './classification.js';
import { validateSymlinkFreePath } from './path-security.js';
import { defaultReferenceConfig, type ReferenceConfig, safeValidateReferenceConfig } from './reference-config.js';
import {
  safeValidateReferenceDiscoveryInput,
  type ReferenceDiscoveryInput,
} from './reference-schemas.js';
import type {
  ReferenceClassification,
  ReferenceConfidence,
  ReferenceDiscoveryResult,
  ReferenceFileResult,
  ReferenceLanguage,
  ReferenceOccurrence,
} from './reference-contracts.js';
import { ToolErrorCode, createToolError, isToolErrorCode } from './errors.js';

/**
 * Identifier-boundary policy.
 *
 * Columns are measured in UTF-16 code units, consistent with JavaScript string
 * indexing and the existing CodeSearcher. A surrogate pair therefore occupies
 * two column positions.
 *
 * An identifier character is:
 * - an ASCII letter (`A-Za-z`), digit (`0-9`), underscore (`_`), or dollar sign
 *   (`$`); or
 * - any non-ASCII character (code unit >= 0x80), treated conservatively as an
 *   identifier character so that Unicode identifiers are not split.
 *
 * All other characters (whitespace, punctuation, operators, brackets, etc.)
 * are non-identifier characters and form a boundary.
 *
 * A match of `symbol` at [start, end) within a line is a valid identifier
 * occurrence only when:
 * - start === 0 or the character before start is not an identifier character,
 *   and
 * - end === line.length or the character at end is not an identifier character.
 *
 * This is a language-neutral, conservative policy. It does not perfectly model
 * every programming language's identifier rules, and it never infers a
 * definition, declaration, call, import, export, or semantic usage from text
 * alone. Matches are always reported with classification `textual_match` and
 * confidence `low`.
 */
function isIdentifierChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    code >= 0x80 ||
    /[A-Za-z0-9_$]/.test(ch)
  );
}

function isIdentifierBoundary(line: string, start: number, end: number): boolean {
  if (start > 0 && isIdentifierChar(line.charAt(start - 1))) {
    return false;
  }
  if (end < line.length && isIdentifierChar(line.charAt(end))) {
    return false;
  }
  return true;
}

/**
 * Returns true when `symbol` is a valid identifier query under the boundary
 * policy. A valid query is non-empty, consists only of identifier characters,
 * and does not start with a digit (identifiers in the supported languages do
 * not begin with a digit).
 *
 * Arbitrary expressions such as `foo.bar()` are rejected because they contain
 * non-identifier characters.
 */
function isValidIdentifierQuery(symbol: string): boolean {
  if (symbol.length === 0) {
    return false;
  }
  if (/[0-9]/.test(symbol.charAt(0))) {
    return false;
  }
  for (let i = 0; i < symbol.length; i++) {
    if (!isIdentifierChar(symbol.charAt(i))) {
      return false;
    }
  }
  return true;
}

const REFERENCE_LANGUAGES = new Set<ReferenceLanguage>([
  'javascript',
  'typescript',
  'python',
  'java',
  'csharp',
  'go',
  'rust',
  'cpp',
  'c',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'scala',
  'shell',
  'powershell',
  'sql',
  'html',
  'css',
  'json',
  'xml',
  'yaml',
  'markdown',
  'text',
]);

function isSupportedReferenceLanguage(language: string | null): language is ReferenceLanguage {
  return language !== null && REFERENCE_LANGUAGES.has(language as ReferenceLanguage);
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

/**
 * Approximate output size of the accumulated result payload, mirroring the
 * estimation approach used by CodeSearcher so limit enforcement is consistent.
 */
function estimateOutputSize(files: readonly ReferenceFileResult[]): number {
  let size = 0;
  for (const f of files) {
    size += f.relativePath.length + f.absolutePath.length;
    for (const r of f.references) {
      size +=
        r.matchedText.length +
        String(r.lineNumber).length +
        String(r.startColumn).length +
        String(r.endColumn).length +
        r.symbol.length +
        r.language.length;
    }
  }
  return size;
}

export interface LexicalFinderOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<ReferenceConfig>;
}

export class LexicalFinder {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: ReferenceConfig;
  private readonly searcher: CodeSearcher;

  constructor(options: LexicalFinderOptions) {
    const configValidation = safeValidateReferenceConfig(options.config ?? {});
    if (!configValidation.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid reference config: ${configValidation.error.issues.map(i => i.message).join(', ')}`
      );
    }
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    this.config = { ...defaultReferenceConfig, ...configValidation.data };
    this.searcher = new CodeSearcher({
      fileSystem: options.fileSystem,
      workspaceFolder: options.workspaceFolder,
    });
  }

  getConfig(): Readonly<ReferenceConfig> {
    return { ...this.config };
  }

  /**
   * Performs a lexical identifier search across eligible workspace source
   * files. Every occurrence is reported with classification `textual_match`
   * and confidence `low`.
   */
  async find(options: {
    symbol: string;
    classifications?: readonly ReferenceClassification[] | undefined;
    languages?: readonly ReferenceLanguage[] | undefined;
    includePatterns?: readonly string[] | undefined;
    excludePatterns?: readonly string[] | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ReferenceDiscoveryResult> {
    const inputValidation = safeValidateReferenceDiscoveryInput({
      symbol: options.symbol,
      classifications: options.classifications,
      languages: options.languages,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      maxFilesExamined: this.config.maxFilesExamined,
      maxTotalBytesRead: this.config.maxTotalBytesRead,
      maxReferencesPerFile: this.config.maxReferencesPerFile,
      maxTotalReferences: this.config.maxTotalReferences,
      maxOutputSize: this.config.maxOutputSize,
      enableLexicalFallback: this.config.enableLexicalFallback,
    });
    if (!inputValidation.success) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Invalid reference arguments: ${inputValidation.error.issues.map(i => i.message).join(', ')}`,
        { path: options.symbol !== undefined ? this.workspaceFolder.uri : undefined }
      );
    }

    const input: ReferenceDiscoveryInput = inputValidation.data;

    // Lexical fallback must be enabled for this finder to produce matches.
    if (input.enableLexicalFallback === false) {
      return this.emptyResult(input.symbol, input.languages, false, false);
    }

    // Reject symbol queries that are not valid identifiers before any I/O.
    if (!isValidIdentifierQuery(input.symbol)) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Symbol is not a valid identifier: ${JSON.stringify(input.symbol)}`,
        { path: this.workspaceFolder.uri }
      );
    }

    // Enforce the configured maximum symbol length.
    if (input.symbol.length > this.config.maxSymbolLength) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Symbol length ${input.symbol.length} exceeds the maximum of ${this.config.maxSymbolLength} characters`,
        { path: this.workspaceFolder.uri }
      );
    }

    // If a classifications filter is provided and it excludes textual_match,
    // this finder cannot produce any results.
    if (
      input.classifications !== undefined &&
      input.classifications.length > 0 &&
      !input.classifications.includes('textual_match')
    ) {
      return this.emptyResult(input.symbol, input.languages, false, false);
    }

    checkCancelled(options.signal, this.workspaceFolder.uri);

    const absRoot = normalizePath(this.workspaceFolder.uri);

    // Validate the workspace root itself is symlink-free and within bounds.
    let rootStat: FileStat;
    try {
      rootStat = await validateSymlinkFreePath(this.fileSystem, absRoot, absRoot, options.signal);
    } catch (error) {
      if (isAbortError(error) || isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Reference discovery cancelled', {
          path: this.workspaceFolder.uri,
        });
      }
      throw createToolError(
        ToolErrorCode.TOOL_FILESYSTEM_ERROR,
        `Unable to verify workspace root safely: ${error instanceof Error ? error.message : String(error)}`,
        { path: this.workspaceFolder.uri, cause: error instanceof Error ? error : undefined }
      );
    }
    if (rootStat.type !== 'directory') {
      throw createToolError(ToolErrorCode.TOOL_NOT_A_DIRECTORY, 'Workspace root is not a directory', {
        path: this.workspaceFolder.uri,
      });
    }

    // Reuse CodeSearcher for candidate discovery (traversal, ignore engine,
    // include/exclude filtering, symlink safety, workspace boundary).
    let { candidates, truncated: candidateTruncated } = await this.searcher.getCandidates({
      includePatterns: input.includePatterns,
      excludePatterns: input.excludePatterns,
      signal: options.signal,
    });

    const maxFilesExamined = this.config.maxFilesExamined;
    const maxFileSize = this.config.maxFileSize;
    const maxTotalBytesRead = this.config.maxTotalBytesRead;
    const maxReferencesPerFile = this.config.maxReferencesPerFile;
    const maxTotalReferences = this.config.maxTotalReferences;
    const maxOutputSize = this.config.maxOutputSize;
    const languageFilter = input.languages;

    const files: ReferenceFileResult[] = [];
    const errors: DiscoveryError[] = [];
    let filesExamined = 0;
    let filesSkipped = 0;
    let totalReferences = 0;
    let totalBytesRead = 0;
    let truncated = candidateTruncated;
    let limitReached:
      | 'maxFilesExamined'
      | 'maxTotalBytesRead'
      | 'maxReferencesPerFile'
      | 'maxTotalReferences'
      | 'maxOutputSize'
      | undefined = candidateTruncated ? 'maxFilesExamined' : undefined;
    let cancelled = false;
    let completed = false;

    try {
      for (const candidate of candidates) {
        if (cancelled || truncated) {
          break;
        }
        checkCancelled(options.signal, candidate.absPath);

        // Maximum files examined.
        if (filesExamined >= maxFilesExamined) {
          truncated = true;
          limitReached = 'maxFilesExamined';
          break;
        }

        const relPath = candidate.relPath;

        // Sensitive-file protection.
        if (isSensitiveFile(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'sensitive'));
          continue;
        }

        // Binary-file protection by extension (pre-read).
        if (isBinaryByExtension(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'binary'));
          continue;
        }

        // Pre-read size limit from stat metadata.
        if (candidate.stat.size > maxFileSize) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          continue;
        }

        // Total bytes-read budget (pre-read).
        if (totalBytesRead + candidate.stat.size > maxTotalBytesRead) {
          truncated = true;
          limitReached = 'maxTotalBytesRead';
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          break;
        }

        // Language detection from extension; skip files whose language cannot
        // be determined or is not representable in the reference contract.
        const baseName = candidate.absPath.slice(candidate.absPath.lastIndexOf('/') + 1);
        const { extension } = splitNameExtension(baseName);
        const detected = detectLanguage(extension);
        if (!isSupportedReferenceLanguage(detected)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'unsupportedLanguage'));
          continue;
        }

        // Language filter.
        if (languageFilter !== undefined && languageFilter.length > 0 && !languageFilter.includes(detected)) {
          continue;
        }

        let content: string;
        try {
          content = await this.fileSystem.readFile(candidate.absPath);
        } catch (error) {
          if (isAbortError(error) || isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED)) {
            cancelled = true;
            break;
          }
          // A single file read failure does not terminate the whole query.
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
        const binary = isBinaryExtension(extension) || isBinaryContent(content);
        if (binary) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'binary'));
          continue;
        }

        const references = scanFileForReferences(content, input.symbol, candidate, maxReferencesPerFile);
        if (references.truncated) {
          truncated = true;
          limitReached = 'maxReferencesPerFile';
        }
        filesExamined++;
        totalReferences += references.count;
        files.push(references.result);

        // Maximum total references.
        if (totalReferences >= maxTotalReferences) {
          truncated = true;
          limitReached = 'maxTotalReferences';
          break;
        }

        // Maximum output size (approximate).
        if (estimateOutputSize(files) > maxOutputSize) {
          truncated = true;
          limitReached = 'maxOutputSize';
          break;
        }
      }
      completed = !cancelled && !truncated;
    } catch (error) {
      if (isAbortError(error) || isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED)) {
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

    // Deterministic ordering: relative path, then line number, then start column.
    files.sort((a, b) => {
      const relCmp = a.relativePath.localeCompare(b.relativePath);
      if (relCmp !== 0) {
        return relCmp;
      }
      return 0;
    });

    const resultLanguage =
      languageFilter !== undefined && languageFilter.length === 1
        ? languageFilter[0]
        : undefined;

    const result: ReferenceDiscoveryResult = {
      kind: 'reference-discovery',
      uri: this.workspaceFolder.uri,
      absolutePath: absRoot,
      relativePath: '',
      symbol: input.symbol,
      language: resultLanguage,
      files,
      metadata: {
        filesExamined,
        filesSkipped,
        totalReferences,
        truncated,
        limitReached,
        cancelled,
        completed,
      },
      errors,
    };
    return result;
  }

  private emptyResult(
    symbol: string,
    languages: readonly ReferenceLanguage[] | undefined,
    cancelled: boolean,
    completed: boolean
  ): ReferenceDiscoveryResult {
    return {
      kind: 'reference-discovery',
      uri: this.workspaceFolder.uri,
      absolutePath: normalizePath(this.workspaceFolder.uri),
      relativePath: '',
      symbol,
      language:
        languages !== undefined && languages.length === 1 ? languages[0] : undefined,
      files: [],
      metadata: {
        filesExamined: 0,
        filesSkipped: 0,
        totalReferences: 0,
        truncated: false,
        limitReached: undefined,
        cancelled,
        completed,
      },
      errors: [],
    };
  }
}

/**
 * Scans a single file's content for identifier-boundary matches of `symbol`.
 * Returns the per-file result and whether the per-file limit was reached.
 */
function scanFileForReferences(
  content: string,
  symbol: string,
  candidate: { readonly absPath: string; readonly relPath: string },
  maxReferencesPerFile: number
): {
  readonly result: ReferenceFileResult;
  readonly count: number;
  readonly truncated: boolean;
} {
  const lines = splitLinesPreserveEndings(content);
  const references: ReferenceOccurrence[] = [];
  let truncated = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (references.length >= maxReferencesPerFile) {
      truncated = true;
      break;
    }
    const line = lines[lineIndex]!;
    const symbolLen = symbol.length;
    let searchFrom = 0;

    while (searchFrom <= line.length) {
      if (references.length >= maxReferencesPerFile) {
        truncated = true;
        break;
      }
      const index = line.indexOf(symbol, searchFrom);
      if (index === -1) {
        break;
      }
      const start = index;
      const end = index + symbolLen;

      if (isIdentifierBoundary(line, start, end)) {
        references.push({
          uri: `file:///${candidate.absPath.replace(/^\/+/, '')}`,
          absolutePath: candidate.absPath,
          relativePath: candidate.relPath,
          lineNumber: lineIndex + 1,
          startColumn: start,
          endColumn: end,
          matchedText: symbol,
          classification: 'textual_match',
          confidence: 'low',
          language: detectLanguageFromPath(candidate.absPath),
          symbol,
        });
      }

      searchFrom = index + 1;
    }

    if (truncated) {
      break;
    }
  }

  return {
    result: {
      uri: `file:///${candidate.absPath.replace(/^\/+/, '')}`,
      absolutePath: candidate.absPath,
      relativePath: candidate.relPath,
      language: detectLanguageFromPath(candidate.absPath),
      references,
      referenceCount: references.length,
      truncated,
      skipped: false,
      skipReason: undefined,
    },
    count: references.length,
    truncated,
  };
}

function detectLanguageFromPath(absPath: string): ReferenceLanguage {
  const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
  const { extension } = splitNameExtension(baseName);
  const detected = detectLanguage(extension);
  return isSupportedReferenceLanguage(detected) ? detected : 'text';
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

function checkCancelled(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Reference discovery cancelled', { path });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

function makeSkippedFileResult(
  candidate: { absPath: string; relPath: string; stat: FileStat },
  reason: ReferenceFileResult['skipReason']
): ReferenceFileResult {
  const language = detectLanguageFromPath(candidate.absPath);
  return {
    uri: `file:///${candidate.absPath.replace(/^\/+/, '')}`,
    absolutePath: candidate.absPath,
    relativePath: candidate.relPath,
    language,
    references: [],
    referenceCount: 0,
    truncated: false,
    skipped: true,
    skipReason: reason,
  };
}

export function createLexicalFinder(options: LexicalFinderOptions): LexicalFinder {
  return new LexicalFinder(options);
}
