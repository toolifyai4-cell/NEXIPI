import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  createNoopLogger,
  LOG_LEVELS,
  type LogLevel,
  type Logger,
} from './logger.js';
import type { EngineConfig } from './config.js';

const originalConsoleLog = console.log;

describe('logger', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    console.log = vi.fn((msg: string) => {
      logs.push(msg);
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  function createConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
    return {
      name: 'test',
      version: '1.0.0',
      logLevel: 'info',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 30000,
      enableTelemetry: false,
      ...overrides,
    };
  }

  describe('createLogger', () => {
    it('should log at info level by default', () => {
      const logger = createLogger(createConfig());
      logger.info('test message');
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[INFO]');
      expect(logs[0]).toContain('test message');
    });

    it('should log debug when level is debug', () => {
      const logger = createLogger(createConfig({ logLevel: 'debug' }));
      logger.debug('debug message');
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[DEBUG]');
    });

    it('should not log debug when level is info', () => {
      const logger = createLogger(createConfig({ logLevel: 'info' }));
      logger.debug('debug message');
      expect(logs.length).toBe(0);
    });

    it('should log info when level is info', () => {
      const logger = createLogger(createConfig({ logLevel: 'info' }));
      logger.info('info message');
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[INFO]');
    });

    it('should log warn when level is warn', () => {
      const logger = createLogger(createConfig({ logLevel: 'warn' }));
      logger.warn('warn message');
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[WARN]');
    });

    it('should not log info when level is warn', () => {
      const logger = createLogger(createConfig({ logLevel: 'warn' }));
      logger.info('info message');
      expect(logs.length).toBe(0);
    });

    it('should log error when level is error', () => {
      const logger = createLogger(createConfig({ logLevel: 'error' }));
      logger.error('error message');
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[ERROR]');
    });

    it('should not log warn when level is error', () => {
      const logger = createLogger(createConfig({ logLevel: 'error' }));
      logger.warn('warn message');
      expect(logs.length).toBe(0);
    });

    it('should include metadata in log', () => {
      const logger = createLogger(createConfig());
      logger.info('message with meta', { key: 'value', number: 42 });
      expect(logs[0]).toContain('key');
      expect(logs[0]).toContain('value');
      expect(logs[0]).toContain('42');
    });

    it('should sanitize sensitive keys', () => {
      const logger = createLogger(createConfig());
      logger.info('message', { apiKey: 'secret123', token: 'abc', normal: 'value' });
      expect(logs[0]).toContain('[REDACTED]');
      expect(logs[0]).not.toContain('secret123');
      expect(logs[0]).not.toContain('abc');
      expect(logs[0]).toContain('value');
    });

    it('should sanitize nested sensitive keys', () => {
      const logger = createLogger(createConfig());
      logger.info('message', { config: { password: 'secret', other: 'value' } });
      expect(logs[0]).toContain('[REDACTED]');
      expect(logs[0]).not.toContain('secret');
      expect(logs[0]).toContain('value');
    });

    it('should include timestamp', () => {
      const logger = createLogger(createConfig());
      logger.info('test');
      expect(logs[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });
  });

  describe('createNoopLogger', () => {
    it('should not log anything', () => {
      const logger = createNoopLogger();
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      expect(logs.length).toBe(0);
    });

    it('should implement Logger interface', () => {
      const logger = createNoopLogger();
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });
  });

  describe('LOG_LEVELS', () => {
    it('should have correct level values', () => {
      expect(LOG_LEVELS.debug).toBe(0);
      expect(LOG_LEVELS.info).toBe(1);
      expect(LOG_LEVELS.warn).toBe(2);
      expect(LOG_LEVELS.error).toBe(3);
    });
  });
});
