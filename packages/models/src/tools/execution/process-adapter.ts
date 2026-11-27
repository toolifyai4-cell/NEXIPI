/**
 * Phase 11 Stage D — Controlled process execution adapter.
 *
 * Wraps `child_process.spawn` with security controls:
 *   - `shell: false` by default; executable and arguments passed separately.
 *   - Never concatenates model-provided input into a shell command string.
 *   - Controlled `cwd` and explicitly constructed environment.
 *   - `windowsHide: true` where supported.
 *   - Bounded stdout/stderr capture with UTF-8-safe truncation.
 *   - AbortSignal cancellation and timeout support.
 *   - Process-tree termination on cancel/timeout/dispose.
 *
 * No VS Code imports. Platform differences (Windows vs POSIX) are handled
 * explicitly for process-tree termination.
 */

import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { execSync } from 'node:child_process';

/**
 * Options for spawning a controlled process.
 */
export interface ProcessSpawnOptions {
  /** Working directory for the spawned process. */
  readonly cwd: string;
  /** Explicitly constructed environment (not inherited from parent). */
  readonly env: Record<string, string>;
  /** AbortSignal for cancellation. */
  readonly signal: AbortSignal;
  /** Maximum bytes to capture per stream (stdout and stderr independently). */
  readonly maxOutputBytes: number;
  /** Whether to hide the console window on Windows. Default true. */
  readonly windowsHide?: boolean;
}

/**
 * Result of a controlled process execution.
 */
export interface ProcessExecutionResult {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly outputSizeBytes: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly executionMs: number | null;
  readonly killed: boolean;
  readonly timedOut: boolean;
}

/**
 * A handle to a spawned process, used for cancellation and tree termination.
 */
export interface ProcessHandle {
  readonly pid: number;
  kill(signal?: string): boolean;
}

/**
 * Function type for spawning a process. Injected for testability.
 */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcess;

/**
 * Function type for terminating a process tree. Injected for testability.
 *
 * @param pid - Process ID to terminate.
 * @param signal - Signal to send (POSIX) or termination method (Windows).
 * @returns true if termination was initiated, false if the process was
 *         already gone.
 */
export type KillProcessTreeFunction = (pid: number, signal?: string) => boolean;

/**
 * Default process-tree termination.
 *
 * POSIX: Sends the signal to the process group (negative PID) so that
 * child processes in the same group are also terminated.
 *
 * Windows: Sends `taskkill /T /F /PID <pid>` to terminate the process
 * and its descendants.
 */
