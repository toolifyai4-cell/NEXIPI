import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitize, SENSITIVE_KEYS, createSanitizedContext } from './sanitize.js';
import { createLogger } from './logger.js';
import { EngineError, EngineErrorCode } from './errors.js';
import { Engine, createEngine } from './engine.js';
import type { EngineConfig } from './config.js';

const originalConsoleLog = console.log;

describe('sanitize', () => {
  describe('SENSITIVE_KEYS', () => {
    it('should include all expected sensitive keys', () => {
      expect(SENSITIVE_KEYS).toContain('apiKey');
      expect(SENSITIVE_KEYS).toContain('api_key');
      expect(SENSITIVE_KEYS).toContain('token');
      expect(SENSITIVE_KEYS).toContain('secret');
      expect(SENSITIVE_KEYS).toContain('password');
      expect(SENSITIVE_KEYS).toContain('auth');
      expect(SENSITIVE_KEYS).toContain('credential');
      expect(SENSITIVE_KEYS).toContain('accessToken');
      expect(SENSITIVE_KEYS).toContain('refreshToken');
      expect(SENSITIVE_KEYS).toContain('apikey');
      expect(SENSITIVE_KEYS).toContain('clientSecret');
      expect(SENSITIVE_KEYS).toContain('client_secret');
      expect(SENSITIVE_KEYS).toContain('privateKey');
      expect(SENSITIVE_KEYS).toContain('private_key');
      expect(SENSITIVE_KEYS).toContain('authorization');
      expect(SENSITIVE_KEYS).toContain('bearer');
    });
  });

  describe('sanitize function', () => {
    it('should redact sensitive keys in flat object', () => {
      const input = { apiKey: 'secret123', normal: 'value' };
      const result = sanitize(input);
      expect(result).toEqual({ apiKey: '[REDACTED]', normal: 'value' });
    });

    it('should redact sensitive keys case-insensitively', () => {
      const input = { APIKEY: 'upper', ApiKey: 'mixed', apikey: 'lower' };
      const result = sanitize(input);
      expect(result).toEqual({
        APIKEY: '[REDACTED]',
        ApiKey: '[REDACTED]',
        apikey: '[REDACTED]',
      });
    });

    it('should redact nested sensitive keys', () => {
      const input = { config: { password: 'secret', other: 'value' } };
      const result = sanitize(input);
      expect(result).toEqual({ config: { password: '[REDACTED]', other: 'value' } });
    });

    it('should redact sensitive keys in arrays', () => {
      const input = { items: [{ apiKey: 'secret1' }, { token: 'secret2' }] };
      const result = sanitize(input);
      expect(result).toEqual({ items: [{ apiKey: '[REDACTED]' }, { token: '[REDACTED]' }] });
    });

    it('should redact deeply nested sensitive keys', () => {
      const input = { data: [[{ password: 'nested' }]] };
      const result = sanitize(input);
      expect(result).toEqual({ data: [[{ password: '[REDACTED]' }]] });
    });

    it('should handle null values', () => {
      const input = { key: null };
      const result = sanitize(input);
      expect(result).toEqual({ key: null });
    });

    it('should handle undefined values', () => {
      const input = { key: undefined };
      const result = sanitize(input);
      expect(result).toEqual({});
    });

    it('should handle circular references', () => {
      const circular: any = { key: 'value' };
      circular.self = circular;
      const result = sanitize(circular);
      expect(result).toEqual({ key: 'value', self: '[CIRCULAR]' });
    });

    it('should not mutate original object', () => {
      const input = { apiKey: 'secret123', normal: 'value' };
      const original = JSON.stringify(input);
      sanitize(input);
      expect(JSON.stringify(input)).toBe(original);
    });

    it('should redact all sensitive key variants', () => {
      const input = {
        apiKey: '1',
        api_key: '2',
        token: '3',
        secret: '4',
        password: '5',
        auth: '6',
        credential: '7',
        accessToken: '8',
        refreshToken: '9',
        apikey: '10',
        clientSecret: '11',
        client_secret: '12',
        privateKey: '13',
        private_key: '14',
        authorization: '15',
        bearer: '16',
      };
      const result = sanitize(input);
      for (const value of Object.values(result)) {
        expect(value).toBe('[REDACTED]');
      }
    });
  });

  describe('createSanitizedContext', () => {
    it('should return undefined for undefined input', () => {
      expect(createSanitizedContext(undefined)).toBeUndefined();
    });

    it('should return undefined for null input', () => {
      expect(createSanitizedContext(null as any)).toBeUndefined();
    });

    it('should sanitize context object', () => {
      const input = { apiKey: 'secret', normal: 'value' };
      const result = createSanitizedContext(input);
      expect(result).toEqual({ apiKey: '[REDACTED]', normal: 'value' });
    });
  });
});

