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
  detectLanguage,
} from './classification.js';
import { defaultReferenceConfig, type ReferenceConfig, safeValidateReferenceConfig } from './reference-config.js';
import {
  safeValidateReferenceDiscoveryInput,
  type ReferenceDiscoveryInput,
} from './reference-schemas.js';
import type {
  ReferenceDiscoveryOptions,
  ReferenceDiscoveryResult,
  ReferenceFileResult,
  ReferenceLanguage,
  ReferenceOccurrence,
} from './reference-contracts.js';
import { ToolErrorCode, createToolError, isToolErrorCode } from './errors.js';
import { scanFileForReferences as scanLexicalFile } from './lexical-finder.js';
import { scanFileForReferences as scanSyntaxFile } from './syntax-aware-finder.js';
import * as ts from 'typescript';

/**
 * Languages for which syntax-aware (AST) classification is available.
 */
function isSyntaxAwareLanguage(language: ReferenceLanguage): boolean {
  return language === 'javascript' || language === 'typescript';
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

function isValidIdentifierQuery(symbol: string): boolean {
  if (symbol.length === 0) {
    return false;
  }
  if (/[0-9]/.test(symbol.charAt(0))) {
    return false;
  }
  for (let i = 0; i < symbol.length; i++) {
    const ch = symbol.charAt(i);
    const code = ch.charCodeAt(0);
    const isIdentifierChar = code >= 0x80 || /[A-Za-z0-9_$]/.test(ch);
    if (!isIdentifierChar) {
      return false;
    }
  }
  return true;
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

function detectLanguageFromPath(absPath: string): ReferenceLanguage {
  const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
  const { extension } = splitNameExtension(baseName);
  const detected = detectLanguage(extension);
  return isSupportedReferenceLanguage(detected) ? detected : 'text';
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

/**
 * Approximate output size of the accumulated result payload, mirroring the
 * estimation approach used by LexicalFinder and SyntaxAwareFinder so limit
 * enforcement is consistent across the unified query.
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

function scriptKindFromExtension(extension: string): ts.ScriptKind | undefined {
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default:
      return undefined;
  }
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

function isCancelledError(error: unknown): boolean {
  return isAbortError(error) || isToolErrorCode(error, ToolErrorCode.TOOL_CANCELLED);
}

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

/**
 * Options for constructing a `ReferenceDiscoverer`.
 */
export interface ReferenceDiscovererOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<ReferenceConfig>;
}

/**
 * Unified reference-discovery orchestrator.
 *
 * Selects the appropriate existing finder per candidate file based on language:
 * JavaScript and TypeScript are handed to `SyntaxAwareFinder` (AST
 * classifications, `confidence: 'medium'`); every other supported language is
 * handed to `LexicalFinder` (`classification: 'textual_match'`,
 * `confidence: 'low'`); unsupported languages are reported as skipped and are
 * never passed to either finder.
 *
 * Candidate enumeration is performed exactly once (a single workspace
 * traversal) and each file is dispatched to exactly one finder, so no file is
 * processed by both finders and global limits are enforced as a single shared
 * budget rather than independent per-finder budgets.
 */
export class ReferenceDiscoverer {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: ReferenceConfig;
  private readonly searcher: CodeSearcher;

  constructor(options: ReferenceDiscovererOptions) {
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
   * Performs a unified reference-discovery query across eligible workspace
   * source files, selecting the appropriate finder per file language.
   */
  async find(options: ReferenceDiscoveryOptions): Promise<ReferenceDiscoveryResult> {
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

    if (!isValidIdentifierQuery(input.symbol)) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Symbol is not a valid identifier: ${JSON.stringify(input.symbol)}`,
        { path: this.workspaceFolder.uri }
      );
    }

    if (input.symbol.length > this.config.maxSymbolLength) {
      throw createToolError(
        ToolErrorCode.TOOL_INVALID_ARGUMENT,
        `Symbol length ${input.symbol.length} exceeds the maximum of ${this.config.maxSymbolLength} characters`,
        { path: this.workspaceFolder.uri }
      );
    }

    checkCancelled(options.signal, this.workspaceFolder.uri);

    const absRoot = normalizePath(this.workspaceFolder.uri);

    // Shared candidate enumeration: a single traversal for the whole query.
    const { candidates, truncated: candidatesTruncated } = await this.searcher.getCandidates({
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
    const enableLexicalFallback = this.config.enableLexicalFallback;

    const files: ReferenceFileResult[] = [];
    const errors: DiscoveryError[] = [];
    let filesExamined = 0;
    let filesSkipped = 0;
    let totalReferences = 0;
    let totalBytesRead = 0;
    let truncated = candidatesTruncated;
    let limitReached:
      | 'maxCandidateFiles'
      | 'maxFilesExamined'
      | 'maxTotalBytesRead'
      | 'maxReferencesPerFile'
      | 'maxTotalReferences'
      | 'maxOutputSize'
      | undefined = candidatesTruncated ? 'maxCandidateFiles' : undefined;
    let completed = false;
    // Defensive guard against emitting the same occurrence twice. The key
    // distinguishes file, symbol, source position, and classification so that
    // legitimate repeated references at different positions are preserved.
    const seenOccurrences = new Set<string>();

    try {
      for (const candidate of candidates) {
        checkCancelled(options.signal, candidate.absPath);

        // Maximum files examined (global query limit).
        if (filesExamined >= maxFilesExamined) {
          truncated = true;
          if (limitReached === undefined) {
            limitReached = 'maxFilesExamined';
          }
          break;
        }

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
          if (limitReached === undefined) {
            limitReached = 'maxTotalBytesRead';
          }
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          break;
        }

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
          if (isCancelledError(error)) {
            throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Reference discovery cancelled', {
              path: candidate.absPath,
            });
          }
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

        // Per-file reference discovery, dispatched by language.
        if (isSyntaxAwareLanguage(detected)) {
          const scriptKind = scriptKindFromExtension(extension);
          let sourceFile: ts.SourceFile;
          try {
            sourceFile = ts.createSourceFile(
              candidate.absPath,
              content,
              ts.ScriptTarget.ES2022,
              true,
              scriptKind
            );
          } catch (error) {
            filesSkipped++;
            errors.push({
              path: candidate.absPath,
              message: error instanceof Error ? error.message : String(error),
              isFatal: false,
            });
            files.push(makeSkippedFileResult(candidate, 'readError'));
            continue;
          }

          const sf = sourceFile as SourceFileWithParseDiagnostics;
          for (const diag of sf.parseDiagnostics ?? []) {
            const message = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
            errors.push({
              path: candidate.absPath,
              message: `${candidate.absPath}:${diag.start}: ${message}`,
              isFatal: false,
            });
          }

          const fileScan = scanSyntaxFile(sourceFile, input.symbol, candidate, maxReferencesPerFile);
          if (fileScan.truncated) {
            truncated = true;
            if (limitReached === undefined) {
              limitReached = 'maxReferencesPerFile';
            }
          }
          filesExamined++;
          totalReferences += addDedupedFileResult(files, fileScan.result, seenOccurrences, input.symbol);
        } else {
          // Lexical discovery is only available when the fallback is enabled.
          if (enableLexicalFallback === false) {
            continue;
          }

          const fileScan = scanLexicalFile(content, input.symbol, candidate, maxReferencesPerFile);
          if (fileScan.truncated) {
            truncated = true;
            if (limitReached === undefined) {
              limitReached = 'maxReferencesPerFile';
            }
          }
          filesExamined++;
          totalReferences += addDedupedFileResult(files, fileScan.result, seenOccurrences, input.symbol);
        }

        // Maximum total references (global query limit).
        if (totalReferences >= maxTotalReferences) {
          truncated = true;
          if (limitReached === undefined) {
            limitReached = 'maxTotalReferences';
          }
          break;
        }

        // Maximum output size (approximate, global query limit).
        if (estimateOutputSize(files) > maxOutputSize) {
          truncated = true;
          if (limitReached === undefined) {
            limitReached = 'maxOutputSize';
          }
          break;
        }
      }
      completed = !truncated;
    } catch (error) {
      if (isCancelledError(error)) {
        throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Reference discovery cancelled', {
          path: absRoot,
        });
      } else {
        errors.push({
          path: absRoot,
          message: error instanceof Error ? error.message : String(error),
          isFatal: true,
        });
        completed = false;
      }
    }

    // Deterministic ordering: relative path.
    files.sort((a, b) => {
      const relCmp = a.relativePath.localeCompare(b.relativePath);
      if (relCmp !== 0) {
        return relCmp;
      }
      return 0;
    });

    const resultLanguage =
      languageFilter !== undefined && languageFilter.length === 1 ? languageFilter[0] : undefined;

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
        cancelled: false,
        completed,
      },
      errors,
    };
    return result;
  }
}

/**
 * Adds a finder-produced file result to the accumulated files, applying the
 * duplicate-occurrence guard. Returns the number of references actually added
 * (after deduplication) so the global total reference counter stays accurate.
 *
 * The guard key distinguishes file, symbol, source position, and classification,
 * so legitimate repeated references at different positions are preserved while
 * accidental duplicate occurrence entries are dropped.
 */
function addDedupedFileResult(
  files: ReferenceFileResult[],
  fileResult: ReferenceFileResult,
  seenOccurrences: Set<string>,
  symbol: string
): number {
  const deduped: ReferenceOccurrence[] = [];
  for (const r of fileResult.references) {
    const key = `${r.absolutePath}\u0000${symbol}\u0000${r.lineNumber}\u0000${r.startColumn}\u0000${r.classification}`;
    if (seenOccurrences.has(key)) {
      continue;
    }
    seenOccurrences.add(key);
    deduped.push(r);
  }
  const result: ReferenceFileResult = {
    ...fileResult,
    references: deduped,
    referenceCount: deduped.length,
  };
  files.push(result);
  return deduped.length;
}

export function createReferenceDiscoverer(options: ReferenceDiscovererOptions): ReferenceDiscoverer {
  return new ReferenceDiscoverer(options);
}
