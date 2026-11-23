import { describe, it, expect } from 'vitest';
import {
  ToolErrorCode,
  type ReferenceClassification,
  type ReferenceConfidence,
  type ReferenceLanguage,
  type ReferenceDiscoveryInput,
  type ReferenceDiscoveryOptions,
  type ReferenceDiscoveryResult,
  type ReferenceFileResult,
  type ReferenceOccurrence,
  validateReferenceConfig,
  validateReferenceDiscoveryInput,
  defaultReferenceConfig,
} from '../index.js';

describe('ReferenceDiscoveryInputSchema', () => {
  const validBase = {
    symbol: 'foo',
    classifications: ['definition', 'usage'],
    languages: ['typescript', 'python'],
    includePatterns: ['**/*.ts'],
    excludePatterns: ['**/*.d.ts'],
    maxFilesExamined: 100,
    maxTotalBytesRead: 1024,
    maxReferencesPerFile: 10,
    maxTotalReferences: 50,
    maxOutputSize: 65536,
    enableLexicalFallback: true,
  };

  it('accepts a valid symbol', () => {
    expect(() => validateReferenceDiscoveryInput({ symbol: 'mySymbol' })).not.toThrow();
  });

  it('accepts a minimal valid input', () => {
    const result = validateReferenceDiscoveryInput({ symbol: 'x' });
    expect(result.symbol).toBe('x');
    expect(result.classifications).toBeUndefined();
    expect(result.languages).toBeUndefined();
  });

  it('rejects an empty symbol', () => {
    expect(() => validateReferenceDiscoveryInput({ symbol: '' })).toThrow();
  });

  it('rejects a symbol that is too long', () => {
    const long = 'a'.repeat(257);
    expect(() => validateReferenceDiscoveryInput({ symbol: long })).toThrow();
  });

  it('accepts the maximum-length symbol', () => {
    const max = 'a'.repeat(256);
    expect(() => validateReferenceDiscoveryInput({ symbol: max })).not.toThrow();
  });

  it('accepts valid classification filters', () => {
    const valid: ReferenceClassification[] = [
      'definition',
      'declaration',
      'usage',
      'import',
      'export',
      'call',
      'textual_match',
    ];
    expect(() => validateReferenceDiscoveryInput({ symbol: 'x', classifications: valid })).not.toThrow();
  });

  it('rejects invalid classification filters', () => {
    expect(() =>
      validateReferenceDiscoveryInput({ symbol: 'x', classifications: ['semantic'] as unknown as ReferenceClassification[] })
    ).toThrow();
    expect(() =>
      validateReferenceDiscoveryInput({ symbol: 'x', classifications: [''] as unknown as ReferenceClassification[] })
    ).toThrow();
  });

  it('accepts valid language filters', () => {
    const valid: ReferenceLanguage[] = ['javascript', 'typescript', 'python'];
    expect(() => validateReferenceDiscoveryInput({ symbol: 'x', languages: valid })).not.toThrow();
  });

  it('rejects invalid language filters', () => {
    expect(() =>
      validateReferenceDiscoveryInput({ symbol: 'x', languages: ['cobol'] as unknown as ReferenceLanguage[] })
    ).toThrow();
  });

  it('rejects invalid numeric limits', () => {
    for (const bad of [0, -1]) {
      expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxFilesExamined: bad })).toThrow();
      expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxTotalBytesRead: bad })).toThrow();
      expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxReferencesPerFile: bad })).toThrow();
      expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxTotalReferences: bad })).toThrow();
      expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxOutputSize: bad })).toThrow();
    }
  });

  it('rejects non-integer numeric limits', () => {
    expect(() => validateReferenceDiscoveryInput({ symbol: 'x', maxFilesExamined: 1.5 })).toThrow();
  });

  it('rejects include/exclude patterns that are empty strings', () => {
    expect(() => validateReferenceDiscoveryInput({ symbol: 'x', includePatterns: [''] })).toThrow();
    expect(() => validateReferenceDiscoveryInput({ symbol: 'x', excludePatterns: [''] })).toThrow();
  });

  it('accepts optional fields being omitted', () => {
    const result = validateReferenceDiscoveryInput({ symbol: 'x' });
    expect(result.enableLexicalFallback).toBeUndefined();
    expect(result.includePatterns).toBeUndefined();
    expect(result.excludePatterns).toBeUndefined();
  });
});

