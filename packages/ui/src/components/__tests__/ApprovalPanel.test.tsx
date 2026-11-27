import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalPanel } from '../ApprovalPanel';
import type { ProposalCreatedPayload } from '../../types';

function makeProposal(overrides: Record<string, unknown> = {}): ProposalCreatedPayload {
  return {
    proposalId: 'prop-1',
    proposalVersion: 1,
    fileUri: 'file:///ws-1/file.txt',
    relativePath: 'file.txt',
    workspaceId: 'ws-1',
    workspaceName: 'workspace-1',
    proposedContentHash: 'aa'.repeat(32),
    proposedSize: 42,
    createdAt: 1000,
    expiresAt: 2000,
    preview: { proposedContent: 'proposed content line one\nproposed content line two' },
    status: 'pending',
    ...overrides,
  };
}

describe('ApprovalPanel', () => {
  it('renders a pending proposal with file, workspace, preview and action buttons', () => {
    const onApprovalAction = vi.fn();
    render(<ApprovalPanel proposals={[makeProposal()]} onApprovalAction={onApprovalAction} />);

    expect(screen.getByText('Edit proposal awaiting approval')).toBeInTheDocument();
    expect(screen.getByText('workspace-1')).toBeInTheDocument();
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve edit to file\.txt/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
    expect(screen.getByText(/proposed content line one/)).toBeInTheDocument();
  });

  it('calls onApprovalAction with the exact proposal identity when approving', () => {
    const onApprovalAction = vi.fn();
    render(<ApprovalPanel proposals={[makeProposal()]} onApprovalAction={onApprovalAction} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    expect(onApprovalAction).toHaveBeenCalledWith(
      'prop-1',
      1,
      'approve',
      'ws-1',
      'file:///ws-1/file.txt'
    );
  });

  it('calls onApprovalAction with reject and dismiss decisions', () => {
    const onApprovalAction = vi.fn();
    render(<ApprovalPanel proposals={[makeProposal()]} onApprovalAction={onApprovalAction} />);

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(onApprovalAction).toHaveBeenCalledWith(
      'prop-1',
      1,
      'reject',
      'ws-1',
      'file:///ws-1/file.txt'
    );

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(onApprovalAction).toHaveBeenCalledWith(
      'prop-1',
      1,
      'dismiss',
      'ws-1',
      'file:///ws-1/file.txt'
    );
  });

  it('renders multiple proposals independently without mixing identity', () => {
    const onApprovalAction = vi.fn();
    render(
      <ApprovalPanel
        proposals={[
          makeProposal(),
          makeProposal({
            proposalId: 'prop-2',
            relativePath: 'other.txt',
            fileUri: 'file:///ws-1/other.txt',
          }),
        ]}
        onApprovalAction={onApprovalAction}
      />
    );

    expect(screen.getAllByRole('button', { name: /Approve/i })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i })[1]);
    expect(onApprovalAction).toHaveBeenCalledWith(
      'prop-2',
      1,
      'approve',
      'ws-1',
      'file:///ws-1/other.txt'
    );
  });

  it('shows terminal status without action buttons for non-pending proposals', () => {
    const onApprovalAction = vi.fn();
    render(
      <ApprovalPanel
        proposals={[
          makeProposal({ status: 'approved' }),
          makeProposal({ proposalId: 'prop-2', status: 'rejected' }),
          makeProposal({ proposalId: 'prop-3', status: 'dismissed' }),
          makeProposal({ proposalId: 'prop-4', status: 'failed' }),
        ]}
        onApprovalAction={onApprovalAction}
      />
    );

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/i })).not.toBeInTheDocument();
    expect(onApprovalAction).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no proposals', () => {
    const onApprovalAction = vi.fn();
    render(<ApprovalPanel proposals={[]} onApprovalAction={onApprovalAction} />);

    expect(screen.queryByText('Edit proposal awaiting approval')).not.toBeInTheDocument();
    expect(onApprovalAction).not.toHaveBeenCalled();
  });
});
