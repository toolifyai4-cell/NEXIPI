/**
 * Phase 10 Stage E4 — Composed permission policy.
 *
 * Composes the Phase 09 read-only permission policy, the Phase 10 editing
 * permission policy, and the Phase 11 terminal execution permission policy
 * through explicit, fail-closed dispatch by known tool identity. Neither
 * policy is replaced or weakened:
 *
 * - Editing tools (`propose_edit`, `apply_edit`) are routed to the editing
 *   policy, which is separate from and independent of the read-only policy.
 * - Terminal execution tools (`run_terminal`) are routed to the terminal
 *   permission policy, which is separate from both the read-only and editing
 *   policies.
 * - Read-only tools continue to use the original read-only policy unchanged.
 * - Unknown tools and unsupported capabilities are denied at the composition
 *   layer; they never reach any sub-policy.
 * - The terminal policy does not grant blanket write, destructive, or
 *   external capability merely because a tool declares the `execute`
 *   capability: it recognizes only `run_terminal` by name.
 */

import type { Logger } from '@nexipi/core';
import type {
  ToolDefinition,
  ToolPermissionDecision,
  ToolPermissionPolicy,
  ToolExecutionContext,
} from '@nexipi/models/tools';
import { createReadOnlyWorkspacePermissionPolicy } from '../permission-policy.js';
import { createEditingPermissionPolicy } from '../editing-permission-policy.js';
import { createTerminalPermissionPolicy } from '../terminal-permission-policy.js';

const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_code', 'find_references']);

const EDITING_TOOLS = new Set(['propose_edit', 'apply_edit']);

const TERMINAL_TOOLS = new Set(['run_terminal']);

export function createComposedToolPermissionPolicy(logger: Logger): ToolPermissionPolicy {
  const readOnlyPolicy = createReadOnlyWorkspacePermissionPolicy(logger);
  const editingPolicy = createEditingPermissionPolicy(logger);
  const terminalPolicy = createTerminalPermissionPolicy(logger);

  return {
    name: 'composed-workspace-permission-policy',
    evaluate(
      definition: Readonly<ToolDefinition>,
      context: ToolExecutionContext
    ): ToolPermissionDecision | Promise<ToolPermissionDecision> {
      const name = definition.name;
      if (EDITING_TOOLS.has(name)) {
        return editingPolicy.evaluate(definition, context);
      }
      if (TERMINAL_TOOLS.has(name)) {
        return terminalPolicy.evaluate(definition, context);
      }
      if (READ_ONLY_TOOLS.has(name)) {
        return readOnlyPolicy.evaluate(definition, context);
      }
      return {
        allowed: false,
        reason: `Tool '${name}' is not permitted by the composed permission policy.`,
      };
    },
  };
}