describe('ReferenceConfigSchema', () => {
  it('applies conservative defaults', () => {
    const config = validateReferenceConfig({});
    expect(config).toEqual(defaultReferenceConfig);
    expect(config.maxSymbolLength).toBe(256);
    expect(config.maxFilesExamined).toBe(1000);
    expect(config.maxFileSize).toBe(1024 * 1024);
    expect(config.maxTotalBytesRead).toBe(10 * 1024 * 1024);
    expect(config.maxReferencesPerFile).toBe(100);
    expect(config.maxTotalReferences).toBe(1000);
    expect(config.maxOutputSize).toBe(512 * 1024);
    expect(config.supportedSyntaxAwareLanguages).toEqual(['javascript', 'typescript']);
    expect(config.enableLexicalFallback).toBe(true);
  });

  it('rejects non-positive numeric limits', () => {
    expect(() => validateReferenceConfig({ maxFilesExamined: 0 })).toThrow();
    expect(() => validateReferenceConfig({ maxSymbolLength: -5 })).toThrow();
  });

  it('accepts provided overrides', () => {
    const config = validateReferenceConfig({ maxFilesExamined: 10, enableLexicalFallback: false });
    expect(config.maxFilesExamined).toBe(10);
    expect(config.enableLexicalFallback).toBe(false);
    expect(config.maxSymbolLength).toBe(256);
  });
});

describe('ToolErrorCode', () => {
  it('reuses existing codes and adds only the unsupported-language code', () => {
    expect(ToolErrorCode.TOOL_INVALID_ARGUMENT).toBe('TOOL_INVALID_ARGUMENT');
    expect(ToolErrorCode.TOOL_QUERY_TOO_LONG).toBe('TOOL_QUERY_TOO_LONG');
    expect(ToolErrorCode.TOOL_INTERNAL_ERROR).toBe('TOOL_INTERNAL_ERROR');
    expect(ToolErrorCode.TOOL_CANCELLED).toBe('TOOL_CANCELLED');
    expect(ToolErrorCode.TOOL_UNSUPPORTED_LANGUAGE).toBe('TOOL_UNSUPPORTED_LANGUAGE');
  });
});

describe('contracts types', () => {
  it('ReferenceClassification has no semantic classification', () => {
    const classifications: ReferenceClassification[] = [
      'definition',
      'declaration',
      'usage',
      'import',
      'export',
      'call',
      'textual_match',
    ];
    expect(classifications).not.toContain('semantic');
    expect(classifications).toContain('textual_match');
  });

  it('ReferenceConfidence supports low for lexical matches', () => {
    const confidences: ReferenceConfidence[] = ['high', 'medium', 'low'];
    expect(confidences).toContain('low');
  });

  it('ReferenceLanguage is a mixed-language union', () => {
    const languages: ReferenceLanguage[] = ['javascript', 'typescript', 'python', 'java'];
    expect(languages).toContain('python');
    expect(languages).toContain('typescript');
  });

  it('ReferenceDiscoveryOptions is typable', () => {
    const opts: ReferenceDiscoveryOptions = {
      workspaceFolder: { uri: 'file:///ws', id: 'ws' },
      symbol: 'foo',
      enableLexicalFallback: true,
    };
    expect(opts.symbol).toBe('foo');
  });

  it('ReferenceDiscoveryResult, ReferenceFileResult, ReferenceOccurrence are typable', () => {
    const occurrence: ReferenceOccurrence = {
      uri: 'file:///ws/a.ts',
      absolutePath: '/ws/a.ts',
      relativePath: 'a.ts',
      lineNumber: 1,
      startColumn: 0,
      endColumn: 3,
      matchedText: 'foo',
      classification: 'textual_match',
      confidence: 'low',
      language: 'typescript',
      symbol: 'foo',
    };
    const fileResult: ReferenceFileResult = {
      uri: 'file:///ws/a.ts',
      absolutePath: '/ws/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      references: [occurrence],
      referenceCount: 1,
      truncated: false,
      skipped: false,
      skipReason: undefined,
    };
    const result: ReferenceDiscoveryResult = {
      kind: 'reference-discovery',
      uri: 'file:///ws',
      absolutePath: '/ws',
      relativePath: '',
      symbol: 'foo',
      language: undefined,
      files: [fileResult],
      metadata: {
        filesExamined: 1,
        filesSkipped: 0,
        totalReferences: 1,
        truncated: false,
        limitReached: undefined,
        cancelled: false,
        completed: true,
      },
      errors: [],
    };
    expect(result.kind).toBe('reference-discovery');
    expect(result.files[0].references[0].confidence).toBe('low');
  });
});
