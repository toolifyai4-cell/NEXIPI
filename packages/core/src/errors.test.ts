import { describe, it, expect } from 'vitest';
import {
  EngineErrorCode,
  EngineError,
  createEngineError,
  isEngineError,
  assertEngineError,
} from './errors.js';

describe('errors', () => {
  describe('EngineErrorCode', () => {
    it('should have all required error codes', () => {
      expect(EngineErrorCode.INITIALIZATION_FAILED).toBe('INITIALIZATION_FAILED');
      expect(EngineErrorCode.ALREADY_INITIALIZED).toBe('ALREADY_INITIALIZED');
      expect(EngineErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
      expect(EngineErrorCode.ALREADY_STARTED).toBe('ALREADY_STARTED');
      expect(EngineErrorCode.NOT_STARTED).toBe('NOT_STARTED');
      expect(EngineErrorCode.ALREADY_STOPPED).toBe('ALREADY_STOPPED');
      expect(EngineErrorCode.INVALID_LIFECYCLE_TRANSITION).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect(EngineErrorCode.INVALID_CONFIGURATION).toBe('INVALID_CONFIGURATION');
      expect(EngineErrorCode.TASK_NOT_FOUND).toBe('TASK_NOT_FOUND');
      expect(EngineErrorCode.TASK_ALREADY_EXISTS).toBe('TASK_ALREADY_EXISTS');
      expect(EngineErrorCode.TASK_CANCELLED).toBe('TASK_CANCELLED');
      expect(EngineErrorCode.TASK_TIMEOUT).toBe('TASK_TIMEOUT');
      expect(EngineErrorCode.EVENT_EMISSION_FAILED).toBe('EVENT_EMISSION_FAILED');
      expect(EngineErrorCode.LISTENER_ERROR).toBe('LISTENER_ERROR');
      expect(EngineErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });
  });

  describe('EngineError', () => {
    it('should create error with code and message', () => {
      const error = new EngineError(EngineErrorCode.INITIALIZATION_FAILED, 'Failed to init');
      expect(error.code).toBe(EngineErrorCode.INITIALIZATION_FAILED);
      expect(error.message).toBe('Failed to init');
      expect(error.name).toBe('EngineError');
    });

    it('should preserve cause and context', () => {
      const cause = new Error('Original error');
      const context = { foo: 'bar' };
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Internal', { cause, context });
      expect(error.cause).toBe(cause);
      expect(error.context).toEqual(context);
    });

    it('should serialize to JSON', () => {
      const error = new EngineError(EngineErrorCode.INVALID_CONFIGURATION, 'Bad config', {
        context: { key: 'value' },
      });
      const json = error.toJSON();
      expect(json.name).toBe('EngineError');
      expect(json.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
      expect(json.message).toBe('Bad config');
      expect(json.context).toEqual({ key: 'value' });
      expect(json.stack).toBeDefined();
    });
  });

  describe('createEngineError', () => {
    it('should create EngineError instance', () => {
      const error = createEngineError(EngineErrorCode.TASK_NOT_FOUND, 'Task not found');
      expect(error).toBeInstanceOf(EngineError);
      expect(error.code).toBe(EngineErrorCode.TASK_NOT_FOUND);
    });
  });

  describe('isEngineError', () => {
    it('should return true for EngineError', () => {
      const error = new EngineError(EngineErrorCode.INTERNAL_ERROR, 'test');
      expect(isEngineError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      expect(isEngineError(new Error('test'))).toBe(false);
    });

    it('should return false for non-Error', () => {
      expect(isEngineError('string')).toBe(false);
      expect(isEngineError(null)).toBe(false);
      expect(isEngineError(undefined)).toBe(false);
      expect(isEngineError({})).toBe(false);
    });
  });

  describe('assertEngineError', () => {
    it('should pass for matching EngineError', () => {
      const error = new EngineError(EngineErrorCode.TASK_TIMEOUT, 'timeout');
      expect(() => assertEngineError(error, EngineErrorCode.TASK_TIMEOUT)).not.toThrow();
    });

    it('should throw for non-EngineError', () => {
      expect(() => assertEngineError(new Error('test'), EngineErrorCode.TASK_TIMEOUT)).toThrow();
    });

    it('should throw for mismatched code', () => {
      const error = new EngineError(EngineErrorCode.TASK_CANCELLED, 'cancelled');
      expect(() => assertEngineError(error, EngineErrorCode.TASK_TIMEOUT)).toThrow();
    });
  });
});