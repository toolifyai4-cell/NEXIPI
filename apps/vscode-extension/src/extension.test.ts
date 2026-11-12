import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from './extension.js';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn((_, callback) => callback),
  },
  ExtensionContext: vi.fn(),
  subscriptions: [],
}));

describe('vscode-extension', () => {
  it('should activate without errors', () => {
    const mockContext = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    expect(() => activate(mockContext)).not.toThrow();
  });

  it('should deactivate without errors', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
