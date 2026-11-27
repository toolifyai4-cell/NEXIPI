/**
 * Phase 11 Stage C — Terminal command validation layer.
 *
 * Pure, platform-independent structural validation of terminal commands.
 * No child_process, no VS Code, no shell spawning, no host filesystem access.
 *
 * This layer validates that a proposed command is well-formed and within
 * defined safety boundaries BEFORE it reaches the permission policy or the
 * execution adapter. It does NOT decide whether an executable is permitted
 * (that is the executable policy's job) and it does NOT check user approval
 * (that is Stage E's job).
 *
 * Validation is structural and deterministic:
 *   - Executable: non-empty, within length, no null bytes, no shell
 *     metacharacters, no path traversal components.
 *   - Arguments: array within count limit, each within length, no null bytes,
 *     no shell metacharacters.
 *   - Working directory: non-empty, absolute path, within length, no traversal
 *     components ('..' as a path component).
 *   - Workspace identity: non-empty string.
 *   - Environment configuration reference: valid structure when present.
 *   - Total command line length within limit.
 *
 * An optional workspace boundary validator may be injected to enforce lexical
 * workspace containment and symlink-free paths using @nexipi/workspace
 * utilities; when omitted, only structural checks run.
 */

import type { TerminalCommand, TerminalExecutionLimits } from './contracts.js';
import { DEFAULT_TERMINAL_EXECUTION_LIMITS } from './contracts.js';
import { TerminalErrorCode, createTerminalError, isTerminalError } from './errors.js';

/**
 * Callback for validating that a working directory is within the workspace
 * boundary and free of symlinks. Implemented by callers using
 * @nexipi/workspace utilities (validateWorkspaceBoundary,
 * validateSymlinkFreePath). When omitted, only structural validation runs.
 */
export interface WorkspaceBoundaryValidator {
  /**
   * @param workingDirectory - The absolute working directory path.
   * @param workspaceId - The workspace identity the command targets.
   * @throws when the directory is outside the workspace, is a symlink, or
   *         cannot be safely inspected. Fail closed.
   */
  validate(workingDirectory: string, workspaceId: string): void | Promise<void>;
}

/**
 * Result of command validation.
 */
export interface ValidatedTerminalCommand {
  readonly kind: 'validated-terminal-command';
  readonly command: TerminalCommand;
}

/**
 * Characters forbidden in executable names, arguments, and paths because they
 * enable shell injection, command chaining, redirection, or command
 * substitution. These are checked in addition to the Zod schema constraints.
 */
const FORBIDDEN_COMMAND_CHARS = new Set([
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
]);

const NULL_BYTE = '\0';

/**
 * Path traversal component. A path whose segments include '..' can escape
 * the intended directory.
 */
function hasTraversalComponent(pathValue: string): boolean {
  const segments = pathValue.split(/[/\\]/);
  return segments.includes('..');
}

function containsNullByte(value: string): boolean {
  return value.includes(NULL_BYTE);
}

