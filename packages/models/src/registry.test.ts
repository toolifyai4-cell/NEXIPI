import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderRegistry, createProviderRegistry } from './registry.js';
import {
  createProviderId,
  createModelId,
  type ModelProvider,
  type ModelMetadata,
  type ProviderMetadata,
  type ProviderHealth,
  type ModelRequest,
  type ModelResponse,
  type ProviderCredentials,
  type ValidationResult,
} from './types.js';
import { EngineErrorCode, isEngineError } from '@nexipi/core';

function createMockProvider(
  overrides: Partial<{
    metadata: ProviderMetadata;
    models: ModelMetadata[];
    health: ProviderHealth;
    validateResult: ValidationResult;
    executeResult: ModelResponse;
    healthCheck: ReturnType<typeof vi.fn>;
  }> = {}
): ModelProvider {
  const providerId = overrides.metadata?.id ?? createProviderId('test-provider');
  const modelId = createModelId('test-model');

  const defaultModel: ModelMetadata = {
    providerId,
    modelId,
    displayName: 'Test Model',
    contextWindow: 4096,
    capabilities: {
      streaming: false,
      toolCalling: false,
      vision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
  };

  const defaultModels = overrides.models ?? [defaultModel];

  return {
    metadata: overrides.metadata ?? {
      id: providerId,
      name: 'Test Provider',
      version: '1.0.0',
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockReturnValue(defaultModels),
    getModel: vi.fn().mockImplementation((id: string) => defaultModels.find(m => m.modelId === id)),
    validateRequest: vi
      .fn()
      .mockResolvedValue(overrides.validateResult ?? { valid: true, errors: [] }),
    execute: vi.fn().mockResolvedValue(
      overrides.executeResult ?? {
        id: 'resp-1',
        model: modelId,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello' }, finishReason: 'stop' },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      }
    ),
    healthCheck:
      overrides.healthCheck ??
      vi.fn().mockResolvedValue(
        overrides.health ?? {
          status: 'healthy',
          lastChecked: Date.now(),
          latencyMs: 100,
        }
      ),
  };
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = createProviderRegistry();
  });

  describe('register', () => {
    it('should register a provider', () => {
      const provider = createMockProvider();
      registry.register(provider);

      expect(registry.has(provider.metadata.id)).toBe(true);
      expect(registry.get(provider.metadata.id)).toBe(provider);
    });

    it('should throw on duplicate provider ID', () => {
      const provider1 = createMockProvider();
      const provider2 = createMockProvider();

      registry.register(provider1);
      expect(() => registry.register(provider2)).toThrow();
    });

    it('should throw EngineError with correct code for duplicate', () => {
      const provider1 = createMockProvider();
      const provider2 = createMockProvider();

      registry.register(provider1);
      try {
        registry.register(provider2);
      } catch (error) {
        expect(isEngineError(error)).toBe(true);
        if (isEngineError(error)) {
          expect(error.code).toBe(EngineErrorCode.INVALID_CONFIGURATION);
          expect(error.message).toContain('already registered');
        }
      }
    });

    it('should index models from provider', () => {
      const modelId = createModelId('test-model');
      const provider = createMockProvider();
      registry.register(provider);

      const model = registry.getModel(provider.metadata.id, modelId);
      expect(model).toBeDefined();
      expect(model?.modelId).toBe(modelId);
    });

    it('should not corrupt registry when model indexing fails', () => {
      const providerId = createProviderId('dup-model-provider');
      const modelId = createModelId('dup-model');
      const provider = createMockProvider({
        metadata: { id: providerId, name: 'Dup Provider', version: '1.0.0' },
        models: [
          {
            providerId,
            modelId,
            displayName: 'Model 1',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
          {
            providerId,
            modelId,
            displayName: 'Model 2',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
        ],
      });

      expect(() => registry.register(provider)).toThrow();
      expect(registry.has(providerId)).toBe(false);
      expect(registry.getModel(providerId, modelId)).toBeUndefined();
    });
  });

  describe('unregister', () => {
    it('should unregister existing provider', async () => {
      const provider = createMockProvider();
      registry.register(provider);

      const result = await registry.unregister(provider.metadata.id);
      expect(result).toBe(true);
      expect(registry.has(provider.metadata.id)).toBe(false);
    });

    it('should return false for non-existent provider', async () => {
      const result = await registry.unregister(createProviderId('non-existent'));
      expect(result).toBe(false);
    });

    it('should remove models from index', async () => {
      const provider = createMockProvider();
      const modelId = createModelId('test-model');
      registry.register(provider);

      expect(registry.getModel(provider.metadata.id, modelId)).toBeDefined();

      await registry.unregister(provider.metadata.id);
      expect(registry.getModel(provider.metadata.id, modelId)).toBeUndefined();
    });
  });

  describe('unregister disposal contract', () => {
    it('should await provider disposal', async () => {
      const dispose = vi
        .fn()
        .mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
      const provider = createMockProvider();
      provider.dispose = dispose;
      registry.register(provider);

      await registry.unregister(provider.metadata.id);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('should propagate disposal failures', async () => {
      const provider = createMockProvider();
      provider.dispose = vi.fn().mockRejectedValue(new Error('boom'));
      registry.register(provider);

      await expect(registry.unregister(provider.metadata.id)).rejects.toThrow('boom');
    });

    it('should not retrieve provider during disposal', async () => {
      let resolveDispose!: () => void;
      const disposePromise = new Promise<void>(resolve => {
        resolveDispose = resolve;
      });
      const provider = createMockProvider();
      provider.dispose = vi.fn().mockReturnValue(disposePromise);
      registry.register(provider);

      const unregisterPromise = registry.unregister(provider.metadata.id);
      expect(registry.get(provider.metadata.id)).toBeUndefined();
      expect(registry.has(provider.metadata.id)).toBe(false);

      resolveDispose();
      await unregisterPromise;
    });

    it('should block re-registration while disposal is in progress', async () => {
      let resolveDispose!: () => void;
      const disposePromise = new Promise<void>(resolve => {
        resolveDispose = resolve;
      });
      const provider = createMockProvider();
      provider.dispose = vi.fn().mockReturnValue(disposePromise);
      registry.register(provider);

      const unregisterPromise = registry.unregister(provider.metadata.id);
      const newProvider = createMockProvider({
        metadata: { id: provider.metadata.id, name: 'New', version: '1.0.0' },
      });

      expect(() => registry.register(newProvider)).toThrow();

      resolveDispose();
      await unregisterPromise;

      // After disposal completes, registration is allowed again.
      registry.register(newProvider);
      expect(registry.has(provider.metadata.id)).toBe(true);
    });

    it('should not dispose twice on repeated unregister', async () => {
      const provider = createMockProvider();
      registry.register(provider);

      const first = registry.unregister(provider.metadata.id);
      const second = registry.unregister(provider.metadata.id);

      await first;
      const secondResult = await second;
      expect(secondResult).toBe(false);
      expect(provider.dispose).toHaveBeenCalledTimes(1);
    });

    it('should report unregister result for unknown provider', async () => {
      const result = await registry.unregister(createProviderId('missing'));
      expect(result).toBe(false);
    });
  });
  describe('get', () => {
    it('should return provider by ID', () => {
      const provider = createMockProvider();
      registry.register(provider);

      const found = registry.get(provider.metadata.id);
      expect(found).toBe(provider);
    });

    it('should return undefined for non-existent provider', () => {
      const found = registry.get(createProviderId('non-existent'));
      expect(found).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should return empty array initially', () => {
      expect(registry.list()).toHaveLength(0);
    });

    it('should return all registered providers', () => {
      const provider1 = createMockProvider({
        metadata: { id: createProviderId('provider-1'), name: 'Provider 1', version: '1.0.0' },
      });
      const provider2 = createMockProvider({
        metadata: { id: createProviderId('provider-2'), name: 'Provider 2', version: '1.0.0' },
      });

      registry.register(provider1);
      registry.register(provider2);

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(provider1);
      expect(list).toContain(provider2);
    });
  });

  describe('has', () => {
    it('should return true for registered provider', () => {
      const provider = createMockProvider();
      registry.register(provider);
      expect(registry.has(provider.metadata.id)).toBe(true);
    });

    it('should return false for non-registered provider', () => {
      expect(registry.has(createProviderId('non-existent'))).toBe(false);
    });
  });

  describe('getModel', () => {
    it('should return model by provider and model ID', () => {
      const provider = createMockProvider();
      const modelId = createModelId('test-model');
      registry.register(provider);

      const model = registry.getModel(provider.metadata.id, modelId);
      expect(model).toBeDefined();
      expect(model?.modelId).toBe(modelId);
    });

    it('should return undefined for non-existent provider', () => {
      const model = registry.getModel(createProviderId('non-existent'), createModelId('model'));
      expect(model).toBeUndefined();
    });

    it('should return undefined for non-existent model', () => {
      const provider = createMockProvider();
      registry.register(provider);

      const model = registry.getModel(provider.metadata.id, createModelId('non-existent'));
      expect(model).toBeUndefined();
    });
  });

  describe('listModels', () => {
    it('should return all models when no provider specified', () => {
      const provider1 = createMockProvider({
        metadata: { id: createProviderId('p1'), name: 'P1', version: '1.0.0' },
        models: [
          {
            providerId: createProviderId('p1'),
            modelId: createModelId('m1'),
            displayName: 'M1',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
          {
            providerId: createProviderId('p1'),
            modelId: createModelId('m2'),
            displayName: 'M2',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
        ],
      });
      const provider2 = createMockProvider({
        metadata: { id: createProviderId('p2'), name: 'P2', version: '1.0.0' },
        models: [
          {
            providerId: createProviderId('p2'),
            modelId: createModelId('m3'),
            displayName: 'M3',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
        ],
      });

      registry.register(provider1);
      registry.register(provider2);

      const models = registry.listModels();
      expect(models).toHaveLength(3);
    });

    it('should return models for specific provider', () => {
      const provider = createMockProvider({
        models: [
          {
            providerId: createProviderId('p1'),
            modelId: createModelId('m1'),
            displayName: 'M1',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
          {
            providerId: createProviderId('p1'),
            modelId: createModelId('m2'),
            displayName: 'M2',
            contextWindow: 100,
            capabilities: {
              streaming: false,
              toolCalling: false,
              vision: false,
              inputModalities: ['text'],
              outputModalities: ['text'],
            },
          },
        ],
      });

      registry.register(provider);

      const models = registry.listModels(provider.metadata.id);
      expect(models).toHaveLength(2);
    });

    it('should return empty array for non-existent provider', () => {
      const models = registry.listModels(createProviderId('non-existent'));
      expect(models).toHaveLength(0);
    });
  });

  describe('validateProvider', () => {
    it('should return valid for healthy provider', async () => {
      const provider = createMockProvider({
        health: { status: 'healthy', lastChecked: Date.now(), latencyMs: 50 },
      });
      registry.register(provider);

      const result = await registry.validateProvider(provider.metadata.id);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for non-existent provider', async () => {
      const result = await registry.validateProvider(createProviderId('non-existent'));
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('PROVIDER_NOT_FOUND');
    });

    it('should return invalid when health check fails', async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn().mockRejectedValue(new Error('Connection failed')),
      });
      registry.register(provider);

      const result = await registry.validateProvider(provider.metadata.id);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('HEALTH_CHECK_FAILED');
    });
  });

  describe('concurrent operations', () => {
    it('should handle concurrent register and unregister', async () => {
      const providers = Array.from({ length: 10 }, (_, i) =>
        createMockProvider({
          metadata: {
            id: createProviderId(`provider-${i}`),
            name: `Provider ${i}`,
            version: '1.0.0',
          },
        })
      );

      await Promise.all(providers.map(p => Promise.resolve(registry.register(p))));

      expect(registry.list()).toHaveLength(10);

      const unregisterResults = await Promise.all(
        providers.map(p => Promise.resolve(registry.unregister(p.metadata.id)))
      );
      expect(unregisterResults.every(r => r === true)).toBe(true);
      expect(registry.list()).toHaveLength(0);
    });

    it('should handle concurrent getModel calls', async () => {
      const provider = createMockProvider();
      registry.register(provider);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          Promise.resolve(registry.getModel(provider.metadata.id, createModelId('test-model')))
        )
      );

      expect(results.every(m => m !== undefined)).toBe(true);
    });
  });
});
