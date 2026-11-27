import { describe, it, expect } from 'vitest';
import {
  TerminalErrorCode,
  TerminalError,
  createTerminalError,
  isTerminalError,
  isTerminalErrorCode,
} from '../errors.js';
import { createSanitizedContext } from '@nexipi/core';

describe('TerminalErrorCode', () => {
  it('defines all required error codes', () => {
    expect(TerminalErrorCode.TERMINAL_INVALID_REQUEST).toBe('TERMINAL_INVALID_REQUEST');
    expect(TerminalErrorCode.TERMINAL_INVALID_TRANSITION).toBe('TERMINAL_INVALID_TRANSITION');
    expect(TerminalErrorCode.TERMINAL_INVALID_RESULT).toBe('TERMINAL_INVALID_RESULT');
    expect(TerminalErrorCode.TERMINAL_INVALID_IDENTITY).toBe('TERMINAL_INVALID_IDENTITY');
    expect(TerminalErrorCode.TERMINAL_APPROVAL_BINDING_MISMATCH).toBe('TERMINAL_APPROVAL_BINDING_MISMATCH');
    expect(TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION).toBe('TERMINAL_UNSUPPORTED_CONFIGURATION');
    expect(TerminalErrorCode.TERMINAL_OUTPUT_LIMIT_VIOLATION).toBe('TERMINAL_OUTPUT_LIMIT_VIOLATION');
  });
});

describe('TerminalError', () => {
  it('creates an error with all properties', () => {
    const cause = new Error('Original failure');
    const context = { requestId: 'req-123', apiKey: 'secret-key' };
    const error = new TerminalError(
      TerminalErrorCode.TERMINAL_INVALID_REQUEST,
      'Invalid terminal request',
      { terminalId: 'term-1', requestId: 'req-1', cause, context, retryable: true }
    );

    expect(error.code).toBe(TerminalErrorCode.TERMINAL_INVALID_REQUEST);
    expect(error.message).toBe('Invalid terminal request');
    expect(error.name).toBe('TerminalError');
    expect(error.terminalId).toBe('term-1');
    expect(error.requestId).toBe('req-1');
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it('defaults retryable to false', () => {
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_IDENTITY, 'Bad identity');
    expect(error.retryable).toBe(false);
  });

  it('defaults terminalId and requestId to undefined', () => {
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'cancelled');
    expect(error.terminalId).toBeUndefined();
    expect(error.requestId).toBeUndefined();
  });
});

describe('createTerminalError', () => {
  it('creates a TerminalError instance', () => {
    const error = createTerminalError(TerminalErrorCode.TERMINAL_OUTPUT_LIMIT_VIOLATION, 'Output too large');
    expect(error).toBeInstanceOf(TerminalError);
    expect(error.code).toBe(TerminalErrorCode.TERMINAL_OUTPUT_LIMIT_VIOLATION);
  });
});

