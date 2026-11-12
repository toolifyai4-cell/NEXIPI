import { describe, it, expect } from 'vitest';

describe('vscode-extension', () => {
  it('should export activate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.activate).toBe('function');
  });

  it('should export deactivate function', async () => {
    const mod = await import('./extension.js');
    expect(typeof mod.deactivate).toBe('function');
  });

  it('should have correct extension metadata in package.json', async () => {
    const pkg = await import('../package.json', { assert: { type: 'json' } });
    expect(pkg.default.name).toBe('nexipi');
    expect(pkg.default.displayName).toBe('NexiPi');
    expect(pkg.default.main).toBe('./dist/extension.js');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.start');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.showOutput');
    expect(pkg.default.activationEvents).toContain('onCommand:nexipi.showInformation');
    expect(pkg.default.contributes.commands).toHaveLength(3);
    expect(pkg.default.contributes.configuration.properties).toHaveProperty('nexipi.enabled');
    expect(pkg.default.contributes.configuration.properties).toHaveProperty('nexipi.logLevel');
  });

  it('should have debugging configuration', async () => {
    const launchConfig = await import('../../../.vscode/launch.json', { assert: { type: 'json' } });
    expect(launchConfig.default.configurations).toHaveLength(2);
    expect(launchConfig.default.configurations[0].name).toBe('Run Extension');
    expect(launchConfig.default.configurations[0].type).toBe('extensionHost');
  });

  it('should have build task configuration', async () => {
    const tasksConfig = await import('../../../.vscode/tasks.json', { assert: { type: 'json' } });
    expect(tasksConfig.default.tasks).toHaveLength(1);
    expect(tasksConfig.default.tasks[0].label).toBe('npm: build - apps/vscode-extension');
  });
});