import type {
  ModelProvider,
  ProviderId,
  ModelId,
  ModelMetadata,
  ValidationResult,
} from './types.js';
import { EngineErrorCode, createEngineError } from '@nexipi/core';

type DisposalState = 'pending' | 'fulfilled' | 'rejected';

interface DisposalEntry {
  promise: Promise<void>;
  state: DisposalState;
}

export class ProviderRegistry {
  private readonly providers: Map<ProviderId, ModelProvider> = new Map();
  private readonly modelIndex: Map<string, ModelMetadata> = new Map();
  // Tracks providers whose disposal is currently in progress or has completed.
  // The entry persists after settlement to preserve the disposal outcome
  // (success or failure) for subsequent unregister calls.
  private readonly disposing: Map<ProviderId, DisposalEntry> = new Map();

  register(provider: ModelProvider): void {
    const providerId = provider.metadata.id;
    if (this.providers.has(providerId)) {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' is already registered`
      );
    }
    const disposalEntry = this.disposing.get(providerId);
    if (disposalEntry && disposalEntry.state === 'pending') {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' is currently being disposed`
      );
    }
    if (disposalEntry && disposalEntry.state === 'rejected') {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' has failed disposal; cannot re-register`
      );
    }
    // If disposalEntry.state === 'fulfilled', allow re-registration (clean up entry)
    if (disposalEntry && disposalEntry.state === 'fulfilled') {
      this.disposing.delete(providerId);
    }

    // Validate model uniqueness before mutating any state so a failed
    // registration cannot leave the registry partially populated.
    const seen = new Set<string>();
    for (const model of provider.listModels()) {
      const key = `${providerId}:${model.modelId}`;
      if (seen.has(key) || this.modelIndex.has(key)) {
        throw createEngineError(
          EngineErrorCode.INVALID_CONFIGURATION,
          `Duplicate model ID '${model.modelId}' for provider '${providerId}'`
        );
      }
      seen.add(key);
    }

    this.providers.set(providerId, provider);
    for (const model of provider.listModels()) {
      const key = `${providerId}:${model.modelId}`;
      this.modelIndex.set(key, model);
    }
  }

  /**
   * Unregister a provider and await its disposal.
   *
   * The provider is removed from the registry before disposal begins, so it
   * can no longer be retrieved while disposal is in progress. Disposal errors
   * are propagated to the caller instead of being swallowed. Repeated calls
   * while disposal is in progress await the same disposal and return false.
   * After successful disposal, subsequent calls return false and allow re-registration.
   * After failed disposal, subsequent calls return false and block re-registration
   * until the registry is explicitly cleared (not supported) or process restarts.
   */
  async unregister(providerId: ProviderId): Promise<boolean> {
    const entry = this.disposing.get(providerId);
    const provider = this.providers.get(providerId);

    if (!provider) {
      if (entry) {
        // Disposal in progress or completed (success or failure) - await it
        try {
          await entry.promise;
        } catch {
          // Swallow error for callers that didn't initiate disposal;
          // the original caller received the error.
        }
        return false;
      }
      // Provider never registered or already fully unregistered
      return false;
    }

    this.removeModelsFromIndex(provider);
    this.providers.delete(providerId);

    const disposalEntry: DisposalEntry = { promise: Promise.resolve(), state: 'pending' };
    const disposal = (async () => {
      await provider.dispose();
    })();

    disposalEntry.promise = disposal.then(
      () => {
        disposalEntry.state = 'fulfilled';
      },
      error => {
        disposalEntry.state = 'rejected';
        throw error;
      }
    );

    this.disposing.set(providerId, disposalEntry);

    await disposalEntry.promise;
    return true;
  }

  get(providerId: ProviderId): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): readonly ModelProvider[] {
    return Array.from(this.providers.values());
  }

  has(providerId: ProviderId): boolean {
    return this.providers.has(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ModelMetadata | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return undefined;
    }

    const key = `${providerId}:${modelId}`;
    return this.modelIndex.get(key);
  }

  listModels(providerId?: ProviderId): readonly ModelMetadata[] {
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        return [];
      }
      return provider.listModels();
    }

    const allModels: ModelMetadata[] = [];
    for (const provider of this.providers.values()) {
      allModels.push(...provider.listModels());
    }
    return allModels;
  }

  async validateProvider(providerId: ProviderId): Promise<ValidationResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        valid: false,
        errors: [
          {
            code: 'PROVIDER_NOT_FOUND',
            message: `Provider '${providerId}' is not registered`,
          },
        ],
      };
    }

    try {
      await provider.healthCheck();
      return { valid: true, errors: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [
          {
            code: 'HEALTH_CHECK_FAILED',
            message: `Provider health check failed: ${message}`,
          },
        ],
      };
    }
  }

  private removeModelsFromIndex(provider: ModelProvider): void {
    const providerId = provider.metadata.id;
    for (const model of provider.listModels()) {
      const key = `${providerId}:${model.modelId}`;
      this.modelIndex.delete(key);
    }
  }
}

export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}