describe('isTerminalError', () => {
  it('returns true for TerminalError', () => {
    expect(
      isTerminalError(new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'x'))
    ).toBe(true);
  });

  it('returns false for EngineError', () => {
    const { createEngineError, EngineErrorCode } = require('@nexipi/core');
    expect(isTerminalError(createEngineError(EngineErrorCode.INTERNAL_ERROR, 'Internal'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTerminalError(new Error('test'))).toBe(false);
    expect(isTerminalError('string')).toBe(false);
    expect(isTerminalError(null)).toBe(false);
    expect(isTerminalError(undefined)).toBe(false);
    expect(isTerminalError({})).toBe(false);
  });
});

describe('isTerminalErrorCode', () => {
  it('returns true when code matches', () => {
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Timed out');
    expect(isTerminalErrorCode(error, TerminalErrorCode.TERMINAL_INVALID_REQUEST)).toBe(true);
  });

  it('returns false when code does not match', () => {
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Timed out');
    expect(isTerminalErrorCode(error, TerminalErrorCode.TERMINAL_OUTPUT_LIMIT_VIOLATION)).toBe(false);
  });

  it('returns false for non-TerminalError', () => {
    expect(isTerminalErrorCode(new Error('x'), TerminalErrorCode.TERMINAL_INVALID_REQUEST)).toBe(false);
  });
});

describe('TerminalError toJSON', () => {
  it('serializes only safe diagnostic fields', () => {
    const cause = new Error('Original failure with secret sk-12345');
    const context = { requestId: 'req-123', normalField: 'visible' };
    const error = new TerminalError(
      TerminalErrorCode.TERMINAL_TIMEOUT,
      'Timed out with key sk-abcde',
      { terminalId: 'term-1', requestId: 'req-1', cause, context, retryable: false }
    );

    const json = error.toJSON();
    expect(json.name).toBe('TerminalError');
    expect(json.code).toBe(TerminalErrorCode.TERMINAL_TIMEOUT);
    expect(json.terminalId).toBe('term-1');
    expect(json.requestId).toBe('req-1');
    expect(json.retryable).toBe(false);

    // Unsafe fields must not be serialized
    expect(json.message).toBeUndefined();
    expect(json.cause).toBeUndefined();
    expect(json.stack).toBeUndefined();
    expect(json.context).toBeUndefined();
    expect(json).not.toHaveProperty('context');
  });

  it('does not leak secret values stored under sensitive context keys', () => {
    const context = {
      requestId: 'req-1',
      apiKey: 'sk-12345',
      password: 'hunter2',
      authorization: 'Bearer token',
      accessToken: 'at-abc',
      normalField: 'visible',
    };
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Invalid request', { context });

    const json = error.toJSON();
    expect(json.context).toBeUndefined();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('sk-12345');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Bearer token');
    expect(serialized).not.toContain('at-abc');
    expect(serialized).not.toContain('authorization');
  });

  it('does not expose secrets embedded in the error message in serialized output', () => {
    const error = new TerminalError(
      TerminalErrorCode.TERMINAL_UNSUPPORTED_CONFIGURATION,
      'Failed with apiKey sk-live-1234567890abcdef',
      { terminalId: 'term-1' }
    );

    const json = error.toJSON();
    expect(json.message).toBeUndefined();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('sk-live-1234567890abcdef');
    expect(serialized).not.toContain('apiKey');
  });

  it('does not expose stack trace in serialized output', () => {
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Not found');
    const json = error.toJSON();
    expect(json.stack).toBeUndefined();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('at ');
    expect(serialized).not.toContain('Error:');
  });

  it('keeps safe diagnostic info accessible on the instance but not serialized', () => {
    const cause = new Error('Original failure');
    const context = { requestId: 'req-123' };
    const error = new TerminalError(
      TerminalErrorCode.TERMINAL_TIMEOUT,
      'Timed out',
      { terminalId: 'term-1', requestId: 'req-1', cause, context, retryable: true }
    );

    // Instance retains full diagnostic info internally
    expect(error.message).toBe('Timed out');
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual(context);
    expect(error.terminalId).toBe('term-1');
    expect(error.requestId).toBe('req-1');
    expect(error.stack).toBeDefined();

    // But never serialized
    const json = error.toJSON();
    expect(json.context).toBeUndefined();
    expect(json.cause).toBeUndefined();
  });
});

describe('TerminalError context is sanitized', () => {
  it('redacts sensitive keys in the serialized context via createSanitizedContext', () => {
    const context = createSanitizedContext({ requestId: 'req-1', secretToken: 'sk-hidden' });
    const error = new TerminalError(TerminalErrorCode.TERMINAL_INVALID_REQUEST, 'Invalid request', {
      terminalId: 'term-1',
      context,
    });
    // The sanitized context redacts the sensitive key internally.
    expect(error.context?.secretToken).toBe('[REDACTED]');
    expect(error.context?.requestId).toBe('req-1');
  });
});

