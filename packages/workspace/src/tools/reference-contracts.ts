import type { DiscoveryError } from '../types.js';
import type { ReferenceConfig } from './reference-config.js';

/**
 * Classification of a single reference occurrence.
 *
 * `textual_match` is specifically for lexical matches where syntax-aware
 * classification is unavailable. A textual match must never be represented as
 * a confirmed `usage`. There is no `semantic` classification; identifying an
 * AST node does not by itself imply symbol resolution.
 */
export type ReferenceClassification =
  | 'definition'
  | 'declaration'
  | 'usage'
  | 'import'
  | 'export'
  | 'call'
  | 'textual_match';

/**
 * Confidence in a reference occurrence.
 *
 * `low` is used for lexical matches. `high` requires confirmed symbol
 * resolution and is never assigned merely because an AST node was found.
 */
export type ReferenceConfidence = 'high' | 'medium' | 'low';

/**
 * Languages that may appear in reference-discovery results. A single workspace
 * query can return mixed-language results; every occurrence carries its own
 * language so results are never ambiguous.
 */
export type ReferenceLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'c'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'shell'
  | 'powershell'
  | 'sql'
  | 'html'
  | 'css'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'markdown'
  | 'text';

/** A single reference occurrence within a file. */
export interface ReferenceOccurrence {
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  /** One-based line number. */
  readonly lineNumber: number;
  /** Zero-based, inclusive start column. */
  readonly startColumn: number;
  /** Zero-based, exclusive end column. */
  readonly endColumn: number;
  /** Exact matched substring. */
  readonly matchedText: string;
  readonly classification: ReferenceClassification;
  readonly confidence: ReferenceConfidence;
  readonly language: ReferenceLanguage;
  /** The symbol being searched for. */
  readonly symbol: string;
  /** Optional surrounding context lines. */
  readonly context?: readonly string[] | undefined;
}

/** The result of searching a single file for references. */
export interface ReferenceFileResult {
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly language: ReferenceLanguage;
  readonly references: readonly ReferenceOccurrence[];
  readonly referenceCount: number;
  /** Whether the per-file reference limit was reached for this file. */
  readonly truncated: boolean;
  /** Whether the file was skipped and not searched. */
  readonly skipped: boolean;
  /** Reason the file was skipped, if any. */
  readonly skipReason:
    | 'binary'
    | 'sensitive'
    | 'tooLarge'
    | 'readError'
    | 'ignored'
    | 'unsupportedLanguage'
    | undefined;
}

/** Completion, cancellation, truncation, and limit metadata. */
export interface ReferenceDiscoveryMetadata {
  readonly filesExamined: number;
  readonly filesSkipped: number;
  readonly totalReferences: number;
  /** Whether any resource limit caused truncation. */
  readonly truncated: boolean;
  /** Which limit was reached, if any. */
  readonly limitReached:
    | 'maxCandidateFiles'
    | 'maxFilesExamined'
    | 'maxTotalBytesRead'
    | 'maxReferencesPerFile'
    | 'maxTotalReferences'
    | 'maxOutputSize'
    | undefined;
  readonly cancelled: boolean;
  readonly completed: boolean;
}

/** Structured result of a reference-discovery query. */
export interface ReferenceDiscoveryResult {
  readonly kind: 'reference-discovery';
  readonly uri: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly symbol: string;
  readonly language: ReferenceLanguage | undefined;
  readonly files: readonly ReferenceFileResult[];
  readonly metadata: ReferenceDiscoveryMetadata;
  readonly errors: readonly DiscoveryError[];
}

/** Options for a reference-discovery query. */
export interface ReferenceDiscoveryOptions {
  readonly workspaceFolder: { readonly uri: string; readonly id: string };
  readonly symbol: string;
  readonly classifications?: readonly ReferenceClassification[] | undefined;
  readonly languages?: readonly ReferenceLanguage[] | undefined;
  readonly includePatterns?: readonly string[] | undefined;
  readonly excludePatterns?: readonly string[] | undefined;
  readonly enableLexicalFallback?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly config?: Partial<ReferenceConfig> | undefined;
}
