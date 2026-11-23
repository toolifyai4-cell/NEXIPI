import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkspaceFolder, WorkspaceFoldersChangeEvent } from '../workspace-provider.js';
import { WorkspaceDiscovery } from '../workspace-discovery.js';
import { createWorkspaceFolderId } from '../../types.js';

function createMockProvider(folders: WorkspaceFolder[] = []) {
  let changeListener: ((event: WorkspaceFoldersChangeEvent) => void) | null = null;
  let currentFolders = [...folders];

  return {
    getWorkspaceFolders: vi.fn().mockResolvedValue(currentFolders),
    onWorkspaceFoldersChange: vi.fn((listener) => {
      changeListener = listener;
      return {
        unsubscribe: vi.fn(() => {
          changeListener = null;
        }),
      };
    }),
    triggerChange: (event: WorkspaceFoldersChangeEvent) => {
      if (changeListener) {
        if (event.added.length) {
          currentFolders = [...currentFolders, ...event.added];
        }
        if (event.removed.length) {
          const removedUris = new Set(event.removed.map((f) => f.uri));
          currentFolders = currentFolders.filter((f) => !removedUris.has(f.uri));
        }
        if (event.changed.length) {
          for (const changed of event.changed) {
            const idx = currentFolders.findIndex((f) => f.uri === changed.uri);
            if (idx >= 0) {
              currentFolders[idx] = changed;
            }
          }
        }
        changeListener(event);
      }
    },
    dispose: vi.fn(),
  };
}

function createMockFileSystem() {
  return {
    readFile: vi.fn().mockResolvedValue('{}'),
    readDirectory: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtime: Date.now(), ctime: Date.now() }),
    exists: vi.fn().mockResolvedValue(true),
  };
}

