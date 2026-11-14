import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryCredentialStore,
  SecretCredentialStore,
  CredentialManager,
  createCredentialStore,
  createCredentialManager,
} from './credentials.js';
import { createProviderId, type ProviderId, type ProviderCredentials } from './types.js';
import { createLogger, type Logger } from '@nexipi/core';

describe('InMemoryCredentialStore', () => {
  let store: InMemoryCredentialStore;
  let logger: Logger;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'debug',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    // Override console.log to capture logs
    const originalLog = console.log;
    console.log = vi.fn((msg: string) => logs.push(msg));
    store = new InMemoryCredentialStore({ logger });
  });

  afterEach(() => {
    console.log = console.log; // reset
  });

  const createTestCredentials = (providerId: ProviderId): ProviderCredentials => ({
    providerId,
    credentials: { apiKey: 'test-key-123', organization: 'org-456' },
  });

  describe('set and get', () => {
    it('should store and retrieve credentials', async () => {
      const providerId = createProviderId('openai');
      const credentials = createTestCredentials(providerId);

      await store.set(credentials);
      const retrieved = await store.get(providerId);

      expect(retrieved).toEqual(credentials);
    });

    it('should return undefined for non-existent provider', async () => {
      const retrieved = await store.get(createProviderId('non-existent'));
      expect(retrieved).toBeUndefined();
    });

    it('should overwrite existing credentials', async () => {
      const providerId = createProviderId('openai');
      await store.set({ providerId, credentials: { apiKey: 'old-key' } });
      await store.set({ providerId, credentials: { apiKey: 'new-key' } });

      const retrieved = await store.get(providerId);
      expect(retrieved?.credentials.apiKey).toBe('new-key');
    });
  });

  describe('delete', () => {
    it('should delete existing credentials', async () => {
      const providerId = createProviderId('openai');
      await store.set(createTestCredentials(providerId));

      const result = await store.delete(providerId);
      expect(result).toBe(true);

      const retrieved = await store.get(providerId);
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent provider', async () => {
      const result = await store.delete(createProviderId('non-existent'));
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('should return empty array initially', async () => {
      const list = await store.list();
      expect(list).toHaveLength(0);
    });

    it('should list all stored provider IDs', async () => {
      await store.set(createTestCredentials(createProviderId('openai')));
      await store.set(createTestCredentials(createProviderId('anthropic')));

      const list = await store.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(createProviderId('openai'));
      expect(list).toContain(createProviderId('anthropic'));
    });
  });

  describe('clear', () => {
    it('should remove all credentials', async () => {
      await store.set(createTestCredentials(createProviderId('openai')));
      await store.set(createTestCredentials(createProviderId('anthropic')));

      store.clear();

      const list = await store.list();
      expect(list).toHaveLength(0);
    });
  });
});

describe('SecretCredentialStore', () => {
  let delegate: InMemoryCredentialStore;
  let store: SecretCredentialStore;
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    delegate = new InMemoryCredentialStore({ logger });
    store = new SecretCredentialStore(delegate, logger);
  });

  const createTestCredentials = (providerId: ProviderId): ProviderCredentials => ({
    providerId,
    credentials: {
      apiKey: 'secret-key-123',
      api_key: 'another-secret',
      accessToken: 'token-456',
      clientSecret: 'client-secret-789',
      normalField: 'visible-value',
      nested: { secret: 'nested-secret', visible: 'nested-visible' },
      array: [{ apiKey: 'array-secret' }, { normal: 'array-visible' }],
    },
  });

  it('should return actual secret values on get', async () => {
    const providerId = createProviderId('openai');
    await store.set(createTestCredentials(providerId));

    const retrieved = await store.get(providerId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.credentials.apiKey).toBe('secret-key-123');
    expect(retrieved!.credentials.api_key).toBe('another-secret');
    expect(retrieved!.credentials.accessToken).toBe('token-456');
    expect(retrieved!.credentials.clientSecret).toBe('client-secret-789');
    expect(retrieved!.credentials.normalField).toBe('visible-value');
    expect(retrieved!.credentials.nested.secret).toBe('nested-secret');
    expect(retrieved!.credentials.nested.visible).toBe('nested-visible');
    expect(retrieved!.credentials.array[0].apiKey).toBe('array-secret');
    expect(retrieved!.credentials.array[1].normal).toBe('array-visible');
  });

  it('should store credentials without redaction', async () => {
    const providerId = createProviderId('openai');
    const credentials = createTestCredentials(providerId);
    await store.set(credentials);

    // Verify the underlying store has the original values
    const direct = await delegate.get(providerId);
    expect(direct!.credentials.apiKey).toBe('secret-key-123');
  });

  it('should delegate delete and list', async () => {
    const providerId = createProviderId('openai');
    await store.set(createTestCredentials(providerId));

    expect(await store.list()).toContain(providerId);

    await store.delete(providerId);
    expect(await store.list()).not.toContain(providerId);
  });

  it('should return undefined for non-existent provider', async () => {
    const retrieved = await store.get(createProviderId('non-existent'));
    expect(retrieved).toBeUndefined();
  });

  it('should return actual values including secret-like keys on get', async () => {
    const providerId = createProviderId('openai');
    await store.set({
      providerId,
      credentials: {
        myApiKey: 'secret-1',
        tokenCount: 'not-a-secret-value',
        normalField: 'visible',
      },
    });

    const retrieved = await store.get(providerId);
    expect(retrieved!.credentials.myApiKey).toBe('secret-1');
    expect(retrieved!.credentials.tokenCount).toBe('not-a-secret-value');
    expect(retrieved!.credentials.normalField).toBe('visible');
  });
});

