import { describe, it, expect } from 'vitest';
import { ScanIndex } from '../scan-index.js';
import type { FileMetadata } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';

function makeFileMetadata(overrides: {
  id?: string;
  relativePath?: string;
  absolutePath?: string;
  workspaceFolderId?: string;
  projectId?: string;
  name?: string;
}): FileMetadata {
  const id = overrides.id ?? `file_${overrides.relativePath ?? 'x'}`;
  const relativePath = overrides.relativePath ?? 'src/main.ts';
  const absolutePath = overrides.absolutePath ?? `/root/${relativePath}`;
  return {
    id,
    workspaceId: 'ws_1',
    workspaceFolderId: (overrides.workspaceFolderId ?? 'folder_1') as any,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    absolutePath,
    uri: `file:///${absolutePath.replace(/^\/+/, '')}`,
    relativePath,
    name: overrides.name ?? 'main.ts',
    extension: 'ts',
    size: overrides.size ?? 100,
    mtime: Date.now(),
    language: 'typescript',
    category: 'source',
    isHidden: false,
    isManifest: false,
    isConfig: false,
    isBinary: false,
    isSensitive: false,
    sourceExcluded: false,
  };
}

describe('ScanIndex', () => {
  it('should look up a file by id', () => {
    const index = new ScanIndex();
    const file = makeFileMetadata({ id: 'file_a', relativePath: 'src/a.ts' });
    index.upsertMetadata(file);
    expect(index.getById('file_a')).toBe(file);
    expect(index.getById('missing')).toBeUndefined();
  });

  it('should look up a file by normalized absolute path', () => {
    const index = new ScanIndex();
    const file = makeFileMetadata({ absolutePath: '/root/src/a.ts', relativePath: 'src/a.ts' });
    index.upsertMetadata(file);
    expect(index.getByPath('/root/src/a.ts')).toBe(file);
    expect(index.getByPath('/root/src/a.ts/')).toBe(file);
    expect(index.getByPath('/root\\src\\a.ts')).toBe(file);
    expect(index.getByPath('/root/other.ts')).toBeUndefined();
  });

  it('should list files by workspace folder', () => {
    const index = new ScanIndex();
    const f1 = makeFileMetadata({ id: 'f1', relativePath: 'a.ts', workspaceFolderId: 'folder_a' });
    const f2 = makeFileMetadata({ id: 'f2', relativePath: 'b.ts', workspaceFolderId: 'folder_a' });
    const f3 = makeFileMetadata({ id: 'f3', relativePath: 'c.ts', workspaceFolderId: 'folder_b' });
    index.upsertMetadata(f1);
    index.upsertMetadata(f2);
    index.upsertMetadata(f3);

    const a = index.listByFolder('folder_a');
    expect(a.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    const b = index.listByFolder('folder_b');
    expect(b.map((f) => f.id)).toEqual(['f3']);
    expect(index.listByFolder('missing')).toEqual([]);
  });

  it('should list files by project', () => {
    const index = new ScanIndex();
    const f1 = makeFileMetadata({ id: 'f1', relativePath: 'a.ts', projectId: 'proj_1' });
    const f2 = makeFileMetadata({ id: 'f2', relativePath: 'b.ts', projectId: 'proj_1' });
    const f3 = makeFileMetadata({ id: 'f3', relativePath: 'c.ts', projectId: 'proj_2' });
    index.upsertMetadata(f1);
    index.upsertMetadata(f2);
    index.upsertMetadata(f3);

    const p1 = index.listByProject('proj_1');
    expect(p1.map((f) => f.id).sort()).toEqual(['f1', 'f2']);
    expect(index.listByProject('proj_2').map((f) => f.id)).toEqual(['f3']);
    expect(index.listByProject('missing')).toEqual([]);
  });

  it('should get all files in deterministic order', () => {
    const index = new ScanIndex();
    index.upsertMetadata(makeFileMetadata({ id: 'f2', relativePath: 'b.ts' }));
    index.upsertMetadata(makeFileMetadata({ id: 'f1', relativePath: 'a.ts' }));
    const all = index.getAllFiles();
    expect(all.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(index.getFileCount()).toBe(2);
  });

  it('should update metadata for an existing file', () => {
    const index = new ScanIndex();
    const original = makeFileMetadata({ id: 'f1', relativePath: 'a.ts', size: 100 });
    index.upsertMetadata(original);
    const updated = makeFileMetadata({ id: 'f1', relativePath: 'a.ts', size: 200, name: 'a.v2.ts' });
    const changed = index.upsertMetadata(updated);
    expect(changed).toBe(true);
    const byId = index.getById('f1');
    expect(byId?.size).toBe(200);
    expect(byId?.name).toBe('a.v2.ts');
    // Path lookup still works under same path.
    expect(index.getByPath('/root/a.ts')?.id).toBe('f1');
  });

  it('should return false when upserting unchanged metadata', () => {
    const index = new ScanIndex();
    const file = makeFileMetadata({ id: 'f1', relativePath: 'a.ts' });
    index.upsertMetadata(file);
    expect(index.upsertMetadata(file)).toBe(false);
  });

  it('should re-index under a new path when absolute path changes', () => {
    const index = new ScanIndex();
    const original = makeFileMetadata({ id: 'f1', relativePath: 'a.ts', absolutePath: '/root/a.ts' });
    index.upsertMetadata(original);
    const moved = makeFileMetadata({
      id: 'f1',
      relativePath: 'b.ts',
      absolutePath: '/root/b.ts',
      name: 'b.ts',
    });
    index.upsertMetadata(moved);
    expect(index.getByPath('/root/a.ts')).toBeUndefined();
    expect(index.getByPath('/root/b.ts')?.id).toBe('f1');
  });

  it('should remove a file by id', () => {
    const index = new ScanIndex();
    const file = makeFileMetadata({ id: 'f1', relativePath: 'a.ts' });
    index.upsertMetadata(file);
    expect(index.removeFile('f1')).toBe(true);
    expect(index.getById('f1')).toBeUndefined();
    expect(index.getByPath('/root/a.ts')).toBeUndefined();
    expect(index.removeFile('f1')).toBe(false);
    expect(index.getFileCount()).toBe(0);
  });

  it('should remove all files in a folder', () => {
    const index = new ScanIndex();
    index.upsertMetadata(makeFileMetadata({ id: 'f1', relativePath: 'a.ts', workspaceFolderId: 'folder_a' }));
    index.upsertMetadata(makeFileMetadata({ id: 'f2', relativePath: 'b.ts', workspaceFolderId: 'folder_a' }));
    index.upsertMetadata(makeFileMetadata({ id: 'f3', relativePath: 'c.ts', workspaceFolderId: 'folder_b' }));
    const removed = index.removeFolder('folder_a');
    expect(removed).toBe(2);
    expect(index.listByFolder('folder_a')).toEqual([]);
    expect(index.listByFolder('folder_b').map((f) => f.id)).toEqual(['f3']);
    expect(index.getFileCount()).toBe(1);
  });

  it('should replace results after a successful full scan', () => {
    const index = new ScanIndex();
    index.upsertMetadata(makeFileMetadata({ id: 'old', relativePath: 'old.ts' }));
    expect(index.isComplete()).toBe(false);
    expect(index.getFileCount()).toBe(1);

    const fresh = [makeFileMetadata({ id: 'new', relativePath: 'new.ts' })];
    index.replaceResults(fresh, 'ws_new');
    expect(index.getFileCount()).toBe(1);
    expect(index.getById('old')).toBeUndefined();
    expect(index.getById('new')).toBeDefined();
    expect(index.isComplete()).toBe(true);
    expect(index.getWorkspaceId()).toBe('ws_new');
    expect(index.getLastSuccessfulScanTimestamp()).toBeDefined();
    expect(typeof index.getLastSuccessfulScanTimestamp()).toBe('number');
  });

  it('should report a partial index after a failed or cancelled scan', () => {
    const index = new ScanIndex();
    index.replaceResults([makeFileMetadata({ id: 'f1', relativePath: 'a.ts' })], 'ws_1');
    expect(index.isComplete()).toBe(true);

    index.markPartial('ws_1');
    expect(index.isComplete()).toBe(false);
    // The previous complete timestamp should not be advanced by a partial mark.
    const ts = index.getLastSuccessfulScanTimestamp();
    expect(ts).toBeDefined();
  });

  it('should clear the index without recording a successful scan', () => {
    const index = new ScanIndex();
    index.replaceResults([makeFileMetadata({ id: 'f1', relativePath: 'a.ts' })], 'ws_1');
    index.clear();
    expect(index.getFileCount()).toBe(0);
    expect(index.isComplete()).toBe(false);
    expect(index.getWorkspaceId()).toBeNull();
    expect(index.getLastSuccessfulScanTimestamp()).toBeNull();
  });

  it('should start empty with no workspace and no timestamp', () => {
    const index = new ScanIndex();
    expect(index.getFileCount()).toBe(0);
    expect(index.isComplete()).toBe(false);
    expect(index.getWorkspaceId()).toBeNull();
    expect(index.getLastSuccessfulScanTimestamp()).toBeNull();
  });
});
