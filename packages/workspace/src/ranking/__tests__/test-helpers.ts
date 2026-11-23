import type { FileMetadata, WorkspaceFolderId } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';

export function makeFileMetadata(overrides: {
  id?: string;
  relativePath?: string;
  absolutePath?: string;
  workspaceFolderId?: WorkspaceFolderId;
  projectId?: string;
  name?: string;
  extension?: string;
  size?: number;
  mtime?: number | null;
  language?: string | null;
  category?: FileMetadata['category'];
  isHidden?: boolean;
  isManifest?: boolean;
  isConfig?: boolean;
  isBinary?: boolean;
  isSensitive?: boolean;
  sourceExcluded?: boolean;
}): FileMetadata {
  const relativePath = overrides.relativePath ?? 'src/main.ts';
  const name = overrides.name ?? 'main.ts';
  const extension = overrides.extension ?? 'ts';
  const workspaceFolderId =
    overrides.workspaceFolderId ?? createWorkspaceFolderId('folder_1');

  return {
    id: overrides.id ?? `file_${relativePath}`,
    workspaceId: 'ws_1',
    workspaceFolderId,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    absolutePath: overrides.absolutePath ?? `/root/${relativePath}`,
    uri: `file:///root/${relativePath}`,
    relativePath,
    name,
    extension,
    size: overrides.size ?? 100,
    mtime: overrides.mtime ?? Date.now(),
    language: overrides.language ?? 'typescript',
    category: overrides.category ?? 'source',
    isHidden: overrides.isHidden ?? false,
    isManifest: overrides.isManifest ?? false,
    isConfig: overrides.isConfig ?? false,
    isBinary: overrides.isBinary ?? false,
    isSensitive: overrides.isSensitive ?? false,
    sourceExcluded: overrides.sourceExcluded ?? false,
  };
}

export function makeSourceFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'source',
    isBinary: false,
    isSensitive: false,
    sourceExcluded: false,
    ...overrides,
  });
}

export function makeConfigFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'config',
    isConfig: true,
    isBinary: false,
    isSensitive: false,
    sourceExcluded: false,
    ...overrides,
  });
}

export function makeManifestFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'manifest',
    isManifest: true,
    isBinary: false,
    isSensitive: false,
    sourceExcluded: false,
    ...overrides,
  });
}

export function makeTestFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'source',
    isBinary: false,
    isSensitive: false,
    sourceExcluded: false,
    ...overrides,
  });
}

export function makeSensitiveFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'sensitive',
    isSensitive: true,
    sourceExcluded: true,
    ...overrides,
  });
}

export function makeBinaryFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'binary',
    isBinary: true,
    sourceExcluded: true,
    ...overrides,
  });
}

export function makeHiddenFile(relativePath: string, overrides: Partial<Parameters<typeof makeFileMetadata>[0]> = {}): FileMetadata {
  return makeFileMetadata({
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: relativePath.split('.').pop() ?? '',
    category: 'source',
    isHidden: true,
    ...overrides,
  });
}

export function makeRankingCandidateInput(overrides: {
  id?: string;
  relativePath?: string;
  absolutePath?: string;
  workspaceFolderId?: string;
  projectId?: string;
  category?: FileMetadata['category'];
  language?: string | null;
  size?: number;
  overallScore?: number;
  normalizedScore?: number;
  isEligible?: boolean;
  inclusionReasons?: readonly string[];
  exclusionReasons?: readonly string[];
}): {
  id: string;
  relativePath: string;
  absolutePath: string;
  workspaceFolderId: string;
  projectId: string | undefined;
  category: FileMetadata['category'];
  language: string | null;
  size: number;
  overallScore: number;
  normalizedScore: number;
  isEligible: boolean;
  inclusionReasons: readonly string[];
  exclusionReasons: readonly string[];
} {
  const relativePath = overrides.relativePath ?? 'src/main.ts';
  return {
    id: overrides.id ?? `file_${relativePath}`,
    relativePath,
    absolutePath: overrides.absolutePath ?? `/root/${relativePath}`,
    workspaceFolderId: overrides.workspaceFolderId ?? 'folder_1',
    projectId: overrides.projectId,
    category: overrides.category ?? 'source',
    language: overrides.language ?? 'typescript',
    size: overrides.size ?? 100,
    overallScore: overrides.overallScore ?? 0.5,
    normalizedScore: overrides.normalizedScore ?? 0.5,
    isEligible: overrides.isEligible ?? true,
    inclusionReasons: overrides.inclusionReasons ?? [],
    exclusionReasons: overrides.exclusionReasons ?? [],
  };
}
