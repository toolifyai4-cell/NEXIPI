import type { ProviderId, ProviderCredentials, CredentialStore } from './types.js';
import { createLogger, type Logger } from '@nexipi/core';

export interface InMemoryCredentialStoreOptions {
  logger?: Logger;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials: Map<ProviderId, ProviderCredentials> = new Map();
  private readonly logger: Logger;

  constructor(options: InMemoryCredentialStoreOptions = {}) {
    this.logger = options.logger ?? createNoopLogger();
  }

  async get(providerId: ProviderId): Promise<ProviderCredentials | undefined> {
    const creds = this.credentials.get(providerId);
    if (creds) {
      this.logger.debug('Retrieved credentials', { providerId });
    } else {
      this.logger.debug('Credentials not found', { providerId });
    }
    return creds;
  }

  async set(credentials: ProviderCredentials): Promise<void> {
    this.credentials.set(credentials.providerId, credentials);
    this.logger.info('Stored credentials', { providerId: credentials.providerId });
  }

  async delete(providerId: ProviderId): Promise<boolean> {
    const existed = this.credentials.has(providerId);
    if (existed) {
      this.credentials.delete(providerId);
      this.logger.info('Deleted credentials', { providerId });
    } else {
      this.logger.debug('Credentials not found for deletion', { providerId });
    }
    return existed;
  }

  async list(): Promise<ProviderId[]> {
    return Array.from(this.credentials.keys());
  }

  clear(): void {
    this.credentials.clear();
    this.logger.info('Cleared all credentials');
  }
}

export class SecretCredentialStore implements CredentialStore {
  private readonly delegate: CredentialStore;
  private readonly logger: Logger;
  private readonly secretKeys: Set<string> = new Set([
    'apiKey',
    'api_key',
    'token',
    'secret',
    'password',
    'auth',
    'credential',
    'accessToken',
    'refreshToken',
    'apikey',
    'clientSecret',
    'client_secret',
    'privateKey',
    'private_key',
    'authorization',
    'bearer',
    'api_key',
    'access_token',
    'refresh_token',
    'client_secret',
    'private_key',
  ]);

  constructor(delegate: CredentialStore, logger?: Logger) {
    this.delegate = delegate;
    this.logger = logger ?? createNoopLogger();
  }

  async get(providerId: ProviderId): Promise<ProviderCredentials | undefined> {
    const creds = await this.delegate.get(providerId);
    if (creds) {
      return { ...creds, credentials: this.redactSecrets(creds.credentials) };
    }
    return undefined;
  }

  async set(credentials: ProviderCredentials): Promise<void> {
    await this.delegate.set(credentials);
  }

  async delete(providerId: ProviderId): Promise<boolean> {
    return await this.delegate.delete(providerId);
  }

  async list(): Promise<ProviderId[]> {
    return await this.delegate.list();
  }

  private redactSecrets(credentials: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (this.isSecretKey(key)) {
        redacted[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redactSecrets(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        redacted[key] = value.map((v) =>
          v && typeof v === 'object' ? this.redactSecrets(v as Record<string, unknown>) : v
        );
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private isSecretKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return this.secretKeys.has(lowerKey) || this.secretKeys.has(key);
  }
}

export function createCredentialStore(
  delegate?: CredentialStore,
  logger?: Logger
): CredentialStore {
  const store = delegate ?? new InMemoryCredentialStore({ logger });
  return new SecretCredentialStore(store, logger);
}

function createNoopLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export interface CredentialManagerOptions {
  store?: CredentialStore;
  logger?: Logger;
}

export class CredentialManager {
  private readonly store: CredentialStore;
  private readonly logger: Logger;

  constructor(options: CredentialManagerOptions = {}) {
    this.store = options.store ?? createCredentialStore(undefined, options.logger);
    this.logger = options.logger ?? createNoopLogger();
  }

  async getCredentials(providerId: ProviderId): Promise<ProviderCredentials | undefined> {
    return await this.store.get(providerId);
  }

  async setCredentials(credentials: ProviderCredentials): Promise<void> {
    await this.store.set(credentials);
  }

  async deleteCredentials(providerId: ProviderId): Promise<boolean> {
    return await this.store.delete(providerId);
  }

  async listProviders(): Promise<ProviderId[]> {
    return await this.store.list();
  }

  getStore(): CredentialStore {
    return this.store;
  }
}

export function createCredentialManager(
  options: CredentialManagerOptions = {}
): CredentialManager {
  return new CredentialManager(options);
}