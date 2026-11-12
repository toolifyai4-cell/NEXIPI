import { describe, it, expect } from 'vitest';
import { version } from './version.ts';
import { defaultConfig } from './index.ts';

describe('core', () => {
  it('should have a version', () => {
    expect(version).toBeDefined();
    expect(typeof version).toBe('string');
  });

  it('should export defaultConfig', () => {
    expect(defaultConfig).toBeDefined();
    expect(defaultConfig.name).toBe('nexipi');
    expect(defaultConfig.version).toBe('0.0.1');
  });
});
