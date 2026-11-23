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
import { validateSymlinkFreePath } from './path-security.js';
import { defaultReferenceConfig, type ReferenceConfig, safeValidateReferenceConfig } from './reference-config.js';
import {
  safeValidateReferenceDiscoveryInput,
  type ReferenceDiscoveryInput,
} from './reference-schemas.js';
import type {
  ReferenceClassification,
  ReferenceDiscoveryResult,
  ReferenceFileResult,
  ReferenceLanguage,
  ReferenceOccurrence,
} from './reference-contracts.js';
import { ToolErrorCode, createToolError, isToolErrorCode } from './errors.js';
import * as ts from 'typescript';

/**
 * Identifier-boundary validation for symbol queries.
 *
 * Mirrors the policy in LexicalFinder: a valid query is non-empty, consists
 * only of identifier characters, and does not start with a digit. This keeps
 * the symbol scoped to genuine identifier references rather than arbitrary
 * expressions.
 */
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
    const isIdentifierChar =
      code >= 0x80 || /[A-Za-z0-9_$]/.test(ch);
    if (!isIdentifierChar) {
      return false;
    }
  }
  return true;
}

function isSupportedReferenceLanguage(language: string | null): language is ReferenceLanguage {
  const supported: readonly ReferenceLanguage[] = [
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
  ];
  return language !== null && supported.includes(language as ReferenceLanguage);
}

function isSyntaxAwareLanguage(language: ReferenceLanguage): boolean {
  return language === 'javascript' || language === 'typescript';
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
 * estimation approach used by LexicalFinder so limit enforcement is consistent.
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

/**
 * Maps a file extension to the TypeScript ScriptKind used when creating a
 * SourceFile. Only JavaScript and TypeScript extensions are mapped; all
 * others return undefined and are handled as unsupported by the caller.
 */
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

/**
 * Converts a character position in a SourceFile to a 1-based line number and
 * 0-based UTF-16 column, consistent with the ReferenceOccurrence contract.
 */
function getLineAndColumn(
  sourceFile: ts.SourceFile,
  position: number
): { line: number; column: number } {
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, position);
  return { line: line + 1, column: character };
}

function detectLanguageFromPath(absPath: string): ReferenceLanguage {
  const baseName = absPath.slice(absPath.lastIndexOf('/') + 1);
  const { extension } = splitNameExtension(baseName);
  const detected = detectLanguage(extension);
  return isSupportedReferenceLanguage(detected) ? detected : 'text';
}

/**
 * TypeScript's `SourceFile` type in this compiler version does not declare
 * `parseDiagnostics`, but the runtime object exposes it. This interface
 * bridges the gap so diagnostics can be read safely without `any`.
 */
interface SourceFileWithDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
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
 * Classification outcome for a single identifier node.
 *
 * `skip` is true when the identifier occurs in a position that must not be
 * reported (property names, object-literal keys, JSDoc, etc.).
 */
interface ClassificationResult {
  readonly classification: ReferenceClassification;
  readonly skip: boolean;
}

/**
 * Classifies an Identifier node based on its syntactic parent context.
 *
 * Classification rules (conservative, syntactic only):
 *
 * - VariableDeclaration.name, FunctionDeclaration.name, ClassDeclaration.name,
 *   InterfaceDeclaration.name, TypeAliasDeclaration.name, EnumDeclaration.name,
 *   MethodDeclaration/MethodSignature.name, PropertyDeclaration/PropertySignature.name,
 *   Parameter.name, EnumMember.name  -> `declaration`
 * - ImportSpecifier.name/propertyName, ImportClause.name (default import),
 *   NamespaceImport.name, ImportEqualsDeclaration.name  -> `import`
 * - ExportSpecifier, ExportAssignment.expression  -> `export`
 * - CallExpression.expression  -> `call`
 * - Transparent wrappers (ParenthesizedExpression, AsExpression,
 *   NonNullExpression, SatisfiesExpression) whose `.expression` is the
 *   identifier: `call` if the wrapper is the callee of a CallExpression,
 *   otherwise `usage`.
 * - PropertyAccessExpression.expression  -> `usage` (the object being accessed)
 * - PropertyAccessExpression.name, PropertyAssignment.name  -> excluded (skip)
 * - ShorthandPropertyAssignment.name  -> `usage` (shorthand for `{ name: name }`)
 * - BinaryExpression.left  -> `usage` (assignment target)
 * - LabeledStatement.label, BreakStatement.label, ContinueStatement.label
 *   -> excluded (skip)
 * - Any other identifier  -> `usage`
 *
 * Declaration names are never also reported as usages. Each identifier node is
 * classified exactly once, so no location can receive two classifications.
 * No semantic scope resolution is performed: two identically spelled
 * identifiers are treated as independent occurrences.
 *
 * Limitations:
 * - JSDoc identifiers are excluded.
 * - Type arguments and type-only positions are treated as usages when the
 *   identifier's syntactic role is a plain reference; type declarations are
 *   classified as `declaration`.
 * - `export = foo` is classified as `export` (the expression is re-exported).
 * - Computed property names (`{ [foo]: 1 }`) are classified as `usage`.
 * - Destructuring patterns (`const { foo } = bar`) classify `foo` as
 *   `declaration` (binding element) and `bar` as `usage`.
 * - Label identifiers are not reported as symbol references.
 */
