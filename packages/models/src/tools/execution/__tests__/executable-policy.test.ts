import { describe, it, expect } from 'vitest';
import {
  DefaultExecutableResolver,
  DefaultExecutablePolicy,
  createDefaultExecutableResolver,
  createDefaultExecutablePolicy,
  checkExecutablePermission,
  type ExecutableResolver,
  type ExecutablePolicy,
  type ResolvedExecutable,
  type ExecutablePermissionCheck,
  type PermittedExecutableEntry,
  hashExecutableIdentity,
} from '../executable-policy.js';

const POSIX_CWD = '/workspace';
const WIN_CWD = 'C:\\workspace';

describe('DefaultExecutableResolver — posix', () => {
  const resolver = new DefaultExecutableResolver('posix');

  it('resolves an absolute posix path', () => {
    const result = resolver.resolve('/usr/bin/ls', POSIX_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/usr/bin/ls');
      expect(result.executable!.displayName).toBe('/usr/bin/ls');
      expect(result.executable!.platform).toBe('posix');
    }
  });

  it('resolves a relative executable name against cwd', () => {
    const result = resolver.resolve('ls', POSIX_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/workspace/ls');
    }
  });

  it('rejects an empty executable', () => {
    const result = resolver.resolve('', POSIX_CWD);
    expect(result.kind).toBe('rejected');
    expect(result.reason).toContain('non-empty');
  });

  it('rejects a null byte in the executable', () => {
    const result = resolver.resolve('ls\0', POSIX_CWD);
    expect(result.kind).toBe('rejected');
    expect(result.reason).toContain('null bytes');
  });

  it('rejects forbidden characters in the executable', () => {
    for (const exec of ['ls;rm', 'ls&rm', 'ls|rm', 'ls`id`', 'ls$(id)', 'ls<file', 'ls>file']) {
      const result = resolver.resolve(exec, POSIX_CWD);
      expect(result.kind).toBe('rejected');
      expect(result.reason).toContain('forbidden');
    }
  });

  it('resolves an executable with path traversal components (security check happens at validation layer)', () => {
    const result = resolver.resolve('../bin/ls', POSIX_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('/workspace/../bin/ls');
    }
  });

  it('rejects whitespace-only executable', () => {
    const result = resolver.resolve('   ', POSIX_CWD);
    expect(result.kind).toBe('rejected');
  });
});

describe('DefaultExecutableResolver — win32', () => {
  const resolver = new DefaultExecutableResolver('win32');

  it('resolves an absolute windows path', () => {
    const result = resolver.resolve('C:\\Windows\\System32\\where.exe', WIN_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\Windows\\System32\\where.exe');
      expect(result.executable!.platform).toBe('win32');
    }
  });

  it('resolves a UNC path', () => {
    const result = resolver.resolve('\\\\server\\share\\tool.exe', WIN_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('\\\\server\\share\\tool.exe');
    }
  });

  it('resolves a relative name against windows cwd', () => {
    const result = resolver.resolve('where.exe', WIN_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\workspace\\where.exe');
    }
  });

  it('normalizes forward slashes to backslashes on windows', () => {
    const result = resolver.resolve('C:/Windows/System32/where.exe', WIN_CWD);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.executable!.resolvedPath).toBe('C:\\Windows\\System32\\where.exe');
    }
  });
});

describe('createDefaultExecutableResolver', () => {
  it('creates a resolver for posix by default', () => {
    const resolver = createDefaultExecutableResolver();
    const result = resolver.resolve('/usr/bin/ls', '/workspace');
    expect(result.kind).toBe('resolved');
  });

  it('creates a resolver for win32 when requested', () => {
    const resolver = createDefaultExecutableResolver('win32');
    const result = resolver.resolve('C:\\tool.exe', 'C:\\workspace');
    expect(result.kind).toBe('resolved');
  });
});

describe('DefaultExecutablePolicy — default allowlist', () => {
  const policy = new DefaultExecutablePolicy('posix');

  it('permits seeded posix executables', () => {
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' })).toBe(true);
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/cat', displayName: 'cat', platform: 'posix' })).toBe(true);
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/git', displayName: 'git', platform: 'posix' })).toBe(true);
  });

  it('denies executables not in the allowlist', () => {
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/rm', displayName: 'rm', platform: 'posix' })).toBe(false);
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/bash', displayName: 'bash', platform: 'posix' })).toBe(false);
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/npm', displayName: 'npm', platform: 'posix' })).toBe(false);
  });

  it('denies a same-named executable at a different path', () => {
    expect(policy.isExecutablePermitted({ resolvedPath: '/tmp/ls', displayName: 'ls', platform: 'posix' })).toBe(false);
  });

  it('lists permitted executables', () => {
    const entries = policy.listPermittedExecutables();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(e => e.resolvedPath === '/usr/bin/ls')).toBe(true);
  });

  it('has the correct name', () => {
    expect(policy.name).toBe('default-executable-policy');
  });

  it('has the correct platform', () => {
    expect(policy.platform).toBe('posix');
  });
});