describe('WorkspaceDiscovery', () => {
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockFileSystem: ReturnType<typeof createMockFileSystem>;
  let discovery: WorkspaceDiscovery;

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockFileSystem = createMockFileSystem();
    discovery = new WorkspaceDiscovery({
      provider: mockProvider,
      fileSystem: mockFileSystem,
      config: { enabled: true, maxDepth: 3, includeHidden: false, followSymlinks: false, workspaceLessMode: 'temporary' },
    });
  });

  it('should discover empty workspace', async () => {
    mockProvider.getWorkspaceFolders.mockResolvedValue([]);

    const workspace = await discovery.initialize();

    expect(workspace.folders).toHaveLength(0);
    expect(workspace.isMultiRoot).toBe(false);
    expect(workspace.id).toMatch(/^ws_[a-z0-9]+$/);
  });

  it('should discover single-root workspace', async () => {
    const folder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test'),
      uri: 'file:///home/user/project',
      name: 'project',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([folder]);

    const workspace = await discovery.initialize();

    expect(workspace.folders).toHaveLength(1);
    expect(workspace.folders[0].uri).toBe('file:///home/user/project');
    expect(workspace.folders[0].name).toBe('project');
    expect(workspace.isMultiRoot).toBe(false);
  });

  it('should discover multi-root workspace', async () => {
    const folders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project1', name: 'project1', index: 0 },
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project2', name: 'project2', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(folders);

    const workspace = await discovery.initialize();

    expect(workspace.folders).toHaveLength(2);
    expect(workspace.isMultiRoot).toBe(true);
  });

  it('should generate stable workspace identity', async () => {
    const folders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project1', name: 'project', index: 0 },
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project2', name: 'project', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(folders);

    const workspace1 = await discovery.initialize();
    const id1 = workspace1.id;

    discovery.dispose();

    const discovery2 = new WorkspaceDiscovery({
      provider: mockProvider,
      fileSystem: mockFileSystem,
    });
    const workspace2 = await discovery2.initialize();
    const id2 = workspace2.id;

    expect(id1).toBe(id2);
  });

  it('should handle workspace-less mode with temporary identity', async () => {
    mockProvider.getWorkspaceFolders.mockResolvedValue([]);

    const discovery2 = new WorkspaceDiscovery({
      provider: mockProvider,
      fileSystem: mockFileSystem,
      config: { workspaceLessMode: 'temporary' },
    });

    const workspace = await discovery2.initialize();

    expect(workspace.id).toMatch(/^ws_[a-z0-9]+$/);
  });

  it('should emit workspace:discovered event on initialize', async () => {
    const folder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test'),
      uri: 'file:///home/user/project',
      name: 'project',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([folder]);

    const events: unknown[] = [];
    discovery.getEventEmitter().on('workspace:discovered', (e) => events.push(e));

    await discovery.initialize();

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('workspace');
  });

  it('should handle folder added event', async () => {
    const initialFolder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test1'),
      uri: 'file:///home/user/project1',
      name: 'project1',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([initialFolder]);
    await discovery.initialize();

    const events: unknown[] = [];
    discovery.getEventEmitter().on('workspace:changed', (e) => events.push(e));

    const newFolder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test2'),
      uri: 'file:///home/user/project2',
      name: 'project2',
      index: 1,
    };
    mockProvider.triggerChange({
      added: [newFolder],
      removed: [],
      changed: [],
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: { type: 'added', folder: { uri: 'file:///home/user/project2' } } });
  });

  it('should handle folder removed event', async () => {
    const folders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project1', name: 'project1', index: 0 },
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project2', name: 'project2', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(folders);
    await discovery.initialize();

    const events: unknown[] = [];
    discovery.getEventEmitter().on('workspace:changed', (e) => events.push(e));

    const removedFolder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test1'),
      uri: 'file:///home/user/project1',
      name: 'project1',
      index: 0,
    };
    mockProvider.triggerChange({
      added: [],
      removed: [removedFolder],
      changed: [],
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: { type: 'removed', folder: { uri: 'file:///home/user/project1' } } });
  });

  it('should handle folder changed event', async () => {
    const folder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test1'),
      uri: 'file:///home/user/project1',
      name: 'project1',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([folder]);
    await discovery.initialize();

    const events: unknown[] = [];
    discovery.getEventEmitter().on('workspace:changed', (e) => events.push(e));

    const changedFolder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test1'),
      uri: 'file:///home/user/project1',
      name: 'project1-renamed',
      index: 0,
    };
    mockProvider.triggerChange({
      added: [],
      removed: [],
      changed: [changedFolder],
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: {
        type: 'changed',
        folder: { name: 'project1-renamed' },
        previousFolder: { name: 'project1' },
      },
    });
  });

  it('should dispose and cleanup', async () => {
    const folder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test'),
      uri: 'file:///home/user/project',
      name: 'project',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([folder]);
    await discovery.initialize();

    discovery.dispose();

    expect(discovery.getCurrentWorkspace()).toBeNull();
  });

  it('should not allow re-initialization after dispose', async () => {
    const folder: WorkspaceFolder = {
      id: createWorkspaceFolderId('test'),
      uri: 'file:///home/user/project',
      name: 'project',
      index: 0,
    };
    mockProvider.getWorkspaceFolders.mockResolvedValue([folder]);
    await discovery.initialize();
    discovery.dispose();

    await expect(discovery.initialize()).rejects.toThrow('disposed');
  });

  it('should handle two folders with identical names', async () => {
    const folders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project-a', name: 'project', index: 0 },
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project-b', name: 'project', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(folders);

    const workspace = await discovery.initialize();

    expect(workspace.folders).toHaveLength(2);
    expect(workspace.folders[0].uri).toBe('file:///home/user/project-a');
    expect(workspace.folders[1].uri).toBe('file:///home/user/project-b');
  });

  it('should maintain stable identity across folder order changes', async () => {
    const folders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project1', name: 'project1', index: 0 },
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project2', name: 'project2', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(folders);
    const workspace1 = await discovery.initialize();
    const id1 = workspace1.id;

    discovery.dispose();

    const reorderedFolders: WorkspaceFolder[] = [
      { id: createWorkspaceFolderId('test2'), uri: 'file:///home/user/project2', name: 'project2', index: 0 },
      { id: createWorkspaceFolderId('test1'), uri: 'file:///home/user/project1', name: 'project1', index: 1 },
    ];
    mockProvider.getWorkspaceFolders.mockResolvedValue(reorderedFolders);

    const discovery2 = new WorkspaceDiscovery({
      provider: mockProvider,
      fileSystem: mockFileSystem,
    });
    const workspace2 = await discovery2.initialize();
    const id2 = workspace2.id;

    expect(id1).toBe(id2);
  });
});