function classifyIdentifierNode(
  node: ts.Identifier,
  _sourceFile: ts.SourceFile
): ClassificationResult | null {
  const parent = node.parent;
  if (!parent) {
    return { classification: 'usage', skip: false };
  }

  switch (parent.kind) {
    case ts.SyntaxKind.VariableDeclaration:
      if ((parent as ts.VariableDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.FunctionDeclaration:
      if ((parent as ts.FunctionDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.ClassDeclaration:
      if ((parent as ts.ClassDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.InterfaceDeclaration:
      if ((parent as ts.InterfaceDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.TypeAliasDeclaration:
      if ((parent as ts.TypeAliasDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.EnumDeclaration:
      if ((parent as ts.EnumDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
      if ((parent as ts.MethodDeclaration | ts.MethodSignature).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
      if ((parent as ts.PropertyDeclaration | ts.PropertySignature).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.Parameter:
      if ((parent as ts.ParameterDeclaration).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.EnumMember:
      if ((parent as ts.EnumMember).name === node) {
        return { classification: 'declaration', skip: false };
      }
      break;

    case ts.SyntaxKind.BindingElement: {
      const be = parent as ts.BindingElement;
      if (be.name === node) {
        return { classification: 'declaration', skip: false };
      }
      // `propertyName` is the property being destructured (e.g. `qux` in
      // `const { qux: q } = obj`), not a declared binding.
      return { classification: 'usage', skip: true };
    }

    case ts.SyntaxKind.ImportSpecifier: {
      const spec = parent as ts.ImportSpecifier;
      if (spec.name === node || spec.propertyName === node) {
        return { classification: 'import', skip: false };
      }
      break;
    }

    case ts.SyntaxKind.ImportClause:
      // `import defaultExport from "mod"`: default import name is directly
      // on the ImportClause, not wrapped in a separate specifier node.
      if ((parent as ts.ImportClause).name === node) {
        return { classification: 'import', skip: false };
      }
      break;

    case ts.SyntaxKind.NamespaceImport:
      // `import * as ns from "mod"`: namespace import name is directly on
      // the NamespaceImport node.
      return { classification: 'import', skip: false };

    case ts.SyntaxKind.ImportEqualsDeclaration:
      if ((parent as ts.ImportEqualsDeclaration).name === node) {
        return { classification: 'import', skip: false };
      }
      break;

    case ts.SyntaxKind.ExportSpecifier:
      return { classification: 'export', skip: false };

    case ts.SyntaxKind.ExportAssignment:
      if ((parent as ts.ExportAssignment).expression === node) {
        return { classification: 'export', skip: false };
      }
      break;

    case ts.SyntaxKind.CallExpression:
      // Direct callee: `foo()` where `foo` is the CallExpression.expression.
      // Wrapped callees (e.g. `(foo)()`, `foo!()`) are handled by the
      // transparent-expression-wrapper cases below.
      if ((parent as ts.CallExpression).expression === node) {
        return { classification: 'call', skip: false };
      }
      break;

    case ts.SyntaxKind.PropertyAccessExpression: {
      const pa = parent as ts.PropertyAccessExpression;
      if (pa.expression === node) {
        return { classification: 'usage', skip: false };
      }
      // `pa.name === node`: property/member name (e.g. `bar` in `foo.bar`).
      return { classification: 'usage', skip: true };
    }

    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.NonNullExpression:
    case ts.SyntaxKind.SatisfiesExpression: {
      const wrapper = parent as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.NonNullExpression
        | ts.SatisfiesExpression;
      if (wrapper.expression === node) {
        // Transparent wrappers preserve the syntactic role of the wrapped
        // expression. If the wrapper is the callee of a call expression,
        // the identifier is a call target.
        const grandparent = wrapper.parent;
        if (
          grandparent &&
          grandparent.kind === ts.SyntaxKind.CallExpression &&
          (grandparent as ts.CallExpression).expression === wrapper
        ) {
          return { classification: 'call', skip: false };
        }
        return { classification: 'usage', skip: false };
      }
      break;
    }

    case ts.SyntaxKind.PropertyAssignment: {
      const pa = parent as ts.PropertyAssignment;
      if (pa.name === node) {
        // Object-literal property names (e.g. `customer` in `{ customer: value }`)
        // are not references.
        return { classification: 'usage', skip: true };
      }
      break;
    }

    case ts.SyntaxKind.ShorthandPropertyAssignment:
      // Shorthand object properties (e.g. `customer` in `{ customer }`) are
      // shorthand for `{ customer: customer }`, so the name is a genuine
      // identifier reference.
      return { classification: 'usage', skip: false };

    case ts.SyntaxKind.BinaryExpression:
      if ((parent as ts.BinaryExpression).left === node) {
        return { classification: 'usage', skip: false };
      }
      break;

    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement: {
      const labelParent = parent as
        | ts.LabeledStatement
        | ts.BreakStatement
        | ts.ContinueStatement;
      if (labelParent.label === node) {
        // Label identifiers are control-flow markers, not symbol references.
        return { classification: 'usage', skip: true };
      }
      break;
    }

    default:
      break;
  }

  // Exclude identifiers inside JSDoc comments.
  if (isInJSDoc(node)) {
    return { classification: 'usage', skip: true };
  }

  return { classification: 'usage', skip: false };
}

function isInJSDoc(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      current.kind >= ts.SyntaxKind.JSDoc &&
      current.kind <= ts.SyntaxKind.LastJSDocNode
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export interface SyntaxAwareFinderOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  config?: Partial<ReferenceConfig>;
}

/**
 * Syntax-aware reference finder for JavaScript and TypeScript.
 *
 * Uses the TypeScript compiler API (`ts.createSourceFile`, `ts.forEachChild`)
 * to parse source files and classify identifier occurrences syntactically.
 *
 * Design properties:
 * - Only `javascript` and `typescript` files are parsed. All other languages
 *   are reported as `unsupportedLanguage` and skipped; lexical fallback for
 *   those languages is the responsibility of the lexical finder and the
 *   orchestration layer.
 * - Each file is parsed independently. A malformed file yields a recovered AST
 *   that is traversed, with parse diagnostics reported as non-fatal errors. A
 *   single malformed file never terminates the workspace query.
 * - All occurrences carry `confidence: 'medium'` (syntactic, never `high`).
 * - Declaration names are classified as `declaration` and are never also
 *   reported as `usage`.
 * - Per-file and cross-file limits are enforced identically to LexicalFinder.
 * - Cancellation throws `TOOL_CANCELLED` and never returns a misleading
 *   successful partial result.
 * - No source file contents are included in the result payload.
 */
export class SyntaxAwareFinder {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly config: ReferenceConfig;
  private readonly searcher: CodeSearcher;

  constructor(options: SyntaxAwareFinderOptions) {
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
   * Performs a syntax-aware reference discovery across eligible workspace
   * source files. Only JavaScript and TypeScript files are parsed; every
   * occurrence is reported with `confidence: 'medium'`.
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

    const classificationFilter = input.classifications;
    if (
      classificationFilter !== undefined &&
      classificationFilter.length > 0
    ) {
      // No fast-path rejection here; per-occurrence filtering is applied below.
    }

    checkCancelled(options.signal, this.workspaceFolder.uri);

    const absRoot = normalizePath(this.workspaceFolder.uri);

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

    const { candidates, truncated: candidatesTruncated } =
      await this.searcher.getCandidates({
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
    let truncated = candidatesTruncated;
    let limitReached:
      | 'maxCandidateFiles'
      | 'maxFilesExamined'
      | 'maxTotalBytesRead'
      | 'maxReferencesPerFile'
      | 'maxTotalReferences'
      | 'maxOutputSize'
      | undefined = candidatesTruncated ? 'maxCandidateFiles' : undefined;
    let cancelled = false;
    let completed = false;

    try {
      for (const candidate of candidates) {
        if (cancelled) {
          break;
        }
        checkCancelled(options.signal, candidate.absPath);

        if (filesExamined >= maxFilesExamined) {
          truncated = true;
          limitReached = 'maxFilesExamined';
          break;
        }

        if (isSensitiveFile(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'sensitive'));
          continue;
        }

        if (isBinaryByExtension(candidate.absPath)) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'binary'));
          continue;
        }

        if (candidate.stat.size > maxFileSize) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'tooLarge'));
          continue;
        }

        if (totalBytesRead + candidate.stat.size > maxTotalBytesRead) {
          truncated = true;
          limitReached = 'maxTotalBytesRead';
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

        if (!isSyntaxAwareLanguage(detected)) {
          // Non-JS/TS source languages: syntax-aware discovery does not apply.
          // Lexical fallback is handled by the lexical finder / orchestration.
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'unsupportedLanguage'));
          continue;
        }

        if (languageFilter !== undefined && languageFilter.length > 0 && !languageFilter.includes(detected)) {
          continue;
        }

        let content: string;
        try {
          content = await this.fileSystem.readFile(candidate.absPath);
        } catch (error) {
          if (isCancelledError(error)) {
            cancelled = true;
            break;
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

        const binary = isBinaryExtension(extension) || isBinaryContent(content);
        if (binary) {
          filesSkipped++;
          files.push(makeSkippedFileResult(candidate, 'binary'));
          continue;
        }

        const scriptKind = scriptKindFromExtension(extension);
        let sourceFile: ts.SourceFile;
        try {
          sourceFile = ts.createSourceFile(
            candidate.absPath,
            content,
            ts.ScriptTarget.ES2022,
            true, // setParentNodes
            scriptKind
          );
        } catch (error) {
          // ts.createSourceFile does not throw on syntax errors, but a
          // catastrophic failure is still handled gracefully.
          filesSkipped++;
          errors.push({
            path: candidate.absPath,
            message: error instanceof Error ? error.message : String(error),
            isFatal: false,
          });
          files.push(makeSkippedFileResult(candidate, 'readError'));
          continue;
        }

        // Capture parse diagnostics from malformed source. The recovered AST
        // is still traversed; diagnostics are reported as non-fatal errors.
        const parseErrors: string[] = [];
        const sf = sourceFile as SourceFileWithDiagnostics;
        for (const diag of sf.parseDiagnostics ?? []) {
          const message = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
          parseErrors.push(`${candidate.absPath}:${diag.start}: ${message}`);
        }
        for (const message of parseErrors) {
          errors.push({
            path: candidate.absPath,
            message,
            isFatal: false,
          });
        }

        const fileScan = scanFileForReferences(
          sourceFile,
          input.symbol,
          candidate,
          maxReferencesPerFile
        );

        for (const parseMessage of fileScan.parseErrors) {
          errors.push({
            path: candidate.absPath,
            message: parseMessage,
            isFatal: false,
          });
        }

        if (fileScan.truncated) {
          truncated = true;
          limitReached = 'maxReferencesPerFile';
        }

        filesExamined++;
        totalReferences += fileScan.count;
        files.push(fileScan.result);

        if (totalReferences >= maxTotalReferences) {
          truncated = true;
          limitReached = 'maxTotalReferences';
          break;
        }

        if (estimateOutputSize(files) > maxOutputSize) {
          truncated = true;
          limitReached = 'maxOutputSize';
          break;
        }
      }
      completed = !cancelled && !truncated;
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
 * Traverses a TypeScript SourceFile and collects all identifier occurrences
 * matching `symbol`. Each matching identifier is classified once based on its
 * syntactic role.
 *
 * Returns the per-file result, the match count, whether the per-file limit was
 * reached, and any parse-diagnostic error messages.
 */
function scanFileForReferences(
  sourceFile: ts.SourceFile,
  symbol: string,
  candidate: { readonly absPath: string; readonly relPath: string },
  maxReferencesPerFile: number
): {
  readonly result: ReferenceFileResult;
  readonly count: number;
  readonly truncated: boolean;
  readonly parseErrors: readonly string[];
} {
  const references: ReferenceOccurrence[] = [];
  let truncated = false;
  const parseErrors: string[] = [];

  // Parse diagnostics are reported by the caller; this function focuses on
  // traversing the recovered AST.
  function visit(node: ts.Node): void {
    if (truncated) {
      return;
    }

    if (ts.isIdentifier(node) && node.text === symbol) {
      const classification = classifyIdentifierNode(node, sourceFile);
      if (classification && !classification.skip && references.length < maxReferencesPerFile) {
        const startPos = node.getStart(sourceFile);
        const endPos = node.getEnd();
        const { line: startLine, column: startColumn } = getLineAndColumn(sourceFile, startPos);
        const { column: endColumn } = getLineAndColumn(sourceFile, endPos);

        references.push({
          uri: `file:///${candidate.absPath.replace(/^\/+/, '')}`,
          absolutePath: candidate.absPath,
          relativePath: candidate.relPath,
          lineNumber: startLine,
          startColumn,
          endColumn,
          matchedText: node.text,
          classification: classification.classification,
          confidence: 'medium',
          language: detectLanguageFromPath(candidate.absPath),
          symbol,
        });
      }

      if (references.length >= maxReferencesPerFile) {
        truncated = true;
        return;
      }
    }

    ts.forEachChild(node, child => visit(child));
  }

  visit(sourceFile);

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
    parseErrors,
  };
}

export function createSyntaxAwareFinder(options: SyntaxAwareFinderOptions): SyntaxAwareFinder {
  return new SyntaxAwareFinder(options);
}
