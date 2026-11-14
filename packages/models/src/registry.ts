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

  register(provider: ModelProvider): void {
    const providerId = provider.metadata.id;
    if (this.providers.has(providerId)) {
      throw createEngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Provider with ID '${providerId}' is already registered`
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

  unregister(providerId: ProviderId): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return false;
    }

    this.removeModelsFromIndex(provider);
    const deleted = this.providers.delete(providerId);
    // Best-effort disposal; do not block unregistration on provider cleanup.
    void provider.dispose().catch(() => {
      // Swallow disposal errors to avoid unhandled rejections.
    });
    return deleted;
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