describe('createCredentialStore', () => {
  it('should create InMemoryCredentialStore by default', () => {
    const store = createCredentialStore();
    expect(store).toBeInstanceOf(SecretCredentialStore);
  });

  it('should wrap provided delegate', () => {
    const delegate = new InMemoryCredentialStore();
    const store = createCredentialStore(delegate);
    expect(store).toBeInstanceOf(SecretCredentialStore);
  });
});

describe('CredentialManager', () => {
  let manager: CredentialManager;
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    manager = createCredentialManager({ logger });
  });

  const createTestCredentials = (providerId: ProviderId): ProviderCredentials => ({
    providerId,
    credentials: { apiKey: 'test-key' },
  });

  it('should manage credentials through manager', async () => {
    const providerId = createProviderId('openai');

    await manager.setCredentials(createTestCredentials(providerId));
    const retrieved = await manager.getCredentials(providerId);

    expect(retrieved).toBeDefined();
    expect(retrieved!.providerId).toBe(providerId);
  });

  it('should delete credentials', async () => {
    const providerId = createProviderId('openai');
    await manager.setCredentials(createTestCredentials(providerId));

    const deleted = await manager.deleteCredentials(providerId);
    expect(deleted).toBe(true);

    const retrieved = await manager.getCredentials(providerId);
    expect(retrieved).toBeUndefined();
  });

  it('should list providers', async () => {
    await manager.setCredentials(createTestCredentials(createProviderId('openai')));
    await manager.setCredentials(createTestCredentials(createProviderId('anthropic')));

    const list = await manager.listProviders();
    expect(list).toHaveLength(2);
  });

  it('should expose underlying store', () => {
    const store = manager.getStore();
    expect(store).toBeInstanceOf(SecretCredentialStore);
  });
});

describe('Credential secret redaction', () => {
  it('should redact common secret key patterns', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    await store.set({
      providerId,
      credentials: {
        apiKey: 'key1',
        api_key: 'key2',
        token: 'token1',
        secret: 'secret1',
        password: 'pass1',
        auth: 'auth1',
        credential: 'cred1',
        accessToken: 'at1',
        refreshToken: 'rt1',
        apikey: 'ak1',
        clientSecret: 'cs1',
        client_secret: 'cs2',
        privateKey: 'pk1',
        private_key: 'pk2',
        authorization: 'authz1',
        bearer: 'bearer1',
        customField: 'visible',
      },
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.apiKey).toBe('[REDACTED]');
    expect(creds.api_key).toBe('[REDACTED]');
    expect(creds.token).toBe('[REDACTED]');
    expect(creds.secret).toBe('[REDACTED]');
    expect(creds.password).toBe('[REDACTED]');
    expect(creds.auth).toBe('[REDACTED]');
    expect(creds.credential).toBe('[REDACTED]');
    expect(creds.accessToken).toBe('[REDACTED]');
    expect(creds.refreshToken).toBe('[REDACTED]');
    expect(creds.apikey).toBe('[REDACTED]');
    expect(creds.clientSecret).toBe('[REDACTED]');
    expect(creds.client_secret).toBe('[REDACTED]');
    expect(creds.privateKey).toBe('[REDACTED]');
    expect(creds.private_key).toBe('[REDACTED]');
    expect(creds.authorization).toBe('[REDACTED]');
    expect(creds.bearer).toBe('[REDACTED]');
    expect(creds.customField).toBe('visible');
  });
});

