import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { VSCodeTrustedDecisionProvider } from '../vscode-trusted-decision-provider';

vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Approve');

describe('VSCodeTrustedDecisionProvider', () => {
  let provider: VSCodeTrustedDecisionProvider;
  const now = () => 1_700_000_000_000;

  beforeEach(() => {
    provider = new VSCodeTrustedDecisionProvider({ now });
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('establishes an approve decision through the host dialog', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Approve');

    const result = await provider.establishUserDecision({
      proposalId: 'prop-1',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///ws-1/file.txt',
      expiresAt: 2_000_000_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.decision).toBe('approve');
    expect(result!.boundary).toBe('vscode-host:confirm-dialog');
    expect(result!.decidedAt).toBe(1_700_000_000_000);
    expect(result!.expiresAt).toBe(2_000_000_000_000);
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0]).toContain('file.txt');
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0]).toContain('ws-1');
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][1]).toMatchObject({ modal: true });
  });

  it('establishes a reject decision', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Reject');

    const result = await provider.establishUserDecision({
      proposalId: 'prop-1',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///ws-1/file.txt',
      expiresAt: null,
    });

    expect(result!.decision).toBe('reject');
  });

  it('returns null when the user cancels (fail closed)', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);

    const result = await provider.establishUserDecision({
      proposalId: 'prop-1',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///ws-1/file.txt',
      expiresAt: null,
    });

    expect(result).toBeNull();
  });

  it('returns null when the dialog is dismissed', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Cancel');

    const result = await provider.establishUserDecision({
      proposalId: 'prop-1',
      proposalVersion: 1,
      decision: 'approve',
      workspaceId: 'ws-1',
      fileUri: 'file:///ws-1/file.txt',
      expiresAt: null,
    });

    expect(result).toBeNull();
  });
});
