import { createLogger, type Logger, defaultEngineConfig } from '@nexipi/core';
import type { FileSystemProvider } from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
import {
  DefaultDirectoryExclusions,
  MandatorySafetyExclusions,
} from '../config.js';
import IgnoreFactory from 'ignore';

type IgnoreInstance = NonNullable<ReturnType<typeof IgnoreFactory>>;

const GITIGNORE_FILE_NAME = '.gitignore';

function normalizeDirPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/+$/, '');
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function joinPaths(root: string, rel: string): string {
  const r = normalizeDirPath(root);
  const x = normalizeRelPath(rel);
  return x.length === 0 ? r : `${r}/${x}`;
}

function relativePaths(root: string, abs: string): string {
  const r = normalizeDirPath(root);
  const a = normalizeDirPath(abs);
  if (a === r) return '';
  if (a.startsWith(`${r}/`)) return a.slice(r.length + 1);
  return a;
}

function testPath(instance: IgnoreInstance, relPath: string, isDirectory: boolean): boolean {
  if (instance.ignores(relPath)) {
    return true;
  }
  if (isDirectory && instance.ignores(`${relPath}/`)) {
    return true;
  }
  return false;
}

function parseGitignoreContent(content: string): string[] {
  const patterns: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    patterns.push(trimmed);
  }
  return patterns;
}

export interface IgnoreEngineOptions {
  fileSystem: FileSystemProvider;
  workspaceFolder: WorkspaceFolder;
  root: string;
  config?: {
    enableMandatorySafetyExclusions?: boolean;
    enableDefaultExclusions?: boolean;
    userExclusions?: readonly string[];
    caseSensitive?: boolean;
  };
  logger?: Logger;
}

export interface IgnoreTestResult {
  readonly ignored: boolean;
  readonly reason: 'mandatory' | 'user' | 'default' | 'gitignore' | 'none';
  readonly matchedPattern?: string;
}

export class IgnoreEngine {
  private readonly fileSystem: FileSystemProvider;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly root: string;
  private readonly config: Required<NonNullable<IgnoreEngineOptions['config']>>;
  private readonly logger: Logger;
  private readonly mandatoryIgnore: IgnoreInstance;
  private defaultIgnore: IgnoreInstance;
  private readonly userIgnore: IgnoreInstance;
  private readonly dirInstances = new Map<string, IgnoreInstance>();
  private readonly dirPatterns = new Map<string, string[]>();
  private readonly excludedDirs = new Set<string>();
  private disposed = false;

  constructor(options: IgnoreEngineOptions) {
    this.fileSystem = options.fileSystem;
    this.workspaceFolder = options.workspaceFolder;
    this.root = normalizeDirPath(options.root);
    this.config = {
      enableMandatorySafetyExclusions: options.config?.enableMandatorySafetyExclusions ?? true,
      enableDefaultExclusions: options.config?.enableDefaultExclusions ?? true,
      userExclusions: options.config?.userExclusions ?? [],
      caseSensitive: options.config?.caseSensitive ?? false,
    };
    this.logger = options.logger ?? createLogger({
      ...defaultEngineConfig,
      name: 'ignore-engine',
      version: '0.0.1',
      logLevel: 'info',
    });

    this.mandatoryIgnore = IgnoreFactory();
    if (this.config.enableMandatorySafetyExclusions) {
      this.mandatoryIgnore.add(MandatorySafetyExclusions);
    }

    this.defaultIgnore = IgnoreFactory();
    if (this.config.enableDefaultExclusions) {
      this.defaultIgnore.add(DefaultDirectoryExclusions);
    }

    this.userIgnore = IgnoreFactory();
    if (this.config.userExclusions.length > 0) {
      this.userIgnore.add([...this.config.userExclusions]);
    }
  }

  addUserExclusions(patterns: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    const filtered = patterns.filter((p) => p.length > 0);
    if (filtered.length === 0) {
      return;
    }
    this.userIgnore.add(filtered);
  }

  setDefaultExclusions(patterns: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    this.defaultIgnore = IgnoreFactory();
    if (this.config.enableDefaultExclusions) {
      this.defaultIgnore.add(patterns.filter((p) => p.length > 0));
    }
  }

