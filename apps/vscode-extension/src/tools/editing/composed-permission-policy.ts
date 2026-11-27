/**
 * Phase 10 Stage E4 — Composed permission policy.
 *
 * Composes the Phase 09 read-only permission policy with the Phase 10 editing
 * permission policy through explicit, fail-closed dispatch by known tool
 * identity. Neither policy is replaced or weakened:
 *
 * - Editing tools (`propose_edit`, `apply_edit`) are routed to the editing
 *   policy, which is separate from and independent of the read-only policy.
 * - Read-only tools continue to use the original read-only policy unchanged.
 * - Unknown tools and unsupported capabilities are denied at the composition
 *   layer; they never reach either sub-policy.
 * - The editing policy does not grant blanket permission to any tool with a
 *   `write` or `destructive` capability: it recognizes only `propose_edit` and
 *   `apply_edit` by name.
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

const READ_ONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_code', 'find_references']);

const EDITING_TOOLS = new Set(['propose_edit', 'apply_edit']);

export function createComposedToolPermissionPolicy(logger: Logger): ToolPermissionPolicy {
  const readOnlyPolicy = createReadOnlyWorkspacePermissionPolicy(logger);
  const editingPolicy = createEditingPermissionPolicy(logger);

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
