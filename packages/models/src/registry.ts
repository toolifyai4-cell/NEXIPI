import type {
  ModelProvider,
  ProviderId,
  ModelId,
  ModelMetadata,
  ValidationResult,
} from './types.js';
import { EngineErrorCode, createEngineError } from '@nexipi/core';

export class ProviderRegistry {
  private readonly providers: Map<ProviderId, ModelProvider> = new Map();
  private readonly modelIndex: Map<string, ModelMetadata> = new Map();
  // Tracks providers whose disposal is currently in progress so that
  // registration and repeated unregistration can observe the lifecycle.
  private readonly disposing: Map<ProviderId, Promise<void>> = new Map();

  register(provider: ModelProvider): void {
    const providerId = provider.metadata.id;
    if (this.providers.has(providerId)) {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' is already registered`
      );
    }
    if (this.disposing.has(providerId)) {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' is currently being disposed`
      );
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
   */
  async unregister(providerId: ProviderId): Promise<boolean> {
    const inProgress = this.disposing.get(providerId);
    const provider = this.providers.get(providerId);

    if (!provider) {
      if (inProgress) {
        await inProgress;
        return false;
      }
      return false;
    }

    this.removeModelsFromIndex(provider);
    this.providers.delete(providerId);

    const disposal = (async () => {
      await provider.dispose();
    })();

    const tracked = disposal.finally(() => {
      this.disposing.delete(providerId);
    });
    this.disposing.set(providerId, tracked);

    await tracked;
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
