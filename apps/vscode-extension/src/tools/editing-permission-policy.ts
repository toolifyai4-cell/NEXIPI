/**
 * Phase 10 Stage E3 — Editing permission policy.
 *
 * Separate from, and complementary to, the Phase 09 read-only workspace
 * permission policy (`createReadOnlyWorkspacePermissionPolicy`). This policy
 * owns the editing tools (`propose_edit`, `apply_edit`) with default-deny
 * semantics and does not weaken, replace, or fall back to the read-only
 * policy. Each policy owns its own tool set; there is no overlap and no
 * automatic delegation between them.
 *
 * Default deny: only explicitly recognized editing tools may be considered.
 * `propose_edit` remains non-destructive and receives no write permission
 * (read-only only). `apply_edit` is recognized as an editing tool but this
 * policy grants no blanket write or destructive permission -- per-proposal
 * authorization (a verified approval for the exact proposal version and
 * content hash) is enforced by the trusted edit-authorization boundary
 * (`EditAuthorizationBoundary`) at execution time, not by this policy.
 *
 * This policy makes no VS Code or persistence imports and performs no
 * per-proposal approval checks (the permission policy context carries no
 * proposal identity). Approval-related denials (missing, invalid provenance,
 * model-generated, expired, rejected, revoked, stale, mismatched, workspace or
 * file identity mismatch) are enforced by the trusted approval service through
 * the `EditAuthorizationBoundary` seam.
 */

import type {
  ToolDefinition,
  ToolPermissionDecision,
  ToolPermissionPolicy,
} from '@nexipi/models/tools';
import type { Logger } from '@nexipi/core';

const EDITING_TOOLS = new Set<string>(['propose_edit', 'apply_edit']);

function isEditingTool(name: string): boolean {
  return EDITING_TOOLS.has(name);
}

/**
 * Creates the default-deny editing permission policy.
 *
 * @param logger - logger for diagnostics (safe metadata only).
 */
export function createEditingPermissionPolicy(_logger: Logger): ToolPermissionPolicy {
  return {
    name: 'editing-permission-policy',
    evaluate(
      definition: Readonly<ToolDefinition>,
      _context: {
        readonly signal: AbortSignal;
        readonly workspaceId: string | undefined;
        readonly workspaceFolder: { readonly uri: string; readonly id: string } | undefined;
        readonly logger: Logger;
      }
    ): ToolPermissionDecision {
      const toolName = definition.name;

      // Unknown tools and unsupported capabilities deny.
      if (!isEditingTool(toolName)) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' is not a recognized editing tool.`,
        };
      }

      if (toolName === 'propose_edit') {
        // propose_edit remains non-destructive and receives no write
        // permission. It is read-only, non-destructive, and workspace-scoped.
        if (!definition.metadata.readOnly) {
          return {
            allowed: false,
            reason: `Tool '${toolName}' is not marked as read-only.`,
          };
        }
        if (definition.metadata.destructive) {
          return {
            allowed: false,
            reason: `Tool '${toolName}' is marked as destructive.`,
          };
        }
        if (definition.metadata.capabilities.some(c => c !== 'read')) {
          return {
            allowed: false,
            reason: `Tool '${toolName}' declares non-read capabilities: ${definition.metadata.capabilities.join(
              ', '
            )}. Only 'read' capability is permitted.`,
          };
        }
        if (!definition.metadata.requiresWorkspace) {
          return {
            allowed: false,
            reason: `Tool '${toolName}' does not require a workspace context.`,
          };
        }
        return {
          allowed: true,
          reason: `Editing tool '${toolName}' is permitted (read-only, non-destructive).`,
        };
      }

      if (toolName === 'apply_edit') {
        // apply_edit is a recognized editing tool, but this policy grants no
        // blanket write or destructive permission. The tool is allowed to
        // reach execution so the trusted edit-authorization boundary can
        // enforce per-proposal authorization (verified approval for the exact
        // proposal version and content hash). Missing, invalid, expired,
        // rejected, revoked, stale, or mismatched approvals deny there.
        if (!definition.metadata.requiresWorkspace) {
          return {
            allowed: false,
            reason: `Tool '${toolName}' does not require a workspace context.`,
          };
        }
        return {
          allowed: true,
          reason: `Editing tool '${toolName}' is permitted; application requires verified authorization via the edit-authorization boundary.`,
        };
      }

      return {
        allowed: false,
        reason: `Tool '${toolName}' is not permitted by the editing permission policy.`,
      };
    },
  };
}
