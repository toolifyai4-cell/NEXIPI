import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveExecutable, type ExecutableResolutionOptions } from '../executable-resolution.js';

const POSIX_CWD = '/workspace';
const WIN_CWD = 'C:\\workspace';

function makeOptions(overrides: Partial<ExecutableResolutionOptions> = {}): ExecutableResolutionOptions {
  return {
    platform: 'posix',
    cwd: POSIX_CWD,
    ...overrides,
  };
}

describe('resolveExecutable — posix absolute paths', () => {
  it('resolves an absolute path that exists', async () => {
    const statFile = vi.fn(async (path: string) => path === '/usr/bin/ls');
    const result = await resolveExecutable('/usr/bin/ls', makeOptions({ statFile }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/usr/bin/ls');
      expect(result.executable!.displayName).toBe('/usr/bin/ls');
      expect(result.executable!.platform).toBe('posix');
    }
  });

  it('rejects an absolute path that does not exist', async () => {
    const statFile = vi.fn(async () => false);
    const result = await resolveExecutable('/usr/bin/nonexistent', makeOptions({ statFile }));
    expect(result.kind).toBe('rejected');
    expect(result.reason).toContain('not found');
  });

  it('rejects an empty executable', async () => {
    const result = await resolveExecutable('', makeOptions());
    expect(result.kind).toBe('rejected');
    expect(result.reason).toContain('empty');
  });
});

describe('resolveExecutable — posix relative paths with separator', () => {
  it('resolves a relative path with separator against cwd', async () => {
    const statFile = vi.fn(async (path: string) => path === '/workspace/sub/tool');
    const result = await resolveExecutable('sub/tool', makeOptions({ statFile }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/workspace/sub/tool');
    }
  });

  it('rejects a relative path that does not exist', async () => {
    const statFile = vi.fn(async () => false);
    const result = await resolveExecutable('sub/nonexistent', makeOptions({ statFile }));
    expect(result.kind).toBe('rejected');
  });
});

describe('resolveExecutable — posix bare name PATH search', () => {
  it('resolves a bare name found in PATH', async () => {
    const statFile = vi.fn(async (path: string) => path === '/usr/local/bin/ls');
    const result = await resolveExecutable('ls', makeOptions({
      statFile,
      pathEnv: '/usr/local/bin:/usr/bin',
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/usr/local/bin/ls');
    }
  });

  it('searches PATH directories in order', async () => {
    const statFile = vi.fn(async (path: string) => {
      // Only the second directory has the executable.
      return path === '/usr/bin/ls';
    });
    const result = await resolveExecutable('ls', makeOptions({
      statFile,
      pathEnv: '/usr/local/bin:/usr/bin',
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/usr/bin/ls');
    }
  });

  it('rejects a bare name not found in any PATH directory', async () => {
    const statFile = vi.fn(async () => false);
    const result = await resolveExecutable('nonexistent', makeOptions({
      statFile,
      pathEnv: '/usr/bin:/bin',
    }));
    expect(result.kind).toBe('rejected');
    expect(result.reason).toContain('not found in PATH');
  });

  it('uses default PATH from process.env when not provided', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/custom/bin';
    try {
      const statFile = vi.fn(async (path: string) => path === '/custom/bin/ls');
      const result = await resolveExecutable('ls', makeOptions({ statFile }));
      expect(result.kind).toBe('resolved');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('resolveExecutable — win32', () => {
  it('resolves an absolute Windows path', async () => {
    const statFile = vi.fn(async (path: string) => path === 'C:\\Windows\\System32\\where.exe');
    const result = await resolveExecutable('C:\\Windows\\System32\\where.exe', makeOptions({
      platform: 'win32',
      cwd: WIN_CWD,
      statFile,
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\Windows\\System32\\where.exe');
      expect(result.executable!.platform).toBe('win32');
    }
  });

  it('resolves a UNC path', async () => {
    const statFile = vi.fn(async (path: string) => path === '\\\\server\\share\\tool.exe');
    const result = await resolveExecutable('\\\\server\\share\\tool.exe', makeOptions({
      platform: 'win32',
      cwd: WIN_CWD,
      statFile,
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('\\\\server\\share\\tool.exe');
    }
  });

  it('resolves a relative name against Windows cwd', async () => {
    const statFile = vi.fn(async (path: string) => path === 'C:\\workspace\\sub\\tool.exe');
    const result = await resolveExecutable('sub\\tool.exe', makeOptions({
      platform: 'win32',
      cwd: WIN_CWD,
      statFile,
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\workspace\\sub\\tool.exe');
    }
  });

  it('tries PATHEXT extensions on Windows', async () => {
    const statFile = vi.fn(async (path: string) => path === 'C:\\Windows\\tool.cmd');
    const result = await resolveExecutable('tool', makeOptions({
      platform: 'win32',
      cwd: 'C:\\Windows',
      statFile,
      pathEnv: 'C:\\Windows',
      pathextEnv: '.COM;.EXE;.BAT;.CMD',
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\Windows\\tool.cmd');
    }
  });

  it('normalizes forward slashes to backslashes on Windows', async () => {
    const statFile = vi.fn(async (path: string) => path === 'C:\\Windows\\tool.exe');
    const result = await resolveExecutable('C:/Windows/tool.exe', makeOptions({
      platform: 'win32',
      cwd: WIN_CWD,
      statFile,
    }));
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\Windows\\tool.exe');
    }
  });
});

describe('resolveExecutable — TOCTOU considerations', () => {
  it('re-resolves each call (no caching)', async () => {
    const callPaths: string[] = [];
    const statFile = vi.fn(async (path: string) => {
      callPaths.push(path);
      return path === '/usr/bin/ls';
    });

    await resolveExecutable('/usr/bin/ls', makeOptions({ statFile }));
    await resolveExecutable('/usr/bin/ls', makeOptions({ statFile }));

    expect(callPaths.length).toBe(2);
    expect(callPaths[0]).toBe('/usr/bin/ls');
    expect(callPaths[1]).toBe('/usr/bin/ls');
  });

  it('resolves to exact identity, not just name', async () => {
    const statFile = vi.fn(async (path: string) => path === '/usr/bin/ls');
    const result1 = await resolveExecutable('/usr/bin/ls', makeOptions({ statFile }));
    const result2 = await resolveExecutable('ls', makeOptions({
      statFile,
      pathEnv: '/usr/bin',
    }));

    expect(result1.kind).toBe('resolved');
    expect(result2.kind).toBe('resolved');
    if (result1.kind === 'resolved' && result2.kind === 'resolved') {
      // Same resolved path means same identity
      expect(result1.executable!.resolvedPath).toBe(result2.executable!.resolvedPath);
    }
  });
});
