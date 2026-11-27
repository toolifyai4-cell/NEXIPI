/**
 * Phase 11 Stage C — Executable identity and resolution strategy.
 *
 * Platform-independent domain logic for determining which executables are
 * permitted for terminal execution. No child_process, no VS Code, no shell
 * spawning, no actual PATH resolution against the host filesystem.
 *
 * Core security principle: executable identity is separated from argument
 * data. The executable is resolved to a canonical identity *before* any
 * argument is considered, and only explicitly permitted executables may run.
 * Default deny: nothing is permitted unless the policy allows it.
 *
 * The default policy ships with a minimal allowlist of commonly safe,
 * read-oriented executables. It intentionally excludes shell interpreters
 * (cmd, powershell, bash, sh, zsh), package managers capable of arbitrary
 * scripts (npm, yarn, pip, cargo), and any executable that can launch other
 * programs. Stage D/E operators may extend the allowlist, but additions must
 * be reviewed for their ability to spawn subprocesses or access files outside
 * the workspace.
 */

import { createHash } from 'node:crypto';
import type { TerminalErrorCode } from './errors.js';
import { TerminalError, createTerminalError } from './errors.js';
import type {
  TerminalExecutionLimits,
  DEFAULT_TERMINAL_EXECUTION_LIMITS,
} from './contracts.js';

/**
 * The platform family the resolver targets. Used to apply platform-specific
 * executable extension rules without importing OS-specific modules.
 */
export type ExecutablePlatform = 'win32' | 'posix';

/**
 * A resolved, canonical executable identity.
 *
 * `resolvedPath` is the absolute, normalized path to the executable.
 * `displayName` is the name as supplied by the caller (for diagnostics only;
 * never used to locate the executable).
 * `platform` is the platform the identity was resolved against.
 */
export interface ResolvedExecutable {
  readonly resolvedPath: string;
  readonly displayName: string;
  readonly platform: ExecutablePlatform;
}

/**
 * The outcome of resolving an executable identity.
 */
export interface ExecutableResolutionResult {
  readonly kind: 'resolved' | 'rejected';
  readonly executable?: ResolvedExecutable;
  readonly reason?: string;
}

/**
 * Permitted executable identity entries in the allowlist.
 *
 * Each entry is matched by the canonical resolved path. Entries are
 * deliberately narrow: an allowlisted `node` does not permit `node` located
 * elsewhere, and an allowlisted absolute path does not permit a same-named
 * executable in a different directory.
 */
export interface PermittedExecutableEntry {
  readonly resolvedPath: string;
  readonly displayName: string;
  readonly platform: ExecutablePlatform;
  readonly notes?: string;
}

/**
 * Strategy for resolving an executable name or path to a canonical identity.
 *
 * Implementations may perform platform-specific PATH resolution. The default
 * implementation is deterministic and does not touch the host filesystem,
 * making it fully testable with doubles.
 */
export interface ExecutableResolver {
  /**
   * Resolves an executable supplied by the model to a canonical identity.
   *
   * @param executable - The executable name or path as supplied by the model.
   * @param cwd - The working directory the command would run in, used to
   *        resolve relative paths and for diagnostics.
   * @returns A resolution result. `rejected` means the executable cannot be
   *         safely identified or resolved.
   */
  resolve(
    executable: string,
    cwd: string
  ): ExecutableResolutionResult | Promise<ExecutableResolutionResult>;
}

/**
 * Policy for deciding whether a resolved executable may be executed.
 */
export interface ExecutablePolicy {
  readonly name: string;
  readonly platform: ExecutablePlatform;

  /**
   * Returns true when the resolved executable is explicitly permitted.
   */
  isExecutablePermitted(identity: ResolvedExecutable): boolean;

  /**
   * Returns the list of permitted executable entries (for diagnostics only;
   * never exposed to the model).
   */
  listPermittedExecutables(): readonly PermittedExecutableEntry[];
}

/**
 * Result of checking an executable against policy.
 */
export interface ExecutablePermissionCheck {
  readonly permitted: boolean;
  readonly identity?: ResolvedExecutable;
  readonly reason?: string;
}

/**
 * Executable extensions considered on Windows. POSIX has no executable
 * extension convention.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Characters that are never permitted in an executable name or path because
 * they can be used for command injection, path traversal, or shell
 * metacharacter abuse. Null bytes are rejected separately.
 */
