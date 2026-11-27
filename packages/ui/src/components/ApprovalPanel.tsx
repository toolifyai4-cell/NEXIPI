import type { ProposalCreatedPayload, ApprovalDecision, ApprovalStatus } from '../types';

interface ApprovalPanelProps {
  proposals: readonly ProposalCreatedPayload[];
  onApprovalAction: (
    proposalId: string,
    proposalVersion: number,
    decision: ApprovalDecision,
    workspaceId: string,
    fileUri: string
  ) => void;
}

const MAX_PREVIEW_DISPLAY_CHARS = 50_000;

function formatFileName(fileUri: string): string {
  try {
    const path = fileUri.replace(/^file:\/\//, '');
    return path.split('/').pop() ?? path;
  } catch {
    return fileUri;
  }
}

function formatWorkspaceLabel(workspaceName: string, workspaceId: string): string {
  return workspaceName || workspaceId;
}

function statusLabel(status: ApprovalStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending approval';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'dismissed':
      return 'Dismissed';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}

function statusClass(status: ApprovalStatus): string {
  switch (status) {
    case 'pending':
      return 'nexipi-approval-status--pending';
    case 'approved':
      return 'nexipi-approval-status--approved';
    case 'rejected':
      return 'nexipi-approval-status--rejected';
    case 'dismissed':
      return 'nexipi-approval-status--dismissed';
    case 'failed':
      return 'nexipi-approval-status--failed';
    default:
      return 'nexipi-approval-status--unknown';
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… (truncated for display)`;
}

export function ApprovalPanel({ proposals, onApprovalAction }: ApprovalPanelProps) {
  const pending = proposals.filter(p => p.status === 'pending' || p.status === undefined);
  const hasPending = pending.length > 0;

  return (
    <section className="nexipi-approval-panel" aria-label="Edit proposals awaiting approval">
      {hasPending && (
        <div className="nexipi-approval-panel-header">
          <h2 className="nexipi-approval-panel-title">Edit proposal awaiting approval</h2>
          <span className="nexipi-approval-panel-count">{pending.length} pending</span>
        </div>
      )}
      <div className="nexipi-approval-list" role="list">
        {proposals.map(proposal => (
          <article
            key={`${proposal.proposalId}-v${proposal.proposalVersion}`}
            className={`nexipi-approval-card nexipi-approval-card--${proposal.status ?? 'pending'}`}
            role="listitem"
          >
            <div className="nexipi-approval-card-header">
              <div className="nexipi-approval-card-identity">
                <span className="nexipi-approval-card-label">File</span>
                <span className="nexipi-approval-card-value" title={proposal.fileUri}>
                  {formatFileName(proposal.fileUri)}
                </span>
                <span className="nexipi-approval-card-label">Workspace</span>
                <span className="nexipi-approval-card-value" title={proposal.workspaceId}>
                  {formatWorkspaceLabel(proposal.workspaceName, proposal.workspaceId)}
                </span>
                <span className="nexipi-approval-card-label">Relative path</span>
                <span className="nexipi-approval-card-value" title={proposal.relativePath}>
                  {proposal.relativePath}
                </span>
              </div>
              <span
                className={`nexipi-approval-status ${statusClass(proposal.status ?? 'pending')}`}
                aria-label={statusLabel(proposal.status ?? 'pending')}
              >
                {statusLabel(proposal.status ?? 'pending')}
              </span>
            </div>

            <div className="nexipi-approval-card-body">
              <h3 className="nexipi-approval-card-section-title">Proposed change</h3>
              <div className="nexipi-approval-diff-summary">
                <span className="nexipi-approval-diff-label">Proposed content size</span>
                <span className="nexipi-approval-diff-value">
                  {proposal.proposedSize.toLocaleString()} bytes
                </span>
                <span className="nexipi-approval-diff-label">Proposed content hash</span>
                <span className="nexipi-approval-diff-value nexipi-approval-hash">
                  {proposal.proposedContentHash}
                </span>
              </div>
              <div className="nexipi-approval-preview">
                <pre className="nexipi-approval-code">
                  <code>
                    {truncate(
                      String(
                        (proposal.preview as { readonly proposedContent?: string } | undefined)
                          ?.proposedContent ?? ''
                      ),
                      MAX_PREVIEW_DISPLAY_CHARS
                    )}
                  </code>
                </pre>
              </div>
            </div>

            {proposal.status === 'pending' || proposal.status === undefined ? (
              <div className="nexipi-approval-actions">
                <button
                  type="button"
                  className="nexipi-approval-btn nexipi-approval-btn--approve"
                  onClick={() =>
                    onApprovalAction(
                      proposal.proposalId,
                      proposal.proposalVersion,
                      'approve',
                      proposal.workspaceId,
                      proposal.fileUri
                    )
                  }
                  aria-label={`Approve edit to ${formatFileName(proposal.fileUri)}`}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="nexipi-approval-btn nexipi-approval-btn--reject"
                  onClick={() =>
                    onApprovalAction(
                      proposal.proposalId,
                      proposal.proposalVersion,
                      'reject',
                      proposal.workspaceId,
                      proposal.fileUri
                    )
                  }
                  aria-label={`Reject edit to ${formatFileName(proposal.fileUri)}`}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="nexipi-approval-btn nexipi-approval-btn--dismiss"
                  onClick={() =>
                    onApprovalAction(
                      proposal.proposalId,
                      proposal.proposalVersion,
                      'dismiss',
                      proposal.workspaceId,
                      proposal.fileUri
                    )
                  }
                  aria-label={`Dismiss edit to ${formatFileName(proposal.fileUri)}`}
                >
                  Dismiss
                </button>
              </div>
            ) : (
              <div className="nexipi-approval-actions nexipi-approval-actions--terminal">
                <span className="nexipi-approval-terminal-note">
                  {statusLabel(proposal.status ?? 'pending')}. No further action available.
                </span>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
