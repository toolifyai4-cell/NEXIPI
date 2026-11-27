/**
 * Phase 11 Stage D — Executable resolution for supported platforms.
 *
 * Performs real filesystem-based executable resolution immediately before
 * process creation. This is the Stage D counterpart to the Stage C
 * `ExecutableResolver` interface: Stage C used a deterministic, no-I/O
 * resolver for policy comparison; Stage D performs actual PATH/PATHEXT
 * resolution against the host filesystem and returns the canonical
 * resolved path that Stage C's policy checks against.
 *
 * Security requirements:
 *   - Re-resolve immediately before spawning (no caching of resolved paths).
 *   - Re-check executable policy against the resolved identity.
 *   - Reject identity changes between approval binding and execution.
 *   - Never trust a previous validation result as proof the executable
 *     remains unchanged.
 *   - Do not follow unsafe executable paths outside the authorized strategy.
 *
 * TOCTOU limitation: Between resolution and spawn, the executable file
 * could be replaced. This is an unavoidable filesystem race. Callers must
 * treat resolved identity as a point-in-time check, not a guarantee.
 */

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as nodePath from 'node:path';

const posixJoin = nodePath.posix.join.bind(nodePath.posix);
import type {
  ExecutablePlatform,
  ExecutableResolutionResult,
} from './executable-policy.js';

/**
 * Options for executable resolution.
 *
 * `pathEnv` and `pathextEnv` are injected for testability. When omitted,
 * they default to `process.env.PATH` and `process.env.PATHEXT`.
 *
 * `statFile` is an injectable filesystem check. When omitted, it defaults
 * to `fs.access(path, constants.X_OK)` which checks execute permission.
 */
export interface ExecutableResolutionOptions {
  readonly platform: ExecutablePlatform;
  readonly cwd: string;
  readonly pathEnv?: string | undefined;
  readonly pathextEnv?: string | undefined;
  readonly statFile?: (filePath: string) => Promise<boolean> | boolean;
}

/**
 * Default statFile implementation using fs.access with X_OK.
 */
async function defaultStatFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits a PATH-like environment string into directory entries, filtering
 * out empty entries.
 *
 * On Windows, PATH entries are separated by ';' and may include drive letters
 * (e.g. `C:\Windows`). On POSIX, entries are separated by ':'.
 */
function splitPathEnv(pathEnv: string, platform: ExecutablePlatform): string[] {
  const separator = platform === 'win32' ? ';' : ':';
  return pathEnv.split(separator).filter(entry => entry.length > 0);
}

/**
 * Returns the PATHEXT extensions for Windows, defaulting to common
 * executable extensions when PATHEXT is not set.
 */
function defaultPathextList(pathextEnv?: string): string[] {
  if (pathextEnv) {
    return pathextEnv
      .split(';')
      .map(ext => ext.trim())
      .filter(ext => ext.length > 0);
  }
  return ['.exe', '.com'];
}

/**
 * Resolves an executable name or path to an absolute, canonical path.
 *
 * Resolution rules:
 *   - Absolute paths: used as-is (after normalization).
 *   - Relative names containing a path separator: resolved relative to cwd.
 *   - Bare names (no separator): searched through PATH directories.
 *     - On Windows, each PATHEXT extension is appended in order.
 *     - On POSIX, the bare name is tried as-is.
 *
 * Returns `{ kind: 'resolved', executable }` when a matching executable is
 * found, or `{ kind: 'rejected', reason }` when no executable can be
 * resolved.
 *
 * This function performs I/O and may throw on unexpected filesystem errors.
 */
export async function resolveExecutable(
  executable: string,
  options: ExecutableResolutionOptions
): Promise<ExecutableResolutionResult> {
  const {
    platform,
    cwd,
    pathEnv: pathEnvInput,
    pathextEnv: pathextEnvInput,
    statFile = defaultStatFile,
  } = options;

  const trimmed = executable.trim();
  if (trimmed.length === 0) {
    return { kind: 'rejected', reason: 'Executable must not be empty' };
  }

  const pathEnv = pathEnvInput ?? process.env['PATH'] ?? '';
  const pathextList = defaultPathextList(pathextEnvInput);

  // --- Case 1: Absolute path ---
  if (isAbsolutePath(trimmed, platform)) {
    const normalized = normalizePath(trimmed, platform);
    const exists = await statFile(normalized);
    if (!exists) {
      return { kind: 'rejected', reason: `Executable not found: ${normalized}` };
    }
    return {
      kind: 'resolved',
      executable: {
        resolvedPath: normalized,
        displayName: trimmed,
        platform,
      },
    };
  }

  // --- Case 2: Relative path containing a separator ---
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const resolved = platform === 'win32' ? nodePath.win32.join(cwd, trimmed) : posixJoin(cwd, trimmed);
    const normalized = normalizePath(resolved, platform);
    const exists = await statFile(normalized);
    if (!exists) {
      return { kind: 'rejected', reason: `Executable not found: ${normalized}` };
    }
    return {
      kind: 'resolved',
      executable: {
        resolvedPath: normalized,
        displayName: trimmed,
        platform,
      },
    };
  }

  // --- Case 3: Bare name — search PATH ---
  const pathDirs = splitPathEnv(pathEnv, platform);
  for (const dir of pathDirs) {
    const candidates: string[] = [];

    if (platform === 'win32') {
      // On Windows, try each PATHEXT extension in order.
      for (const ext of pathextList) {
        candidates.push(nodePath.win32.join(dir, `${trimmed}${ext}`));
      }
    } else {
      // On POSIX, try the bare name as-is.
      candidates.push(posixJoin(dir, trimmed));
    }

    for (const candidate of candidates) {
      const normalized = normalizePath(candidate, platform);
      const exists = await statFile(normalized);
      if (exists) {
        return {
          kind: 'resolved',
          executable: {
            resolvedPath: normalized,
            displayName: trimmed,
            platform,
          },
        };
      }
    }
  }

  return {
    kind: 'rejected',
    reason: `Executable not found in PATH: ${trimmed}`,
  };
}

/**
 * Checks whether a path is absolute for the given platform.
 */
function isAbsolutePath(value: string, platform: ExecutablePlatform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }
  return value.startsWith('/');
}

/**
 * Normalizes path separators for the given platform.
 */
function normalizePath(value: string, platform: ExecutablePlatform): string {
  if (platform === 'win32') {
    return value.replace(/\//g, '\\');
  }
  return value;
}
