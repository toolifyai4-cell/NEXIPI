import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createTerminalPermissionPolicy } from '../terminal-permission-policy.js';
import { TERMINAL_TOOLS } from '../terminal-permission-policy.js';
import type { ToolDefinition } from '@nexipi/models/tools';
import type { Logger } from '@nexipi/core';
import { createNoopLogger } from '@nexipi/core';

function makeToolDefinition(overrides: {
  name: string;
  metadata: {
    capabilities?: ReadonlyArray<'read' | 'write' | 'execute' | 'external'>;
    readOnly?: boolean;
    destructive?: boolean;
    requiresWorkspace?: boolean;
    idempotent?: boolean;
    version?: string;
  };
}): ToolDefinition {
  return {
    name: overrides.name,
    description: `Tool ${overrides.name}`,
    inputSchema: z.object({}),
    metadata: {
      capabilities: overrides.metadata.capabilities ?? ['execute'],
      readOnly: overrides.metadata.readOnly ?? false,
      destructive: overrides.metadata.destructive ?? false,
      requiresWorkspace: overrides.metadata.requiresWorkspace ?? true,
      idempotent: overrides.metadata.idempotent ?? false,
      version: overrides.metadata.version ?? '1.0.0',
    },
  };
}

function makeContext(overrides: {
  workspaceId?: string | undefined;
  workspaceFolder?: { uri: string; id: string } | undefined;
} = {}): Parameters<ToolDefinition['execute']>[1] {
  return {
    signal: new AbortController().signal,
    workspaceId: 'ws_1',
    workspaceFolder: { uri: 'file:///root', id: 'ws_1' },
    logger: createNoopLogger(),
    ...overrides,
  };
}

describe('TerminalPermissionPolicy — tool name set', () => {
  it('recognizes run_terminal as a terminal tool', () => {
    expect(TERMINAL_TOOLS.has('run_terminal')).toBe(true);
  });
});

describe('TerminalPermissionPolicy — default deny', () => {
  const policy = createTerminalPermissionPolicy(createNoopLogger());

  it('denies unknown tools', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'delete_file',
        metadata: {
          capabilities: ['write'],
          readOnly: false,
          destructive: true,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not a recognized terminal execution tool');
  });

  it('denies read-only tools', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'read_file',
        metadata: {
          capabilities: ['read'],
          readOnly: true,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies editing tools', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'propose_edit',
        metadata: {
          capabilities: ['read'],
          readOnly: true,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('TerminalPermissionPolicy — terminal tool recognition', () => {
  const policy = createTerminalPermissionPolicy(createNoopLogger());

  it('permits run_terminal with valid metadata and workspace', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('permitted');
  });

  it('denies run_terminal without execute capability', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['read'],
          readOnly: true,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("'execute' capability");
  });

  it('denies run_terminal marked destructive', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: true,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('destructive');
  });

  it('denies run_terminal without requiresWorkspace', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: false,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('workspace context');
  });
});

describe('TerminalPermissionPolicy — workspace requirements', () => {
  const policy = createTerminalPermissionPolicy(createNoopLogger());

  it('denies run_terminal without a workspace id', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext({ workspaceId: undefined })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('workspace context');
  });

  it('denies run_terminal without a workspace folder', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext({ workspaceFolder: undefined })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('workspace folder');
  });
});

describe('TerminalPermissionPolicy — no blanket write permission', () => {
  const policy = createTerminalPermissionPolicy(createNoopLogger());

  it('does not grant write permission merely because execute capability is declared', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'run_terminal',
        metadata: {
          capabilities: ['execute', 'write'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    // The tool is recognized by name, but the presence of 'write' capability
    // alone does not change the decision — the policy only checks that
    // 'execute' is among capabilities. Destructive/write behavior is enforced
    // at the command validation and executable policy layers.
    expect(decision.allowed).toBe(true);
  });

  it('does not grant permission to non-terminal tools with execute capability', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'custom_execute_tool',
        metadata: {
          capabilities: ['execute'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not a recognized terminal execution tool');
  });
});