describe('Credential secret redaction regression tests', () => {
  it('should redact nested secrets', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    await store.set({
      providerId,
      credentials: {
        config: {
          apiKey: 'nested-secret',
          normal: 'value',
          deeper: {
            secret: 'deep-secret',
          },
        },
      },
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.config.apiKey).toBe('[REDACTED]');
    expect(creds.config.normal).toBe('value');
    expect(creds.config.deeper.secret).toBe('[REDACTED]');
  });

  it('should redact secrets in arrays', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    await store.set({
      providerId,
      credentials: {
        providers: [
          { apiKey: 'key1', name: 'provider1' },
          { token: 'key2', name: 'provider2' },
        ],
      },
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.providers[0].apiKey).toBe('[REDACTED]');
    expect(creds.providers[0].name).toBe('provider1');
    expect(creds.providers[1].token).toBe('[REDACTED]');
    expect(creds.providers[1].name).toBe('provider2');
  });

  it('should handle circular references', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    const circular: any = { apiKey: 'secret', normal: 'value' };
    circular.self = circular;

    await store.set({
      providerId,
      credentials: circular,
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.apiKey).toBe('[REDACTED]');
    expect(creds.normal).toBe('value');
    expect(creds.self).toBe('[CIRCULAR]');
  });

  it('should redact key variants (camelCase, snake_case, etc.)', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    await store.set({
      providerId,
      credentials: {
        apiKey: 'camelCase',
        api_key: 'snake_case',
        accessToken: 'camelCaseToken',
        access_token: 'snakeCaseToken',
        clientSecret: 'camelCaseSecret',
        client_secret: 'snakeCaseSecret',
        APIKEY: 'UPPER',
        ApIKeY: 'MiXeD',
      },
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.apiKey).toBe('[REDACTED]');
    expect(creds.api_key).toBe('[REDACTED]');
    expect(creds.accessToken).toBe('[REDACTED]');
    expect(creds.access_token).toBe('[REDACTED]');
    expect(creds.clientSecret).toBe('[REDACTED]');
    expect(creds.client_secret).toBe('[REDACTED]');
    expect(creds.APIKEY).toBe('[REDACTED]');
    expect(creds.ApIKeY).toBe('[REDACTED]');
  });

  it('should not mutate original credentials object', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    const originalCredentials = {
      apiKey: 'secret123',
      normal: 'value',
      nested: { secret: 'nested-secret' },
    };
    const originalString = JSON.stringify(originalCredentials);

    await store.set({
      providerId,
      credentials: originalCredentials,
    });

    // Get redacted version
    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    // Original should not be mutated
    expect(JSON.stringify(originalCredentials)).toBe(originalString);

    // Underlying store should still have original values
    const direct = await delegate.get(providerId);
    expect(direct!.credentials.apiKey).toBe('secret123');
    expect(direct!.credentials.nested.secret).toBe('nested-secret');
  });

  it('should preserve non-secret keys in redacted output', async () => {
    const logger = createLogger({
      name: 'test',
      version: '1.0.0',
      logLevel: 'error',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      enableTelemetry: false,
    });
    const delegate = new InMemoryCredentialStore({ logger });
    const store = new SecretCredentialStore(delegate, logger);

    const providerId = createProviderId('test');
    await store.set({
      providerId,
      credentials: {
        apiKey: 'secret',
        userId: 'user-123',
        timestamp: 1234567890,
        region: 'us-east-1',
        endpoint: 'https://api.example.com',
      },
    });

    const retrieved = await store.getRedacted(providerId);
    expect(retrieved).toBeDefined();

    const creds = retrieved!.credentials;
    expect(creds.apiKey).toBe('[REDACTED]');
    expect(creds.userId).toBe('user-123');
    expect(creds.timestamp).toBe(1234567890);
    expect(creds.region).toBe('us-east-1');
    expect(creds.endpoint).toBe('https://api.example.com');
  });
});
