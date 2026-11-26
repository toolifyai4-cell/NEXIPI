import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createEditingPermissionPolicy } from '../editing-permission-policy.js';
import { createReadOnlyWorkspacePermissionPolicy } from '../permission-policy.js';
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
      capabilities: overrides.metadata.capabilities ?? ['read'],
      readOnly: overrides.metadata.readOnly ?? true,
      destructive: overrides.metadata.destructive ?? false,
      requiresWorkspace: overrides.metadata.requiresWorkspace ?? true,
      idempotent: overrides.metadata.idempotent ?? false,
      version: overrides.metadata.version ?? '1.0.0',
    },
  };
}

function makeContext(): Parameters<ToolDefinition['execute']>[1] {
  return {
    signal: new AbortController().signal,
    workspaceId: 'ws_1',
    workspaceFolder: { uri: 'file:///root', id: 'ws_1' },
    logger: createNoopLogger(),
  };
}

describe('EditingPermissionPolicy — default deny', () => {
  const policy = createEditingPermissionPolicy(createNoopLogger());

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
    expect(decision.reason).toContain('not a recognized editing tool');
  });

  it('denies tools outside the editing tool set even when marked write/destructive', () => {
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
    expect(decision.allowed).toBe(false);
  });

  it('does not grant blanket permission to all write or destructive tools', () => {
    for (const name of ['delete_file', 'run_terminal', 'write_file', 'apply_patch']) {
      const decision = policy.evaluate(
        makeToolDefinition({
          name,
          metadata: {
            capabilities: ['write'],
            readOnly: false,
            destructive: true,
            requiresWorkspace: true,
          },
        }),
        makeContext()
      );
      expect(decision.allowed).toBe(false, `Expected ${name} to be denied`);
    }
  });

  it('propose_edit is permitted (read-only, non-destructive, no write permission)', () => {
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
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('read-only, non-destructive');
  });

  it('apply_edit is permitted as a recognized editing tool (boundary enforces approval)', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'apply_edit',
        metadata: {
          capabilities: ['write'],
          readOnly: false,
          destructive: true,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('edit-authorization boundary');
  });

  it('denies propose_edit when not read-only', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'propose_edit',
        metadata: {
          capabilities: ['read', 'write'],
          readOnly: false,
          destructive: false,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies propose_edit when destructive', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'propose_edit',
        metadata: {
          capabilities: ['read'],
          readOnly: true,
          destructive: true,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies propose_edit when missing requiresWorkspace', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'propose_edit',
        metadata: {
          capabilities: ['read'],
          readOnly: true,
          destructive: false,
          requiresWorkspace: false,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies apply_edit when missing requiresWorkspace', () => {
    const decision = policy.evaluate(
      makeToolDefinition({
        name: 'apply_edit',
        metadata: {
          capabilities: ['write'],
          readOnly: false,
          destructive: true,
          requiresWorkspace: false,
        },
      }),
      makeContext()
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('EditingPermissionPolicy — separate from read-only policy', () => {
  const editingPolicy = createEditingPermissionPolicy(createNoopLogger());
  const readOnlyPolicy = createReadOnlyWorkspacePermissionPolicy(createNoopLogger());

  it('read-only policy still denies editing tools (Phase 09 unchanged)', () => {
    const propose = readOnlyPolicy.evaluate(
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
    const apply = readOnlyPolicy.evaluate(
      makeToolDefinition({
        name: 'apply_edit',
        metadata: {
          capabilities: ['write'],
          readOnly: false,
          destructive: true,
          requiresWorkspace: true,
        },
      }),
      makeContext()
    );
    expect(propose.allowed).toBe(false);
    expect(apply.allowed).toBe(false);
  });

  it('read-only policy still allows approved read-only tools', () => {
    const decision = readOnlyPolicy.evaluate(
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
    expect(decision.allowed).toBe(true);
  });

  it('editing policy denies read-only tools that are not editing tools', () => {
    const decision = editingPolicy.evaluate(
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
});
