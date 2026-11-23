import type { FileStat } from '../discovery/workspace-provider.js';
import type { WorkspaceFolder } from '../types.js';
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
  'bat',
  'cmd',
  'sql',
  'graphql',
  'gql',
  'proto',
  'ex',
  'exs',
  'erl',
  'hrl',
  'clj',
  'cljs',
  'cljc',
  'hs',
  'lhs',
  'ml',
  'mli',
  'dart',
  'elm',
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
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'jsonc',
  'xml',
  'toml',
  'yaml',
  'yml',
  'md',
  'markdown',
  'mdx',
  'rst',
  'adoc',
  'tex',
  'dockerfile',
  'tf',
  'hcl',
  'lock',
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

const SENSITIVE_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ed25519_sk',
  'security',
]);

export function splitNameExtension(name: string): { name: string; extension: string } {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { name, extension: '' };
  }
  return { name: name.slice(0, dotIndex), extension: name.slice(dotIndex + 1).toLowerCase() };
}

export function detectLanguage(extension: string): string | null {
  if (extension.length === 0) {
    return null;
  }
  return EXTENSION_LANGUAGE[extension] ?? null;
}

export function isSourceExtension(extension: string): boolean {
  if (extension.length === 0) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(extension);
}

export function isBinaryExtension(extension: string): boolean {
  if (extension.length === 0) {
    return false;
  }
  return (BinaryFileExtensions as readonly string[]).includes(extension);
}

export function isSensitiveFileName(name: string, extension: string): boolean {
  const lowerName = name.toLowerCase();
  if (SENSITIVE_BASENAMES.has(lowerName)) {
    return true;
  }
  if (extension.length > 0) {
    const sensitiveExtensions = new Set([
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
    if (sensitiveExtensions.has(extension)) {
      return true;
    }
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

export function isConfigFile(name: string): boolean {
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

export function isManifestFile(name: string): boolean {
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

export function classifyCategory(params: {
  isManifest: boolean;
  isConfig: boolean;
  isBinary: boolean;
  isSensitive: boolean;
  isSource: boolean;
}): 'source' | 'config' | 'manifest' | 'binary' | 'sensitive' | 'other' {
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

/**
 * Detects likely binary content by scanning for NUL bytes and UTF-8
 * replacement characters. The filesystem provider decodes as UTF-8, so
 * replacement characters indicate undecodable (binary) bytes.
 */
export function isBinaryContent(content: string): boolean {
  if (content.includes('\0')) {
    return true;
  }
  if (content.includes('\uFFFD')) {
    return true;
  }
  return false;
}

/**
 * Computes a stable workspace id from a folder URI, using the same hash
 * algorithm as Phase 08's workspace discovery and file discovery.
 */
export function computeWorkspaceId(uri: string): string {
  const normalized = uri.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `ws_${Math.abs(hash).toString(36)}`;
}

/**
 * Simple glob-like pattern matcher used for directory-listing include filters.
 *
 * Supported syntax:
 * - `*` matches any sequence of characters within a single path segment
 *   (it does not cross `/`).
 * - `**` matches any sequence of characters including `/` (across segments).
 * - `?` matches a single character within a segment.
 * - All other characters are matched literally.
 *
 * Patterns are anchored against the full relative path. This is a small,
 * intentional subset of glob syntax; full glob compatibility is not claimed.
 */
export function matchesIncludePatterns(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  const normalized = relativePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    const regex = patternToRegex(pattern);
    if (regex.test(normalized)) {
      return true;
    }
  }
  return false;
}

function patternToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  const len = pattern.length;
  while (i < len) {
    const ch = pattern[i];
    if (ch === '*' && i + 1 < len && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (i < len && pattern[i] === '/') {
        i += 1;
      }
    } else if (ch === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if ('.+^$()[]{}|\\'.includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}