  async loadGitignore(absDirPath: string): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const dirPath = normalizeDirPath(absDirPath);
    const gitignorePath = joinPaths(dirPath, GITIGNORE_FILE_NAME);
    let content: string;
    try {
      content = await this.fileSystem.readFile(gitignorePath);
    } catch (error) {
      this.logger.debug('Skipped unreadable gitignore', {
        path: gitignorePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const patterns = parseGitignoreContent(content);
    const instance = IgnoreFactory();
    if (patterns.length > 0) {
      instance.add(patterns);
    }
    this.dirInstances.set(dirPath, instance);
    this.dirPatterns.set(dirPath, patterns);
    this.logger.debug('Loaded gitignore', { path: gitignorePath, patternCount: patterns.length });
    return true;
  }

  private resolveAbs(relPath: string): string {
    return joinPaths(this.root, relPath);
  }

  private ancestorDirs(absPath: string): readonly string[] {
    const ancestors: string[] = [];
    let cursor = normalizeDirPath(absPath);
    const root = this.root;
    let walking = true;
    // Walk up from the parent of absPath to root.
    while (walking) {
      const parent = cursor.slice(0, cursor.lastIndexOf('/'));
      if (parent === cursor || parent.length === 0) {
        walking = false;
        continue;
      }
      cursor = parent;
      if (cursor.length < root.length) {
        walking = false;
        continue;
      }
      if (!cursor.startsWith(root)) {
        walking = false;
        continue;
      }
      ancestors.push(cursor);
      if (cursor === root) {
        walking = false;
      }
    }
    // ancestors currently: nearest parent ... root. Reverse to root-first order.
    ancestors.reverse();
    return ancestors;
  }

  private isDirExcludedByRules(absDirPath: string): boolean {
    const relDir = relativePaths(this.root, absDirPath);
    if (relDir.length === 0) {
      return false;
    }
    if (this.config.enableMandatorySafetyExclusions && testPath(this.mandatoryIgnore, relDir, true)) {
      return true;
    }
    if (testPath(this.userIgnore, relDir, true)) {
      return true;
    }
    if (this.config.enableDefaultExclusions && testPath(this.defaultIgnore, relDir, true)) {
      return true;
    }
    return this.gitignoreIsIgnored(relDir, true);
  }

  private gitignoreIsIgnored(relPath: string, isDirectory: boolean): boolean {
    const absPath = this.resolveAbs(relPath);
    const ancestors = this.ancestorDirs(absPath);
    let matched = false;
    let ignored = false;
    for (const ancestor of ancestors) {
      const instance = this.dirInstances.get(ancestor);
      if (!instance) {
        continue;
      }
      const relFromAncestor = relativePaths(ancestor, absPath);
      const candidates = [relFromAncestor];
      if (isDirectory) {
        candidates.push(`${relFromAncestor}/`);
      }
      for (const candidate of candidates) {
        const result = instance.test(candidate);
        if (result.ignored || result.unignored) {
          ignored = result.ignored;
          matched = true;
        }
      }
    }
    return matched ? ignored : false;
  }

  isExcluded(relPath: string, options?: { isDirectory?: boolean }): IgnoreTestResult {
    const isDirectory = options?.isDirectory ?? false;
    const rel = normalizeRelPath(relPath);
    const absPath = this.resolveAbs(rel);

    // Parent-directory exclusion: an excluded parent excludes everything beneath it.
    for (const ancestor of this.ancestorDirs(absPath)) {
      if (this.excludedDirs.has(ancestor) || this.isDirExcludedByRules(ancestor)) {
        return { ignored: true, reason: 'mandatory', matchedPattern: '(excluded parent)' };
      }
    }

    if (this.config.enableMandatorySafetyExclusions && testPath(this.mandatoryIgnore, rel, isDirectory)) {
      return { ignored: true, reason: 'mandatory', matchedPattern: '(mandatory safety)' };
    }
    if (testPath(this.userIgnore, rel, isDirectory)) {
      return { ignored: true, reason: 'user', matchedPattern: '(user exclusion)' };
    }
    if (this.config.enableDefaultExclusions && testPath(this.defaultIgnore, rel, isDirectory)) {
      return { ignored: true, reason: 'default', matchedPattern: '(default exclusion)' };
    }
    if (this.gitignoreIsIgnored(rel, isDirectory)) {
      return { ignored: true, reason: 'gitignore', matchedPattern: '(gitignore)' };
    }
    return { ignored: false, reason: 'none' };
  }

  isIgnored(relPath: string, options?: { isDirectory?: boolean }): boolean {
    return this.isExcluded(relPath, options).ignored;
  }

  markDirectoryExcluded(absDirPath: string): void {
    this.excludedDirs.add(normalizeDirPath(absDirPath));
  }

  isDirectoryMarkedExcluded(absDirPath: string): boolean {
    return this.excludedDirs.has(normalizeDirPath(absDirPath));
  }

  getLoadedGitignoreDirs(): readonly string[] {
    return Array.from(this.dirInstances.keys());
  }

  dispose(): void {
    this.disposed = true;
    this.dirInstances.clear();
    this.dirPatterns.clear();
    this.excludedDirs.clear();
  }
}

export function createIgnoreEngine(options: IgnoreEngineOptions): IgnoreEngine {
  return new IgnoreEngine(options);
}
