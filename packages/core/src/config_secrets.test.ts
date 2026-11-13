import { describe, it, expect, vi } from 'vitest';
import { EngineConfigSchema, validateEngineConfig, mergeEngineConfig } from './config.js';
import { Engine, createEngine } from './engine.js';
import { EngineError, EngineErrorCode } from './errors.js';
import { createLogger } from './logger.js';

describe('configuration and secrets', () => {
  describe('unknown properties handling', () => {
    it('should strip unknown properties by default (strict schema)', () => {
      const result = EngineConfigSchema.safeParse({
        name: 'test',
        version: '1.0.0',
        unknownField: 'should be stripped',
        anotherUnknown: 123,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('unknownField');
        expect(result.data).not.toHaveProperty('anotherUnknown');
      }
    });

    it('should not allow arbitrary provider credentials in config', () => {
      // There's no field for provider credentials in the schema
      const result = EngineConfigSchema.safeParse({
        name: 'test',
        version: '1.0.0',
        providerApiKey: 'secret-key',
        openaiApiKey: 'sk-123',
        anthropicApiKey: 'sk-ant-123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('providerApiKey');
        expect(result.data).not.toHaveProperty('openaiApiKey');
        expect(result.data).not.toHaveProperty('anthropicApiKey');
      }
    });
  });

  describe('secret redaction in nested structures', () => {
    it('should redact secrets in nested objects', () => {
      const engine = createEngine({
        config: { logLevel: 'error' },
      });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);

      const config = {
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        nested: {
          apiKey: 'secret123',
          normalField: 'value',
          deeper: {
            token: 'token456',
            data: 'ok',
          },
        },
      };

      const sanitized = sanitizeFn(config);
      expect(JSON.stringify(sanitized)).not.toContain('secret123');
      expect(JSON.stringify(sanitized)).not.toContain('token456');
      expect(JSON.stringify(sanitized)).toContain('[REDACTED]');
      expect(JSON.stringify(sanitized)).toContain('value');
      expect(JSON.stringify(sanitized)).toContain('ok');
    });

    it('should redact secrets in arrays', () => {
      const engine = createEngine({
        config: { logLevel: 'error' },
      });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);

      const config = {
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        providers: [
          { name: 'openai', apiKey: 'sk-123' },
          { name: 'anthropic', apiKey: 'sk-ant-456' },
        ],
      };

      const sanitized = sanitizeFn(config);
      expect(JSON.stringify(sanitized)).not.toContain('sk-123');
      expect(JSON.stringify(sanitized)).not.toContain('sk-ant-456');
      expect(JSON.stringify(sanitized)).toContain('[REDACTED]');
    });
  });

  describe('secrets in error messages and logs', () => {
    it('should redact secrets in EngineError context', () => {
      // EngineError.toJSON now sanitizes context
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: { apiKey: 'secret123', normal: 'value' },
      });

      const json = error.toJSON();
      // The error now sanitizes context
      expect(json.context).toEqual({ apiKey: '[REDACTED]', normal: 'value' });
    });

    it('should sanitize meta in logger', () => {
      const logger = createLogger({
        logLevel: 'debug',
        name: 'test',
        version: '1.0.0',
        maxConcurrentTasks: 10,
        taskTimeoutMs: 30000,
        enableTelemetry: false,
      });

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = vi.fn((msg: string) => logs.push(msg));

      try {
        logger.info('test message', { apiKey: 'secret123', password: 'pwd123', normal: 'value' });
        expect(logs.some(l => l.includes('secret123'))).toBe(false);
        expect(logs.some(l => l.includes('pwd123'))).toBe(false);
        expect(logs.some(l => l.includes('[REDACTED]'))).toBe(true);
        expect(logs.some(l => l.includes('value'))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    });
  });
});
