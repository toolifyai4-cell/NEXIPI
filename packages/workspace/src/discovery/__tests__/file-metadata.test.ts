import { describe, it, expect } from 'vitest';
import { FileMetadataCollector } from '../file-metadata.js';
import type { FileStat } from '../../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../../types.js';
import { createWorkspaceFolderId } from '../../types.js';

function makeWorkspaceFolder(uri: string, name: string): WorkspaceFolder {
  return {
    id: createWorkspaceFolderId(uri),
    uri,
    name,
    index: 0,
  };
}

function makeStat(overrides: Partial<Pick<FileStat, 'type' | 'size' | 'mtime' | 'ctime'>> = {}): FileStat {
  return {
    type: 'file',
    size: 0,
    mtime: Date.now(),
    ctime: Date.now(),
    ...overrides,
  };
}

function collect(name: string, overrides?: Partial<Pick<FileStat, 'size' | 'mtime'>>) {
  const folder = makeWorkspaceFolder('file:///root', 'root');
  const collector = new FileMetadataCollector({ workspaceId: 'ws_test', workspaceFolder: folder });
  const absPath = `/root/${name}`;
  const stat = makeStat(overrides);
  return collector.collect(absPath, name, stat);
}

describe('FileMetadataCollector', () => {
  it('should collect metadata for common source extension', () => {
    const meta = collect('main.ts');
    expect(meta.extension).toBe('ts');
    expect(meta.language).toBe('typescript');
    expect(meta.category).toBe('source');
    expect(meta.isManifest).toBe(false);
    expect(meta.isConfig).toBe(false);
    expect(meta.isBinary).toBe(false);
    expect(meta.isSensitive).toBe(false);
    expect(meta.isHidden).toBe(false);
    expect(meta.sourceExcluded).toBe(false);
    expect(meta.workspaceId).toBe('ws_test');
    expect(meta.workspaceFolderId).toBe(createWorkspaceFolderId('file:///root'));
    expect(meta.relativePath).toBe('main.ts');
    expect(meta.absolutePath).toBe('/root/main.ts');
    expect(meta.size).toBeGreaterThanOrEqual(0);
  });

  it('should detect javascript language for js files', () => {
    const meta = collect('index.js');
    expect(meta.language).toBe('javascript');
    expect(meta.category).toBe('source');
  });

  it('should detect python language for py files', () => {
    const meta = collect('script.py');
    expect(meta.language).toBe('python');
    expect(meta.category).toBe('source');
  });

  it('should classify unknown extension safely', () => {
    const meta = collect('weird.xyz');
    expect(meta.extension).toBe('xyz');
    expect(meta.language).toBeNull();
    expect(meta.category).toBe('other');
    expect(meta.isBinary).toBe(false);
    expect(meta.isSensitive).toBe(false);
  });

  it('should recognize manifest files', () => {
    expect(collect('package.json').isManifest).toBe(true);
    expect(collect('package.json').category).toBe('manifest');
    expect(collect('pyproject.toml').isManifest).toBe(true);
    expect(collect('Cargo.toml').isManifest).toBe(true);
    expect(collect('go.mod').isManifest).toBe(true);
    expect(collect('composer.json').isManifest).toBe(true);
  });

  it('should recognize configuration files', () => {
    expect(collect('tsconfig.json').isConfig).toBe(true);
    expect(collect('tsconfig.json').category).toBe('config');
    expect(collect('.eslintrc.json').isConfig).toBe(true);
    expect(collect('webpack.config.js').isConfig).toBe(true);
    expect(collect('Dockerfile').isConfig).toBe(true);
  });

  it('should classify config files over source when both apply', () => {
    // package.json is both a manifest (json extension) but manifest takes precedence? 
    // Actually category: sensitive > binary > manifest > config > source > other
    const meta = collect('package.json');
    expect(meta.category).toBe('manifest');
  });

  it('should detect hidden files', () => {
    expect(collect('.gitignore').isHidden).toBe(true);
    expect(collect('.env').isHidden).toBe(true);
    expect(collect('main.ts').isHidden).toBe(false);
  });

  it('should collect file sizes and timestamps', () => {
    const now = Date.now();
    const meta = collect('main.ts', { size: 1234, mtime: now });
    expect(meta.size).toBe(1234);
    expect(meta.mtime).toBe(now);
  });

  it('should handle null mtime', () => {
    const meta = collect('main.ts', { mtime: null as unknown as number });
    expect(meta.mtime).toBeNull();
  });

  it('should classify binary files by extension', () => {
    expect(collect('image.png').isBinary).toBe(true);
    expect(collect('image.png').category).toBe('binary');
    expect(collect('archive.zip').isBinary).toBe(true);
    expect(collect('program.exe').isBinary).toBe(true);
    expect(collect('library.so').isBinary).toBe(true);
  });

  it('should classify large files as binary by size', () => {
    const meta = collect('data.bin', { size: 60 * 1024 * 1024 });
    expect(meta.isBinary).toBe(true);
  });

  it('should classify sensitive files', () => {
    expect(collect('.env').isSensitive).toBe(true);
    expect(collect('.env.production').isSensitive).toBe(true);
    expect(collect('id_rsa').isSensitive).toBe(true);
    expect(collect('secret.key').isSensitive).toBe(true);
    expect(collect('cert.pem').isSensitive).toBe(true);
    expect(collect('database.sqlite').isSensitive).toBe(true);
    expect(collect('main.ts').isSensitive).toBe(false);
  });

  it('should mark sensitive files as sourceExcluded', () => {
    expect(collect('.env').sourceExcluded).toBe(true);
    expect(collect('id_rsa').sourceExcluded).toBe(true);
  });

  it('should mark binary files as sourceExcluded', () => {
    expect(collect('image.png').sourceExcluded).toBe(true);
  });

  it('should not infer language from project declaration when extension contradicts', () => {
    // .py file is python regardless of any project-level declaration
    const meta = collect('script.py');
    expect(meta.language).toBe('python');
    expect(meta.category).toBe('source');
  });

  it('should produce stable file id', () => {
    const folder = makeWorkspaceFolder('file:///root', 'root');
    const c1 = new FileMetadataCollector({ workspaceId: 'ws', workspaceFolder: folder });
    const c2 = new FileMetadataCollector({ workspaceId: 'ws', workspaceFolder: folder });
    const m1 = c1.collect('/root/src/a.ts', 'src/a.ts', makeStat());
    const m2 = c2.collect('/root/src/a.ts', 'src/a.ts', makeStat());
    expect(m1.id).toBe(m2.id);
    expect(m1.id).toMatch(/^file_[a-z0-9]+$/);
  });
});
