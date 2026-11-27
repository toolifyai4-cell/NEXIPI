/**
 * Phase 11 Stage C — Terminal execution permission policy.
 *
 * Default-deny permission policy for terminal execution tools. Separate from,
 * and complementary to, the Phase 09 read-only workspace permission policy
 * and the Phase 10 editing permission policy. Each policy owns its own tool
 * set; there is no overlap and no automatic delegation between them.
 *
 * This policy makes no VS Code imports and performs no per-command execution
 * validation (executable allowlisting, argument checking, working directory
 * checks). Those checks happen at execution time in the terminal adapter
 * (Stage D), which calls validateTerminalCommandSecurity and
 * checkExecutablePermission. This policy only decides whether a tool may be
 * considered for execution at all.
 *
 * Default deny: only explicitly recognized terminal tools may be considered.
 * No blanket write, destructive, or external capability is granted merely
 * because a tool declares the `execute` capability. An allowlist entry here
 * is NOT trusted user approval; approval is established separately by Stage E.
 */

import type {
  ToolDefinition,
  ToolPermissionDecision,
  ToolPermissionPolicy,
} from '@nexipi/models/tools';
import type { Logger } from '@nexipi/core';

const TERMINAL_TOOLS = new Set<string>(['run_terminal']);

function isTerminalTool(name: string): boolean {
  return TERMINAL_TOOLS.has(name);
}

/**
 * Creates the default-deny terminal execution permission policy.
 *
 * @param logger - logger for diagnostics (safe metadata only).
 */
export function createTerminalPermissionPolicy(_logger: Logger): ToolPermissionPolicy {
  return {
    name: 'terminal-permission-policy',
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
      if (!isTerminalTool(toolName)) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' is not a recognized terminal execution tool.`,
        };
      }

      // Terminal execution requires a workspace context. Never execute
      // outside a known workspace.
      if (!_context.workspaceId) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' requires a workspace context.`,
        };
      }

      if (!_context.workspaceFolder) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' requires a workspace folder.`,
        };
      }

      const metadata = definition.metadata;

      // Terminal tools must declare the execute capability.
      if (!metadata.capabilities.includes('execute')) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' does not declare the 'execute' capability.`,
        };
      }

      // Terminal tools must not be marked destructive or write-only at the
      // policy level. Destructiveness is determined per-command at execution
      // time by the command validation and executable policy layers.
      if (metadata.destructive) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' is marked as destructive.`,
        };
      }

      // Terminal tools require a workspace context (already checked above),
      // but re-affirm in metadata for defense in depth.
      if (!metadata.requiresWorkspace) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' does not require a workspace context.`,
        };
      }

      return {
        allowed: true,
        reason: `Terminal execution tool '${toolName}' is permitted; per-command validation and executable policy apply at execution time.`,
      };
    },
  };
}

export { TERMINAL_TOOLS };
