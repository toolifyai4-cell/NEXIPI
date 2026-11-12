import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME, DEFAULT_LOG_LEVEL } from './constants.js';
import type { LogLevel } from './types.js';

describe('shared', () => {
  it('should have correct package name', () => {
    expect(PACKAGE_NAME).toBe('@nexipi/shared');
  });

  it('should have default log level', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info');
  });

  it('should export valid LogLevel type', () => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    expect(levels).toContain(DEFAULT_LOG_LEVEL);
  });
});
