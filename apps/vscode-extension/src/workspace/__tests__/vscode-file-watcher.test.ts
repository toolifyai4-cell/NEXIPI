import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { VSCodeFileWatcher } from '../vscode-file-watcher.js';

type FakeWatcherListener = (uri: vscode.Uri, previousUri?: vscode.Uri) => void;

interface FakeFileSystemWatcher {
  onDidCreate: vi.Mock<(listener: FakeWatcherListener) => { dispose: () => void }>;
  onDidChange: vi.Mock<(listener: FakeWatcherListener) => { dispose: () => void }>;
  onDidDelete: vi.Mock<(listener: FakeWatcherListener) => { dispose: () => void }>;
  onDidRename: vi.Mock<(listener: (e: { oldUri: vscode.Uri; newUri: vscode.Uri }) => void) => { dispose: () => void }>;
  dispose: vi.Mock;
}

function makeFakeUri(path: string): vscode.Uri {
  return {
    scheme: 'file',
    path,
    toString: () => `file://${path}`,
  } as unknown as vscode.Uri;
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as any).createFileSystemWatcher = vi.fn(() => {
    const watcher: FakeFileSystemWatcher = {
      onDidCreate: vi.fn((listener) => ({ dispose: vi.fn() })),
      onDidChange: vi.fn((listener) => ({ dispose: vi.fn() })),
      onDidDelete: vi.fn((listener) => ({ dispose: vi.fn() })),
      onDidRename: vi.fn((listener) => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    };
    return watcher;
  });
  (vscode.RelativePattern as any) = vi.fn();
  (vscode.Uri as any) = { parse: vi.fn((uri: string) => makeFakeUri(uri)) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getLastWatcher(): FakeFileSystemWatcher {
  return vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results
    .at(-1)?.value as FakeFileSystemWatcher;
}

describe('VSCodeFileWatcher', () => {
  it('emits created events', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const events: any[] = [];
    const sub = watcher.onEvent((e) => events.push(e));

    const fake = getLastWatcher();
    const listener = vi.mocked(fake.onDidCreate).mock.calls[0][0];
    listener(makeFakeUri('/root/new.ts'));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
    expect(events[0].absolutePath).toBe('file:///root/new.ts');
    expect(typeof events[0].timestamp).toBe('number');

    sub.dispose();
  });

  it('emits changed events', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const events: any[] = [];
    watcher.onEvent((e) => events.push(e));

    const fake = getLastWatcher();
    vi.mocked(fake.onDidChange).mock.calls[0][0](makeFakeUri('/root/edit.ts'));

    expect(events[0].type).toBe('changed');
    expect(events[0].absolutePath).toBe('file:///root/edit.ts');
  });

  it('emits deleted events', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const events: any[] = [];
    watcher.onEvent((e) => events.push(e));

    const fake = getLastWatcher();
    vi.mocked(fake.onDidDelete).mock.calls[0][0](makeFakeUri('/root/gone.ts'));

    expect(events[0].type).toBe('deleted');
    expect(events[0].absolutePath).toBe('file:///root/gone.ts');
  });

  it('emits renamed events through the separate rename API', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const events: any[] = [];
    watcher.onEvent((e) => events.push(e));

    const fake = getLastWatcher();
    vi.mocked(fake.onDidRename).mock.calls[0][0]({
      oldUri: makeFakeUri('/root/old.ts'),
      newUri: makeFakeUri('/root/new.ts'),
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('renamed');
    expect(events[0].absolutePath).toBe('file:///root/new.ts');
    expect(events[0].previousAbsolutePath).toBe('file:///root/old.ts');
  });

  it('creates a recursive watcher over the base URI', () => {
    new VSCodeFileWatcher(makeFakeUri('/root'));
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    expect(vscode.RelativePattern).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/root' }),
      '**'
    );
  });

  it('dispose is idempotent and disposes the underlying watcher', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const fake = getLastWatcher();
    watcher.onEvent(() => {});
    watcher.dispose();
    expect(fake.dispose).toHaveBeenCalled();

    watcher.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('listener errors do not break other listeners', () => {
    const watcher = new VSCodeFileWatcher(makeFakeUri('/root'));
    const events: any[] = [];
    watcher.onEvent(() => {
      throw new Error('boom');
    });
    watcher.onEvent((e) => events.push(e));

    const fake = getLastWatcher();
    vi.mocked(fake.onDidCreate).mock.calls[0][0](makeFakeUri('/root/x.ts'));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('created');
  });
});