describe('consistent secret redaction across all paths', () => {
  const testSecrets = {
    apiKey: 'api-key-secret',
    api_key: 'api-key-secret-2',
    token: 'token-secret',
    secret: 'secret-value',
    password: 'password-secret',
    auth: 'auth-secret',
    credential: 'credential-secret',
    accessToken: 'access-token-secret',
    refreshToken: 'refresh-token-secret',
    apikey: 'apikey-secret',
    clientSecret: 'client-secret-secret',
    client_secret: 'client-secret-secret-2',
    privateKey: 'private-key-secret',
    private_key: 'private-key-secret-2',
    authorization: 'authorization-secret',
    bearer: 'bearer-secret',
  };

  const testNonSecrets = {
    normalField: 'normal-value',
    userId: 'user-123',
    timestamp: 1234567890,
  };

  describe('logger redaction', () => {
    let logs: string[];

    beforeEach(() => {
      logs = [];
      console.log = vi.fn((msg: string) => logs.push(msg));
    });

    afterEach(() => {
      console.log = originalConsoleLog;
    });

    function createConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
      return {
        name: 'test',
        version: '1.0.0',
        logLevel: 'debug',
        maxConcurrentTasks: 10,
        taskTimeoutMs: 30000,
        enableTelemetry: false,
        ...overrides,
      };
    }

    it('should redact all sensitive keys in logger', () => {
      const logger = createLogger(createConfig());
      logger.info('test message', { ...testSecrets, ...testNonSecrets });

      expect(logs.length).toBe(1);
      const log = logs[0];

      for (const key of Object.keys(testSecrets)) {
        expect(log).not.toContain(testSecrets[key as keyof typeof testSecrets]);
        expect(log).toContain('[REDACTED]');
      }

      for (const key of Object.keys(testNonSecrets)) {
        expect(log).toContain(testNonSecrets[key as keyof typeof testNonSecrets]);
      }
    });

    it('should redact nested secrets in logger', () => {
      const logger = createLogger(createConfig());
      logger.info('nested', { config: { ...testSecrets } });

      const log = logs[0];
      for (const key of Object.keys(testSecrets)) {
        expect(log).not.toContain(testSecrets[key as keyof typeof testSecrets]);
      }
    });

    it('should redact secrets in arrays in logger', () => {
      const logger = createLogger(createConfig());
      logger.info('array', { providers: [{ apiKey: 'key1' }, { token: 'key2' }] });

      const log = logs[0];
      expect(log).not.toContain('key1');
      expect(log).not.toContain('key2');
      expect(log).toContain('[REDACTED]');
    });
  });

  describe('EngineError redaction', () => {
    it('should redact all sensitive keys in EngineError.context at construction', () => {
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: { ...testSecrets, ...testNonSecrets },
      });

      // Check context directly (not through toJSON)
      expect(error.context).toBeDefined();
      if (error.context) {
        for (const key of Object.keys(testSecrets)) {
          expect(error.context[key]).toBe('[REDACTED]');
        }
        for (const key of Object.keys(testNonSecrets)) {
          expect(error.context[key]).toBe(testNonSecrets[key as keyof typeof testNonSecrets]);
        }
      }
    });

    it('should redact nested secrets in EngineError.context', () => {
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: { config: { ...testSecrets } },
      });

      expect(error.context).toBeDefined();
      if (error.context && error.context.config) {
        const config = error.context.config as Record<string, unknown>;
        for (const key of Object.keys(testSecrets)) {
          expect(config[key]).toBe('[REDACTED]');
        }
      }
    });

    it('should redact secrets in arrays in EngineError.context', () => {
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: { providers: [{ apiKey: 'key1' }, { token: 'key2' }] },
      });

      expect(error.context).toBeDefined();
      if (error.context && error.context.providers) {
        const providers = error.context.providers as Array<Record<string, unknown>>;
        expect(providers[0].apiKey).toBe('[REDACTED]');
        expect(providers[1].token).toBe('[REDACTED]');
      }
    });

    it('should have consistent redaction in toJSON()', () => {
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: { ...testSecrets, ...testNonSecrets },
      });

      const json = error.toJSON();
      expect(json.context).toBeDefined();
      if (json.context) {
        for (const key of Object.keys(testSecrets)) {
          expect(json.context[key]).toBe('[REDACTED]');
        }
        for (const key of Object.keys(testNonSecrets)) {
          expect(json.context[key]).toBe(testNonSecrets[key as keyof typeof testNonSecrets]);
        }
      }
    });

    it('should handle circular references in context', () => {
      const circular: any = { apiKey: 'secret' };
      circular.self = circular;

      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: circular,
      });

      expect(error.context).toBeDefined();
      if (error.context) {
        expect(error.context.apiKey).toBe('[REDACTED]');
        expect(error.context.self).toBe('[CIRCULAR]');
      }
    });

    it('should not mutate original context object', () => {
      const originalContext = { ...testSecrets, ...testNonSecrets };
      const originalString = JSON.stringify(originalContext);

      new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test error', {
        context: originalContext,
      });

      expect(JSON.stringify(originalContext)).toBe(originalString);
    });
  });

  describe('engine sanitizeConfig redaction', () => {
    it('should redact all sensitive keys in engine:initialized event config', () => {
      const engine = createEngine({ config: { logLevel: 'error' } });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);

      const config = {
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        maxConcurrentTasks: 10,
        taskTimeoutMs: 30000,
        shutdownTimeoutMs: 10000,
        enableTelemetry: false,
        ...testSecrets,
        ...testNonSecrets,
      };

      const sanitized = sanitizeFn(config);

      for (const key of Object.keys(testSecrets)) {
        expect(sanitized[key]).toBe('[REDACTED]');
      }
      for (const key of Object.keys(testNonSecrets)) {
        expect(sanitized[key]).toBe(testNonSecrets[key as keyof typeof testNonSecrets]);
      }
    });

    it('should redact nested secrets in engine config', () => {
      const engine = createEngine({ config: { logLevel: 'error' } });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);

      const config = {
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        nested: { ...testSecrets },
      };

      const sanitized = sanitizeFn(config);
      const nested = sanitized.nested as Record<string, unknown>;

      for (const key of Object.keys(testSecrets)) {
        expect(nested[key]).toBe('[REDACTED]');
      }
    });

    it('should redact secrets in arrays in engine config', () => {
      const engine = createEngine({ config: { logLevel: 'error' } });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);

      const config = {
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        providers: [{ apiKey: 'key1' }, { token: 'key2' }],
      };

      const sanitized = sanitizeFn(config);
      const providers = sanitized.providers as Array<Record<string, unknown>>;
      expect(providers[0].apiKey).toBe('[REDACTED]');
      expect(providers[1].token).toBe('[REDACTED]');
    });
  });

  describe('cross-path consistency', () => {
    it('should produce identical redaction results across logger, errors, and engine', () => {
      const testObj = { ...testSecrets, ...testNonSecrets };

      // Logger path
      const logger = createLogger({
        name: 'test',
        version: '1.0.0',
        logLevel: 'debug',
        maxConcurrentTasks: 10,
        taskTimeoutMs: 30000,
        enableTelemetry: false,
      });
      const loggerLogs: string[] = [];
      const origLog = console.log;
      console.log = vi.fn((msg: string) => loggerLogs.push(msg));
      logger.info('test', testObj);
      console.log = origLog;

      // EngineError path
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Test', { context: testObj });

      // Engine sanitizeConfig path
      const engine = createEngine({ config: { logLevel: 'error' } });
      const sanitizeFn = (engine as any).sanitizeConfig.bind(engine);
      const sanitizedConfig = sanitizeFn({
        name: 'test',
        version: '1.0.0',
        logLevel: 'info',
        ...testObj,
      });

      // All should redact the same keys
      const loggerLog = loggerLogs[0];
      for (const key of Object.keys(testSecrets)) {
        expect(loggerLog).not.toContain(testSecrets[key as keyof typeof testSecrets]);
        expect(error.context?.[key]).toBe('[REDACTED]');
        expect(sanitizedConfig[key]).toBe('[REDACTED]');
      }
      for (const key of Object.keys(testNonSecrets)) {
        expect(loggerLog).toContain(testNonSecrets[key as keyof typeof testNonSecrets]);
        expect(error.context?.[key]).toBe(testNonSecrets[key as keyof typeof testNonSecrets]);
        expect(sanitizedConfig[key]).toBe(testNonSecrets[key as keyof typeof testNonSecrets]);
      }
    });
  });
});
