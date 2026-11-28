/**
 * Phase 10 Stage F — VS Code-host-mediated trusted decision provider.
 *
 * Implements {@link TrustedDecisionProvider} by showing a native VS Code
 * confirmation dialog. The dialog is host-controlled: it cannot be triggered,
 * forged, or bypassed by a model response, tool call, webview message, or
 * programmatic event. The user's decision (approve / reject / cancel) and the
 * decision timestamp originate from the provider, never from the caller.
 *
 * Returns `null` when the user cancels, dismisses, or the dialog is
 * unavailable, so the {@link TrustedApprovalService} fails closed.
 */

import * as vscode from 'vscode';
import type {
  TrustedDecisionProvider,
  TrustedUserDecision,
  TrustedUserDecisionRequest,
} from '@nexipi/workspace';

const BOUNDARY = 'vscode-host:confirm-dialog';

export interface VSCodeTrustedDecisionProviderOptions {
  /**
   * Override clock used for `decidedAt`. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Host-controlled trusted decision boundary backed by a modal VS Code dialog.
 */
export class VSCodeTrustedDecisionProvider implements TrustedDecisionProvider {
  private readonly now: () => number;

  constructor(options: VSCodeTrustedDecisionProviderOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async establishUserDecision(
    request: TrustedUserDecisionRequest
  ): Promise<TrustedUserDecision | null> {
    const {
      decision: requestedDecision,
      proposalId,
      proposalVersion,
      workspaceId,
      fileUri,
      terminalCommand,
    } = request;

    let message: string;
    if (terminalCommand !== undefined) {
      const {
        executable,
        arguments: args,
        workingDirectory,
        environmentConfigId,
      } = terminalCommand;
      const envLine =
        environmentConfigId !== undefined ? `\nEnvironment config: ${environmentConfigId}` : '';
      message =
        `Run terminal command?\n` +
        `Executable: ${executable}\n` +
        `Arguments: ${args.join(' ')}\n` +
        `Working directory: ${workingDirectory}\n` +
        `Workspace: ${workspaceId}` +
        envLine +
        `\nRequested: ${requestedDecision}`;
    } else {
      const fileName =
        fileUri
          .replace(/^file:\/\//, '')
          .split('/')
          .pop() ?? fileUri;
      message = `Approve edit to '${fileName}'?\nWorkspace: ${workspaceId}\nProposal: ${proposalId} v${proposalVersion}\nRequested: ${requestedDecision}`;
    }

    const result = await vscode.window.showWarningMessage(
      message,
      {
        modal: true,
      },
      'Approve',
      'Reject',
      'Cancel'
    );

    let decision: 'approve' | 'reject' | null;
    switch (result) {
      case 'Approve':
        decision = 'approve';
        break;
      case 'Reject':
        decision = 'reject';
        break;
      default:
        // Cancel, dismiss, or dialog unavailable -> no decision established.
        return null;
    }

    return {
      decision,
      boundary: BOUNDARY,
      decidedAt: this.now(),
      expiresAt: request.expiresAt ?? null,
    };
  }
}
