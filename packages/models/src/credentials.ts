import type { ProviderId, ProviderCredentials, CredentialStore } from './types.js';
import type { Logger } from '@nexipi/core';

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

/**
 * A credential store decorator that preserves actual credential values on
 * retrieval.
 *
 * Storage and retrieval return unredacted values so model providers can use
 * credentials. Secret redaction is provided separately for logging and
 * diagnostic output via {@link SecretCredentialStore.redact} (and the logger's
 * own sanitization). This is NOT an OS-backed secure storage implementation and
 * performs no custom encryption; integrate a platform-backed store as the
 * delegate when available.
 */
export class SecretCredentialStore implements CredentialStore {
  private readonly delegate: CredentialStore;
  private readonly logger: Logger;
  private readonly secretKeysArray: string[] = [
    'apikey',
    'api_key',
    'token',
    'secret',
    'password',
    'auth',
    'credential',
    'accesstoken',
    'refreshtoken',
    'clientsecret',
    'client_secret',
    'privatekey',
    'private_key',
    'authorization',
    'bearer',
    'access_token',
    'refresh_token',
  ];

  constructor(delegate: CredentialStore, logger?: Logger) {
    this.delegate = delegate;
    this.logger = logger ?? createNoopLogger();
  }

  async get(providerId: ProviderId): Promise<ProviderCredentials | undefined> {
    // Return actual stored values; redaction is a diagnostic concern.
    return await this.delegate.get(providerId);
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

  /**
   * Return a redacted copy of credentials for logging or diagnostic output.
   */
  redact(credentials: ProviderCredentials): ProviderCredentials {
    return { ...credentials, credentials: this.redactSecrets(credentials.credentials) };
  }

  /**
   * Retrieve a redacted copy of credentials for diagnostic purposes.
   */
  async getRedacted(providerId: ProviderId): Promise<ProviderCredentials | undefined> {
    const creds = await this.delegate.get(providerId);
    if (creds) {
      return this.redact(creds);
    }
    return undefined;
  }

  redactCredentials(credentials: ProviderCredentials): ProviderCredentials {
    return this.redact(credentials);
  }

  redactSecretsValue(credentials: Record<string, unknown>): Record<string, unknown> {
    return this.redactSecrets(credentials);
  }

  private redactSecrets(credentials: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (this.isSecretKey(key)) {
        redacted[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redactSecrets(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        redacted[key] = value.map(v =>
          v && typeof v === 'object'
            ? this.redactSecrets(v as Record<string, unknown>)
            : (v as unknown)
        );
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private isSecretKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    // Match by substring (consistent with core sanitization) so variants such
    // as "myApiKey" or "apiKeyValue" are also redacted.
    return this.secretKeysArray.some(secret => lowerKey.includes(secret));
  }
}

export function createCredentialStore(
  delegate?: CredentialStore,
  logger?: Logger
): CredentialStore {
  const store = delegate ?? new InMemoryCredentialStore(logger ? { logger } : {});
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

export function createCredentialManager(options: CredentialManagerOptions = {}): CredentialManager {
  return new CredentialManager(options);
}
