import type { ToolDefinition, ToolPermissionDecision, ToolPermissionPolicy } from '@nexipi/models/tools';
import type { Logger } from '@nexipi/core';

const APPROVED_READ_ONLY_TOOLS = new Set<string>([
  'read_file',
  'list_directory',
  'search_code',
  'find_references',
]);

function isApprovedReadOnlyTool(name: string): boolean {
  return APPROVED_READ_ONLY_TOOLS.has(name);
}

export function createReadOnlyWorkspacePermissionPolicy(
  _logger: Logger
): ToolPermissionPolicy {
  return {
    name: 'read-only-workspace-tools',
    evaluate(
      definition: Readonly<ToolDefinition>,
      _context: { readonly signal: AbortSignal; readonly workspaceId: string | undefined; readonly workspaceFolder: { readonly uri: string; readonly id: string } | undefined; readonly logger: Logger }
    ): ToolPermissionDecision {
      const toolName = definition.name;

      if (!isApprovedReadOnlyTool(toolName)) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' is not in the approved read-only workspace tool allowlist. Only read_file, list_directory, search_code, and find_references are permitted.`,
        };
      }

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

      if (definition.metadata.capabilities.some((c) => c !== 'read')) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' declares non-read capabilities: ${definition.metadata.capabilities.join(', ')}. Only 'read' capability is permitted.`,
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
        reason: `Approved read-only workspace tool: ${toolName}`,
      };
    },
  };
}

export { APPROVED_READ_ONLY_TOOLS };