function containsForbiddenChars(value: string): boolean {
  for (const ch of value) {
    if (FORBIDDEN_COMMAND_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

function isAbsolutePath(value: string): boolean {
  // Windows: drive letter + colon + slash/backslash, or UNC.
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    return true;
  }
  return value.startsWith('/');
}

/**
 * Validates a TerminalCommand structurally and (optionally) against the
 * workspace boundary.
 *
 * @param command - The command to validate.
 * @param limits - Execution limits to enforce. Defaults to the Stage B
 *        defaults.
 * @param boundaryValidator - Optional workspace boundary validator.
 * @returns The validated command.
 * @throws TerminalError with an appropriate TerminalErrorCode when the
 *         command is invalid.
 */
export async function validateTerminalCommandSecurity(
  command: TerminalCommand,
  limits: TerminalExecutionLimits = DEFAULT_TERMINAL_EXECUTION_LIMITS,
  boundaryValidator?: WorkspaceBoundaryValidator
): Promise<ValidatedTerminalCommand> {
  // --- Executable ---
  const executable = command.executable;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw createTerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Executable is required');
  }
  if (executable.trim().length === 0) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Executable must not be whitespace only'
    );
  }
  if (executable.length > limits.maxExecutableLength) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      `Executable exceeds ${limits.maxExecutableLength} characters`
    );
  }
  if (containsNullByte(executable)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Executable must not contain null bytes'
    );
  }
  if (containsForbiddenChars(executable)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Executable contains forbidden characters'
    );
  }
  // Reject path traversal in the executable itself.
  if (hasTraversalComponent(executable)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Executable must not contain path traversal components'
    );
  }

  // --- Arguments ---
  const argumentsList: readonly string[] = command.arguments;
  if (!Array.isArray(argumentsList)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Arguments must be an array'
    );
  }
  if (argumentsList.length > limits.maxArgumentsCount) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      `Too many arguments (maximum ${limits.maxArgumentsCount})`
    );
  }
  for (const arg of argumentsList) {
    if (typeof arg !== 'string') {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Each argument must be a string'
      );
    }
    if (arg.length > limits.maxArgumentLength) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        `Argument exceeds ${limits.maxArgumentLength} characters`
      );
    }
    if (containsNullByte(arg)) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Arguments must not contain null bytes'
      );
    }
    if (containsForbiddenChars(arg)) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Arguments contain forbidden characters'
      );
    }
  }

  // --- Working directory ---
  const workingDirectory = command.workingDirectory;
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Working directory is required'
    );
  }
  if (workingDirectory.length > limits.maxWorkingDirectoryLength) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      `Working directory exceeds ${limits.maxWorkingDirectoryLength} characters`
    );
  }
  if (!isAbsolutePath(workingDirectory)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Working directory must be an absolute path'
    );
  }
  if (containsNullByte(workingDirectory)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Working directory must not contain null bytes'
    );
  }
  if (containsForbiddenChars(workingDirectory)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Working directory contains forbidden characters'
    );
  }
  if (hasTraversalComponent(workingDirectory)) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Working directory must not contain path traversal components'
    );
  }

  // --- Workspace identity ---
  const workspaceId = command.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Workspace identity is required'
    );
  }

  // --- Environment configuration reference ---
  const envConfig = command.environmentConfig;
  if (envConfig !== undefined) {
    if (typeof envConfig.id !== 'string' || envConfig.id.length === 0) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Environment configuration id is required when a reference is provided'
      );
    }
    if (envConfig.name !== undefined && typeof envConfig.name !== 'string') {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Environment configuration name must be a string when provided'
      );
    }
    if (envConfig.name !== undefined && envConfig.name.length > 256) {
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        'Environment configuration name exceeds 256 characters'
      );
    }
  }

  // --- Total command line length ---
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const commandLine = [executable, ...argumentsList].join(' ');
  const totalLength = commandLine.length;
  if (totalLength > limits.maxCommandLineLength) {
    throw createTerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      `Command line length exceeds ${limits.maxCommandLineLength} characters`
    );
  }

  // --- Workspace boundary (optional, injected) ---
  if (boundaryValidator !== undefined) {
    try {
      await boundaryValidator.validate(workingDirectory, workspaceId);
    } catch (error) {
      if (isTerminalError(error)) {
        throw error;
      }
      throw createTerminalError(
        TerminalErrorCode.TERMINAL_INVALID_REQUEST,
        `Working directory is not authorized: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    kind: 'validated-terminal-command',
    command,
  };
}

/**
 * Synchronous wrapper around validateTerminalCommandSecurity for callers
 * that do not need the optional async boundary validator.
 */
export function validateTerminalCommandSecuritySync(
  command: TerminalCommand,
  limits: TerminalExecutionLimits = DEFAULT_TERMINAL_EXECUTION_LIMITS
): ValidatedTerminalCommand {
  return validateTerminalCommandSecurity(command, limits) as unknown as ValidatedTerminalCommand;
}

/**
 * Type guard for a validated terminal command result.
 */
export function isValidatedTerminalCommand(value: unknown): value is ValidatedTerminalCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ValidatedTerminalCommand).kind === 'validated-terminal-command'
  );
}
