import type { DirectoryEntry, FileSystemProvider } from '../discovery/workspace-provider.js';
import type { IgnoreEngine } from '../ignore/ignore-engine.js';
import type {
  ExpandedPackage,
  WorkspaceFolder,
} from '../types.js';
import { defaultFileDiscoveryConfig, type FileDiscoveryConfig } from '../config.js';

function normalizeRoot(root: string): string {
  return resolvePath(root.replace(/\\/g, '/').replace(/\/+$/, ''));
}

function resolvePath(p: string): string {
  const absolute = p.startsWith('/');
  const parts = p.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (resolved.length > 0) {
        resolved.pop();
      }
      continue;
    }
    resolved.push(part);
  }
  return (absolute ? '/' : '') + resolved.join('/');
}

function normalizePattern(pattern: string): string {
  return resolvePath(pattern.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, ''));
}

function splitSegments(pattern: string): string[] {
  return pattern.split('/').filter(Boolean);
}

function matchSegment(patternSegment: string, nameSegment: string): boolean {
  if (patternSegment === '**') {
    return true;
  }
  if (patternSegment === '*') {
    return !nameSegment.includes('/');
  }
  if (patternSegment.includes('*')) {
    const regex = new RegExp(
      '^' +
        patternSegment
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*') +
        '$'
    );
    return regex.test(nameSegment);
  }
  return patternSegment === nameSegment;
}

function isPathUnder(root: string, candidate: string): boolean {
  const r = normalizeRoot(root);
  const c = normalizeRoot(candidate);
  return c === r || c.startsWith(`${r}/`);
}

function joinSegments(root: string, segments: string[]): string {
  const r = normalizeRoot(root);
  if (segments.length === 0) return r;
  return resolvePath(`${r}/${segments.join('/')}`);
}

export interface PackagePatternExpansionOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  monorepoRootPath: string;
  patterns: readonly string[];
  projectId?: string;
  config?: Partial<FileDiscoveryConfig>;
  ignoreEngine?: IgnoreEngine;
  signal?: AbortSignal;
}

export interface ExpandedPackageResult {
  readonly packages: readonly ExpandedPackage[];
  readonly count: number;
  readonly truncated: boolean;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly errors: readonly ExpansionError[];
}

export interface ExpansionError {
  readonly pattern: string;
  readonly message: string;
  readonly isFatal: boolean;
}

interface TraversalState {
  truncated: boolean;
  cancelled: boolean;
}

export class MonorepoPackageExpander {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly monorepoRootPath: string;
  private readonly patterns: readonly string[];
  private readonly projectId: string | undefined;
  private readonly config: FileDiscoveryConfig;
  private readonly ignoreEngine: IgnoreEngine | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly rawPatterns: readonly string[];