describe('DefaultExecutablePolicy — add/remove entries', () => {
  it('adds a custom entry', () => {
    const policy = new DefaultExecutablePolicy('posix');
    policy.addEntry({
      resolvedPath: '/usr/bin/custom',
      displayName: 'custom',
      platform: 'posix',
      notes: 'custom tool',
    });
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/custom', displayName: 'custom', platform: 'posix' })).toBe(true);
  });

  it('removes an entry', () => {
    const policy = new DefaultExecutablePolicy('posix');
    expect(policy.removeEntry('/usr/bin/ls')).toBe(true);
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' })).toBe(false);
    expect(policy.removeEntry('/nonexistent')).toBe(false);
  });
});

describe('createDefaultExecutablePolicy', () => {
  it('creates a policy with seed defaults', () => {
    const policy = createDefaultExecutablePolicy('posix');
    expect(policy.isExecutablePermitted({ resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' })).toBe(true);
  });

  it('creates a win32 policy', () => {
    const policy = createDefaultExecutablePolicy('win32');
    expect(policy.platform).toBe('win32');
    expect(policy.isExecutablePermitted({ resolvedPath: 'C:\\Windows\\System32\\where.exe', displayName: 'where', platform: 'win32' })).toBe(true);
  });
});

describe('checkExecutablePermission', () => {
  it('returns permitted for an allowlisted executable', async () => {
    const resolver = new DefaultExecutableResolver('posix');
    const policy = new DefaultExecutablePolicy('posix');
    const result = await checkExecutablePermission(resolver, policy, '/usr/bin/ls', POSIX_CWD);
    expect(result.permitted).toBe(true);
    expect(result.identity?.resolvedPath).toBe('/usr/bin/ls');
  });

  it('returns not permitted for a non-allowlisted executable', async () => {
    const resolver = new DefaultExecutableResolver('posix');
    const policy = new DefaultExecutablePolicy('posix');
    const result = await checkExecutablePermission(resolver, policy, '/usr/bin/rm', POSIX_CWD);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain('not permitted');
  });

  it('returns not permitted for an unresolvable executable', async () => {
    const resolver = new DefaultExecutableResolver('posix');
    const policy = new DefaultExecutablePolicy('posix');
    const result = await checkExecutablePermission(resolver, policy, '', POSIX_CWD);
    expect(result.permitted).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('returns identity when permitted', async () => {
    const resolver = new DefaultExecutableResolver('posix');
    const policy = new DefaultExecutablePolicy('posix');
    const result = await checkExecutablePermission(resolver, policy, '/usr/bin/ls', POSIX_CWD);
    expect(result.permitted).toBe(true);
    expect(result.identity).toBeDefined();
  });

  it('returns identity for diagnostics even when not permitted', async () => {
    const resolver = new DefaultExecutableResolver('posix');
    const policy = new DefaultExecutablePolicy('posix');
    const result = await checkExecutablePermission(resolver, policy, '/usr/bin/rm', POSIX_CWD);
    expect(result.permitted).toBe(false);
    expect(result.identity?.resolvedPath).toBe('/usr/bin/rm');
  });
});

describe('hashExecutableIdentity', () => {
  it('produces a stable 64-char hex hash', () => {
    const identity: ResolvedExecutable = { resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' };
    const hash1 = hashExecutableIdentity(identity);
    const hash2 = hashExecutableIdentity(identity);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash1)).toBe(true);
  });

  it('produces different hashes for different identities', () => {
    const a = { resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' };
    const b = { resolvedPath: '/usr/bin/cat', displayName: 'cat', platform: 'posix' };
    expect(hashExecutableIdentity(a)).not.toBe(hashExecutableIdentity(b));
  });
});

describe('PermittedExecutableEntry', () => {
  it('supports optional notes', () => {
    const entry: PermittedExecutableEntry = {
      resolvedPath: '/usr/bin/ls',
      displayName: 'ls',
      platform: 'posix',
      notes: 'List directory contents',
    };
    expect(entry.notes).toBe('List directory contents');
  });

  it('works without notes', () => {
    const entry: PermittedExecutableEntry = {
      resolvedPath: '/usr/bin/ls',
      displayName: 'ls',
      platform: 'posix',
    };
    expect(entry.notes).toBeUndefined();
  });
});

describe('ExecutablePermissionCheck type', () => {
  it('represents a permitted check', () => {
    const check: ExecutablePermissionCheck = {
      permitted: true,
      identity: { resolvedPath: '/usr/bin/ls', displayName: 'ls', platform: 'posix' },
    };
    expect(check.permitted).toBe(true);
  });

  it('represents a denied check', () => {
    const check: ExecutablePermissionCheck = {
      permitted: false,
      reason: 'not permitted',
    };
    expect(check.permitted).toBe(false);
    expect(check.reason).toBe('not permitted');
  });
});