const FORBIDDEN_EXECUTABLE_CHARS = new Set([
  ';',
  '&',
  '|',
  '<',
  '>',
  '`',
  '$',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '\n',
  '\r',
  '\t',
]);

/**
 * Null byte character code, checked explicitly because string operations may
 * silently truncate or mishandle it on some platforms.
 */
const NULL_BYTE = '\0';

function hasForbiddenCharacters(value: string): boolean {
  for (const ch of value) {
    if (FORBIDDEN_EXECUTABLE_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

function containsNullByte(value: string): boolean {
  return value.includes(NULL_BYTE);
}

function isAbsolutePath(value: string, platform: ExecutablePlatform): boolean {
  if (platform === 'win32') {
    // Windows absolute path: drive letter + colon + slash/backslash, or UNC.
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }
  return value.startsWith('/');
}

function normalizeSeparators(value: string, platform: ExecutablePlatform): string {
  if (platform === 'win32') {
    return value.replace(/\//g, '\\');
  }
  return value;
}

function stripWindowsExtension(value: string): string {
  for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
    if (value.toLowerCase().endsWith(ext.toLowerCase())) {
      return value.slice(0, -ext.length);
    }
  }
  return value;
}

/**
 * Default executable resolver.
 *
 * Resolution rules:
 *   - Absolute paths are used as-is (normalized separators).
 *   - Relative names are treated as executable names to be resolved against
   *   PATH. Since this module does not read the host PATH, relative names
   *   resolve to `<cwd>/<name>` for identity purposes only; the actual
   *   adapter (Stage D) is responsible for real PATH lookup at execution
   *   time and must re-verify identity against this policy.
 *   - Windows executable extensions are stripped for comparison purposes but
   *   preserved in the resolved path.
 *
 * This resolver never touches the filesystem. It produces a deterministic
 * identity suitable for allowlist comparison.
 */
export class DefaultExecutableResolver implements ExecutableResolver {
  private readonly platform: ExecutablePlatform;

  constructor(platform: ExecutablePlatform = 'posix') {
    this.platform = platform;
  }

  resolve(
    executable: string,
    cwd: string
  ): ExecutableResolutionResult {
    if (typeof executable !== 'string' || executable.length === 0) {
      return { kind: 'rejected', reason: 'Executable must be a non-empty string' };
    }

    if (containsNullByte(executable)) {
      return { kind: 'rejected', reason: 'Executable must not contain null bytes' };
    }

    if (hasForbiddenCharacters(executable)) {
      return {
        kind: 'rejected',
        reason: 'Executable contains forbidden characters',
      };
    }

    const trimmed = executable.trim();
    if (trimmed.length === 0) {
      return { kind: 'rejected', reason: 'Executable must not be whitespace only' };
    }

    let resolvedPath: string;
    if (isAbsolutePath(trimmed, this.platform)) {
      resolvedPath = normalizeSeparators(trimmed, this.platform);
    } else {
      // Relative executable name: resolve against cwd for identity.
      // Stage D must perform real PATH resolution and re-verify against policy.
      const cwdNormalized = normalizeSeparators(cwd, this.platform);
      resolvedPath = cwdNormalized.endsWith('\\') || cwdNormalized.endsWith('/')
        ? cwdNormalized + trimmed
        : `${cwdNormalized}/${trimmed}`;
    }

    const identity: ResolvedExecutable = {
      resolvedPath,
      displayName: trimmed,
      platform: this.platform,
    };

    return { kind: 'resolved', executable: identity };
  }
}

/**
 * Hash of an executable identity for stable comparison and logging.
 */
export function hashExecutableIdentity(identity: ResolvedExecutable): string {
  const canonical = JSON.stringify({
    resolvedPath: identity.resolvedPath,
    displayName: identity.displayName,
    platform: identity.platform,
  });
  const buffer = Buffer.from(canonical, 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Default executable policy.
 *
 * Ships with a minimal allowlist of read-oriented executables that are
 * generally safe when invoked with controlled arguments. Shell interpreters
 * and package managers are intentionally excluded.
 *
 * The allowlist is deliberately conservative. Adding entries is a security
 * decision that must be reviewed case by case.
 */
export class DefaultExecutablePolicy implements ExecutablePolicy {
  private readonly permitted: Map<string, PermittedExecutableEntry>;

  constructor(
    platform: ExecutablePlatform = 'posix',
    entries: readonly PermittedExecutableEntry[] = []
  ) {
    this.platform = platform;
    this.permitted = new Map();
    for (const entry of entries) {
      this.permitted.set(entry.resolvedPath, entry);
    }
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const defaults: PermittedExecutableEntry[] = [
      // Read-oriented, commonly safe executables. None of these spawn a
      // general shell or execute arbitrary scripts from arguments alone.
      {
        resolvedPath: '/usr/bin/ls',
        displayName: 'ls',
        platform: 'posix',
        notes: 'List directory contents (read-only).',
      },
      {
        resolvedPath: '/usr/bin/cat',
        displayName: 'cat',
        platform: 'posix',
        notes: 'Display file contents (read-only).',
      },
      {
        resolvedPath: '/usr/bin/find',
        displayName: 'find',
        platform: 'posix',
        notes: 'Search for files (read-only).',
      },
      {
        resolvedPath: '/usr/bin/git',
        displayName: 'git',
        platform: 'posix',
        notes: 'Version control; read-only subcommands preferred.',
      },
      {
        resolvedPath: 'C:\\Windows\\System32\\where.exe',
        displayName: 'where',
        platform: 'win32',
        notes: 'Locate files (read-only).',
      },
    ];

    for (const entry of defaults) {
      if (!this.permitted.has(entry.resolvedPath)) {
        this.permitted.set(entry.resolvedPath, entry);
      }
    }
  }

  get name(): string {
    return 'default-executable-policy';
  }

  get platform(): ExecutablePlatform {
    return this.platform;
  }

  isExecutablePermitted(identity: ResolvedExecutable): boolean {
    return this.permitted.has(identity.resolvedPath);
  }

  listPermittedExecutables(): readonly PermittedExecutableEntry[] {
    return [...this.permitted.values()];
  }

  /**
   * Adds an entry to the allowlist. Exposed for configuration; callers must
   * review each addition for subprocess-spawning or file-access risk.
   */
  addEntry(entry: PermittedExecutableEntry): void {
    this.permitted.set(entry.resolvedPath, entry);
  }

  /**
   * Removes an entry from the allowlist.
   */
  removeEntry(resolvedPath: string): boolean {
    return this.permitted.delete(resolvedPath);
  }
}

/**
 * Creates a default executable resolver for the current platform.
 * The platform is an explicit parameter so tests can target either platform
 * without depending on the host OS.
 */
export function createDefaultExecutableResolver(
  platform: ExecutablePlatform = 'posix'
): ExecutableResolver {
  return new DefaultExecutableResolver(platform);
}

/**
 * Creates a default executable policy with the built-in allowlist.
 */
export function createDefaultExecutablePolicy(
  platform: ExecutablePlatform = 'posix',
  entries?: readonly PermittedExecutableEntry[]
): ExecutablePolicy {
  return new DefaultExecutablePolicy(platform, entries);
}

/**
 * Checks whether an executable name or path is permitted by policy, resolving
 * it first. Returns a structured check result.
 *
 * @param resolver - Executable resolver to use.
 * @param policy - Executable policy to check against.
 * @param executable - Executable name or path from the model.
 * @param cwd - Working directory for relative name resolution.
 */
export async function checkExecutablePermission(
  resolver: ExecutableResolver,
  policy: ExecutablePolicy,
  executable: string,
  cwd: string
): Promise<ExecutablePermissionCheck> {
  let resolution: ExecutableResolutionResult;
  try {
    resolution = await resolver.resolve(executable, cwd);
  } catch (error) {
    return {
      permitted: false,
      reason: `Executable resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (resolution.kind === 'rejected' || !resolution.executable) {
    return { permitted: false, reason: resolution.reason ?? 'Executable could not be resolved' };
  }

  const identity = resolution.executable;
  const permitted = policy.isExecutablePermitted(identity);

  return {
    permitted,
    identity,
    reason: permitted
      ? undefined
      : `Executable '${identity.displayName}' is not permitted by the executable policy`,
  };
}
