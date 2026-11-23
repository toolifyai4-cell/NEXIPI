import type { FileStat } from '../discovery/workspace-provider.js';
import type { FileMetadata, WorkspaceFolder } from '../types.js';
import {
  BinaryFileExtensions,
  ConfigFileNames,
  ManifestFileNames,
  SensitiveFilePatterns,
} from '../config.js';

const SOURCE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'ctsx',
  'py',
  'ipynb',
  'rb',
  'java',
  'kt',
  'kts',
  'scala',
  'cs',
  'vb',
  'fs',
  'fsx',
  'go',
  'rs',
  'swift',
  'objc',
  'mm',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'hh',
  'c',
  'm',
  'php',
  'phtml',
  'rb',
  'erb',
  'r',
  'jl',
  'lua',
  'pl',
  'pm',
  't',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'ps1xml',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'proto',
  'thrift',
  'avro',
  'ex',
  'exs',
  'erl',
  'hrl',
  'exs',
  'clj',
  'cljs',
  'cljc',
  'hs',
  'lhs',
  'ml',
  'mli',
  'vb',
  'vbs',
  'dart',
  'elm',
  'pure',
  'idr',
  'agda',
  'coq',
  'lean',
  'nim',
  'v',
  'sv',
  'svh',
  'vhd',
  'vhdl',
  'asm',
  's',
  'f90',
  'f95',
  'f03',
  'f',
  'for',
  'cob',
  'cbl',
  'abap',
]);

const EXTENSION_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  ipynb: 'python',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  cs: 'csharp',
  vb: 'visualbasic',
  fs: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  objc: 'objective-c',
  mm: 'objective-c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  c: 'c',
  m: 'objective-c',
  php: 'php',
  phtml: 'php',
  erb: 'erb',
  r: 'r',
  jl: 'julia',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  clj: 'clojure',
  cljs: 'clojurescript',
  cljc: 'clojure',
  hs: 'haskell',
  lhs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  dart: 'dart',
  elm: 'elm',
  nim: 'nim',
  v: 'verilog',
  sv: 'systemverilog',
  vhd: 'vhdl',
  vhdl: 'vhdl',
  asm: 'assembly',
  s: 'assembly',
  f90: 'fortran',
  f95: 'fortran',
  f03: 'fortran',
  f: 'fortran',
  for: 'fortran',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  xml: 'xml',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  rst: 'rst',
  adoc: 'asciidoc',
  tex: 'latex',
  dockerfile: 'dockerfile',
  tf: 'hcl',
  hcl: 'hcl',
  lock: 'text',
};

const MAX_BINARY_SIZE = 50 * 1024 * 1024; // 50 MiB

const SENSITIVE_EXTENSIONS = new Set([
  'key',
  'pem',
  'ppk',
  'crt',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'db',
  'sqlite',
  'sqlite3',
]);

const SENSITIVE_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ed25519_sk',
  'security',
]);

function splitNameExtension(name: string): { name: string; extension: string } {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { name, extension: '' };
  }
  return { name: name.slice(0, dotIndex), extension: name.slice(dotIndex + 1).toLowerCase() };
}

function detectLanguage(extension: string): string | null {
  if (extension.length === 0) {
    return null;
  }
  return EXTENSION_LANGUAGE[extension] ?? null;
}

function isSourceExtension(extension: string): boolean {
  if (extension.length === 0) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(extension);
}

function isBinaryExtension(extension: string): boolean {
  if (extension.length === 0) {
    return false;
  }
  return (BinaryFileExtensions as readonly string[]).includes(extension);
}

function isSensitiveFile(name: string, extension: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName === '.env') {
    return true;
  }
  if (lowerName.startsWith('.env.')) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(lowerName)) {
    return true;
  }
  if (extension.length > 0 && SENSITIVE_EXTENSIONS.has(extension)) {
    return true;
  }
  for (const pattern of SensitiveFilePatterns) {
    if (matchesSensitivePattern(lowerName, pattern)) {
      return true;
    }
  }
  return false;
}

function matchesSensitivePattern(lowerName: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const ext = p.slice(1);
    return lowerName.endsWith(ext);
  }
  if (p.includes('*')) {
    const parts = p.split('*');
    const prefix = parts[0] ?? '';
    const suffix = parts[parts.length - 1] ?? '';
    return lowerName.startsWith(prefix) && lowerName.endsWith(suffix);
  }
  return lowerName === p;
}

function isConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  for (const cfg of ConfigFileNames) {
    const c = cfg.toLowerCase();
    if (c.startsWith('*.')) {
      if (lower.endsWith(c.slice(1))) {
        return true;
      }
    } else if (lower === c) {
      return true;
    }
  }
  return false;
}

function isManifestFile(name: string): boolean {
  const lower = name.toLowerCase();
  for (const m of ManifestFileNames) {
    const mm = m.toLowerCase();
    if (mm.startsWith('*.')) {
      if (lower.endsWith(mm.slice(1))) {
        return true;
      }
    } else if (lower === mm) {
      return true;
    }
  }
  return false;
}

export interface FileMetadataCollectorOptions {
  workspaceId: string;
  workspaceFolder: WorkspaceFolder;
  projectId?: string;
}

export class FileMetadataCollector {
  private readonly workspaceId: string;
  private readonly workspaceFolder: WorkspaceFolder;
  private readonly projectId: string | undefined;

  constructor(options: FileMetadataCollectorOptions) {
    this.workspaceId = options.workspaceId;
    this.workspaceFolder = options.workspaceFolder;
    this.projectId = options.projectId;
  }

  collect(
    absolutePath: string,
    relativePath: string,
    stat: FileStat
  ): FileMetadata {
    const baseName = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
    const { name, extension } = splitNameExtension(baseName);
    const isHidden = baseName.startsWith('.');
    const isManifest = isManifestFile(baseName);
    const isConfig = isConfigFile(baseName);
    const isBinary =
      isBinaryExtension(extension) || stat.size > MAX_BINARY_SIZE;
    const isSensitive = isSensitiveFile(name, extension);
    const language = detectLanguage(extension);
    const category = this.classifyCategory({
      isManifest,
      isConfig,
      isBinary,
      isSensitive,
      isSource: isSourceExtension(extension),
      name,
      extension,
    });
    const id = this.computeFileId(relativePath);

    return {
      id,
      workspaceId: this.workspaceId,
      workspaceFolderId: this.workspaceFolder.id,
      ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
      absolutePath,
      uri: `file:///${absolutePath.replace(/^\/+/, '')}`,
      relativePath,
      name,
      extension,
      size: stat.size,
      mtime: stat.mtime ?? null,
      language,
      category,
      isHidden,
      isManifest,
      isConfig,
      isBinary,
      isSensitive,
      sourceExcluded: isSensitive || isBinary,
    };
  }

  private classifyCategory(params: {
    isManifest: boolean;
    isConfig: boolean;
    isBinary: boolean;
    isSensitive: boolean;
    isSource: boolean;
    name: string;
    extension: string;
  }): FileMetadata['category'] {
    if (params.isSensitive) {
      return 'sensitive';
    }
    if (params.isBinary) {
      return 'binary';
    }
    if (params.isManifest) {
      return 'manifest';
    }
    if (params.isConfig) {
      return 'config';
    }
    if (params.isSource) {
      return 'source';
    }
    return 'other';
  }

  private computeFileId(relativePath: string): string {
    const str = `${this.workspaceId}:${relativePath}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `file_${Math.abs(hash).toString(36)}`;
  }
}

export function createFileMetadataCollector(
  options: FileMetadataCollectorOptions
): FileMetadataCollector {
  return new FileMetadataCollector(options);
}