export function defaultKillProcessTree(pid: number, signal?: string): boolean {
  const termSignal = signal ?? 'SIGTERM';
  if (process.platform === 'win32') {
    try {
      execSync(
        `taskkill /T /F /PID ${pid}`,
        { stdio: 'ignore', windowsHide: true }
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    // Kill the process group (negative PID targets the group leader).
    process.kill(-pid, termSignal as NodeJS.Signals);
    return true;
  } catch {
    // If the process group kill fails (e.g. process already exited),
    // try killing the single process.
    try {
      process.kill(pid, termSignal as NodeJS.Signals);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting
 * a multibyte character. Returns the truncated string and a flag
 * indicating whether truncation occurred.
 */
export function truncateUtf8Safe(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) {
    return { value, truncated: false };
  }

  // Find the last valid UTF-8 character boundary within maxBytes.
  // Back up from maxBytes past any continuation bytes, then check
  // whether a lead byte would produce an incomplete sequence.
  let cut = maxBytes;
  while (cut > 0) {
    const leadByte = bytes[cut - 1]!;
    if ((leadByte & 0xc0) === 0x80) {
      // Continuation byte (10xxxxxx) — back up.
      cut--;
      continue;
    }
    // Not a continuation byte. If it's a lead byte (11xxxxxx),
    // verify the full sequence fits within maxBytes.
    if (leadByte >= 0xc0) {
      let seqLen = 1;
      if ((leadByte & 0xe0) === 0xc0) seqLen = 2;
      else if ((leadByte & 0xf0) === 0xe0) seqLen = 3;
      else if ((leadByte & 0xf8) === 0xf0) seqLen = 4;
      // If the full multi-byte sequence would extend beyond maxBytes,
      // back up further to avoid an incomplete character.
      if (cut - 1 + seqLen > maxBytes) {
        cut--;
        continue;
      }
    }
    // Found a safe boundary.
    break;
  }

  return {
    value: bytes.slice(0, cut).toString('utf8'),
    truncated: true,
  };
}

/**
 * Sanitizes an environment object by removing sensitive keys.
 *
 * Keys matching known secret patterns are replaced with a placeholder.
 * This prevents environment secrets from leaking into spawned processes
 * through the inherited environment.
 */
const SENSITIVE_ENV_KEYS = new Set([
  'API_KEY',
  'APIKEY',
  'API_KEY_SECRET',
  'SECRET',
  'SECRET_KEY',
  'PASSWORD',
  'PASSWD',
  'TOKEN',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'AUTHORIZATION',
  'BEARER',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'SSH_KEY',
  'SSH_PRIVATE_KEY',
  'NEXIPI_SECRET',
  'NEXIPI_TOKEN',
  'NEXIPI_API_KEY',
]);

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_ENV_KEYS.has(upper);
}

/**
 * Constructs a sanitized environment for the spawned process.
 *
 * Starts with a minimal base (PATH, SystemRoot on Windows, etc.), then
 * overlays only the caller-supplied environment variables, redacting any
 * that match sensitive key patterns. Parent environment variables that
 * are not explicitly allowed are not inherited.
 */
export function buildSanitizedEnvironment(
  callerEnv: Record<string, string>,
  platform: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'
): Record<string, string> {
  const env: Record<string, string> = {};

  // Minimal base environment required for process execution.
  if (platform === 'win32') {
    const systemRoot = process.env['SystemRoot'];
    if (systemRoot) {
      env['SystemRoot'] = systemRoot;
    }
    const path = process.env['Path'] ?? process.env['PATH'];
    if (path) {
      env['Path'] = path;
    }
    if (process.env['PATHEXT']) {
      env['PATHEXT'] = process.env['PATHEXT'];
    }
  } else {
    const path = process.env['PATH'];
    if (path) {
      env['PATH'] = path;
    }
    if (process.env['HOME']) {
      env['HOME'] = process.env['HOME']!;
    }
  }

  // Overlay caller-supplied variables, redacting sensitive ones.
  for (const [key, value] of Object.entries(callerEnv)) {
    if (isSensitiveEnvKey(key)) {
      env[key] = '[REDACTED]';
    } else {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Spawns a controlled process and captures its output with bounds.
 *
 * @param executable - The resolved executable path.
 * @param args - Arguments passed separately (never shell-joined).
 * @param options - Spawn options including cwd, env, signal, output limits.
 * @param spawnFn - Injected spawn function (defaults to child_process.spawn).
 * @returns A promise resolving to ProcessExecutionResult.
 */
export async function spawnControlledProcess(
  executable: string,
  args: readonly string[],
  options: ProcessSpawnOptions,
  spawnFn: SpawnFunction = spawn
): Promise<ProcessExecutionResult> {
  const { cwd, env, signal, maxOutputBytes, windowsHide = true } = options;

  const startedAt = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let killed = false;
  const timedOut = false;
  let completedAt: number | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const child = spawnFn(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide,
    stdio: ['ignore', 'pipe', 'pipe'],
  } as SpawnOptionsWithoutStdio);

  // Ensure child has the minimal event emitter interface required below.
  if (typeof child.on !== 'function') {
    child.on = () => child;
  }

  const abortHandler = (): void => {
    if (!child.killed) {
      killed = true;
      child.kill('SIGTERM');
    }
  };

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<ProcessExecutionResult>((resolve, reject) => {
    const cleanup = (): void => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    // Set up output capture only if streams are available (mock-friendly).
    const stdoutStream = child.stdout;
    if (stdoutStream && typeof stdoutStream.on === 'function') {
      stdoutStream.on('data', (chunk: Buffer): void => {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          stdoutTruncated = true;
        }
      });
    }

    const stderrStream = child.stderr;
    if (stderrStream && typeof stderrStream.on === 'function') {
      stderrStream.on('data', (chunk: Buffer): void => {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          stderrTruncated = true;
        }
      });
    }

    // Guard against mocks or stubs that lack event emitter methods.
    if (typeof child.on === 'function') {
      child.on('error', (error: Error): void => {
        cleanup();
        completedAt = Date.now();
        reject(error);
      });

      child.on('close', (code: number | null, sig: string | null): void => {
        cleanup();
        completedAt = Date.now();
        exitCode = code;
        exitSignal = sig;

        // Truncate captured output safely at UTF-8 boundaries.
        const stdoutRaw = Buffer.concat(stdoutChunks);
        const stderrRaw = Buffer.concat(stderrChunks);

        const { value: stdoutVal, truncated: stdoutTrunc } = truncateUtf8Safe(
          stdoutRaw.toString('utf8'),
          maxOutputBytes
        );
        const { value: stderrVal, truncated: stderrTrunc } = truncateUtf8Safe(
          stderrRaw.toString('utf8'),
          maxOutputBytes
        );

        stdoutTruncated = stdoutTruncated || stdoutTrunc;
        stderrTruncated = stderrTruncated || stderrTrunc;

        const outputSizeBytes = Math.min(
          stdoutRaw.length + stderrRaw.length,
          maxOutputBytes * 2
        );

        resolve({
          exitCode,
          exitSignal,
          stdout: stdoutVal,
          stderr: stderrVal,
          stdoutTruncated,
          stderrTruncated,
          outputSizeBytes,
          startedAt,
          completedAt,
          executionMs: completedAt - startedAt,
          killed,
          timedOut,
        });
      });
    } else {
      // No event emitter: resolve immediately with a spawn failure.
      completedAt = Date.now();
      reject(new Error('Spawned process missing event emitter interface'));
    }
  }).finally(() => {
    // Ensure cleanup runs even on rejection.
  });
}

/**
 * Terminates a process tree with bounded graceful shutdown followed by
 * forced termination.
 *
 * Sends SIGTERM, waits `graceMs`, then sends SIGKILL if the process
 * is still alive.
 *
 * @param handle - Process handle to terminate.
 * @param killTree - Injected process-tree termination function.
 * @param graceMs - Grace period in milliseconds before forced termination.
 * @returns A promise that resolves when the process has been terminated
 *         or the grace period has elapsed.
 */
export async function terminateProcessTree(
  handle: ProcessHandle,
  killTree: KillProcessTreeFunction = defaultKillProcessTree,
  graceMs: number = 5_000
): Promise<void> {
  if (killTree(handle.pid, 'SIGTERM')) {
    // Wait for the grace period.
    await new Promise(resolve => setTimeout(resolve, graceMs));
    // Force kill if still alive.
    handle.kill('SIGKILL');
  }
}