  constructor(options: PackagePatternExpansionOptions) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    this.monorepoRootPath = normalizeRoot(options.monorepoRootPath);
    this.rawPatterns = options.patterns;
    this.patterns = options.patterns.map(normalizePattern);
    this.projectId = options.projectId;
    this.config = { ...defaultFileDiscoveryConfig, ...options.config };
    this.ignoreEngine = options.ignoreEngine;
    this.signal = options.signal;
  }

  async expand(): Promise<ExpandedPackageResult> {
    const packages: ExpandedPackage[] = [];
    const errors: ExpansionError[] = [];
    const resultSeen = new Set<string>();
    let completed = false;

    const state: TraversalState = { truncated: false, cancelled: false };

    try {
      for (let i = 0; i < this.patterns.length; i++) {
        const pattern = this.patterns[i]!;
        const rawPattern = this.rawPatterns[i]!;
        if (state.cancelled) {
          break;
        }
        this.checkAbort();

        const rawSegments = splitSegments(rawPattern);
        if (rawSegments.includes('..')) {
          errors.push({
            pattern: rawPattern,
            message: `Pattern escapes workspace root via path traversal: ${rawPattern}`,
            isFatal: false,
          });
          continue;
        }

        const patternSegments = splitSegments(pattern);
        if (patternSegments.length === 0) {
          continue;
        }

        const traversed = new Set<string>();

        try {
          await this.expandPattern(
            pattern,
            patternSegments,
            [],
            0,
            traversed,
            resultSeen,
            packages,
            errors,
            state
          );
        } catch (error) {
          errors.push({
            pattern,
            message: error instanceof Error ? error.message : String(error),
            isFatal: false,
          });
        }

        if (packages.length >= this.config.maxFileCount) {
          state.truncated = true;
          break;
        }
      }
      completed = true;
    } catch (error) {
      if (this.isAbortError(error)) {
        state.cancelled = true;
        completed = false;
      } else {
        errors.push({ pattern: '', message: error instanceof Error ? error.message : String(error), isFatal: true });
        completed = false;
      }
    }

    return {
      packages,
      count: packages.length,
      truncated: state.truncated,
      completed,
      cancelled: state.cancelled,
      errors,
    };
  }

  private async expandPattern(
    pattern: string,
    patternSegments: string[],
    currentSegments: string[],
    segIndex: number,
    traversed: Set<string>,
    resultSeen: Set<string>,
    packages: ExpandedPackage[],
    errors: ExpansionError[],
    state: TraversalState
  ): Promise<void> {
    if (state.cancelled) {
      return;
    }
    this.checkAbort();

    // Pattern fully matched: current directory is a package candidate.
    if (segIndex === patternSegments.length) {
      this.considerDirectory(
        joinSegments(this.monorepoRootPath, currentSegments),
        currentSegments,
        pattern,
        resultSeen,
        packages,
        state
      );
      return;
    }

    const absDir = joinSegments(this.monorepoRootPath, currentSegments);

    if (!isPathUnder(this.monorepoRootPath, absDir)) {
      errors.push({
        pattern,
        message: `Pattern escapes monorepo root: ${pattern}`,
        isFatal: false,
      });
      return;
    }

    const absKey = absDir.replace(/\/+$/, '');
    if (traversed.has(absKey)) {
      return;
    }
    traversed.add(absKey);

    let entries: readonly DirectoryEntry[];
    try {
      entries = await this.fileSystem.readDirectory(absDir);
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const patternSegment = patternSegments[segIndex]!;

    if (patternSegment === '**') {
      // '**' matches zero segments: advance the pattern without descending.
      await this.expandPattern(
        pattern,
        patternSegments,
        currentSegments,
        segIndex + 1,
        traversed,
        resultSeen,
        packages,
        errors,
        state
      );
      // '**' matches one or more segments: descend into each child directory.
      for (const entry of sorted) {
        if (state.cancelled) return;
        if (entry.type === 'directory') {
          const nextSegments = [...currentSegments, entry.name];
          if (this.isExcludedDirectory(nextSegments)) {
            continue;
          }
          await this.expandPattern(
            pattern,
            patternSegments,
            nextSegments,
            segIndex,
            traversed,
            resultSeen,
            packages,
            errors,
            state
          );
        }
      }
      return;
    }

    for (const entry of sorted) {
      if (state.cancelled) return;
      this.checkAbort();

      if (!matchSegment(patternSegment, entry.name)) {
        continue;
      }

      const nextSegments = [...currentSegments, entry.name];

      if (entry.type === 'directory') {
        if (this.isExcludedDirectory(nextSegments)) {
          continue;
        }
        await this.expandPattern(
          pattern,
          patternSegments,
          nextSegments,
          segIndex + 1,
          traversed,
          resultSeen,
          packages,
          errors,
          state
        );
      }
    }
  }

  private considerDirectory(
    absPath: string,
    segments: string[],
    pattern: string,
    resultSeen: Set<string>,
    packages: ExpandedPackage[],
    state: TraversalState
  ): void {
    if (state.cancelled) return;
    if (packages.length >= this.config.maxFileCount) {
      state.truncated = true;
      return;
    }
    const relPath = segments.join('/');
    if (this.ignoreEngine?.isIgnored(relPath, { isDirectory: true })) {
      return;
    }
    const absKey = absPath.replace(/\/+$/, '');
    if (resultSeen.has(absKey)) return;
    resultSeen.add(absKey);

    const name = segments[segments.length - 1] ?? relPath;
    packages.push({
      path: absPath,
      relativePath: relPath,
      name,
      matchedPattern: pattern,
      workspaceFolderId: this.workspaceFolder.id,
      ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
    });
  }

  private isExcludedDirectory(segments: string[]): boolean {
    if (!this.ignoreEngine) {
      return false;
    }
    return this.ignoreEngine.isIgnored(segments.join('/'), { isDirectory: true });
  }

  private checkAbort(): void {
    if (this.signal?.aborted) {
      const err = new Error('Operation aborted') as Error & { code?: string };
      err.name = 'AbortError';
      throw err;
    }
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.name === 'AbortError';
    }
    return false;
  }
}

export function createMonorepoPackageExpander(
  options: PackagePatternExpansionOptions
): MonorepoPackageExpander {
  return new MonorepoPackageExpander(options);
}
