import { describe, it, expect } from 'vitest';
import {
  createProviderId,
  createModelId,
  type ProviderId,
  type ModelId,
  type Modality,
  type ModelCapabilities,
  type PricingMetadata,
  type ModelMetadata,
  type ProviderMetadata,
  type ProviderHealth,
  type ModelRequest,
  type ModelMessage,
  type GenerationParameters,
  type ModelResponse,
  type ModelChoice,
  type FinishReason,
  type UsageStatistics,
  type ProviderCredentials,
  type ValidationResult,
  type ModelProvider,
  type ProviderRegistry,
  ModelCapabilitiesSchema,
  ModelMetadataSchema,
  ProviderMetadataSchema,
  ProviderHealthSchema,
  GenerationParametersSchema,
  UsageStatisticsSchema,
  ModelMessageSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  FinishReasonSchema,
  PricingMetadataSchema,
} from './types.js';

describe('types', () => {
  describe('createProviderId', () => {
    it('should create a branded provider ID', () => {
      const id = createProviderId('openai');
      expect(id).toBe('openai');
    });
  });

  describe('createModelId', () => {
    it('should create a branded model ID', () => {
      const id = createModelId('gpt-4');
      expect(id).toBe('gpt-4');
    });
  });

  describe('Modality', () => {
    it('should allow valid modalities', () => {
      const modalities: Modality[] = ['text', 'image', 'audio', 'video', 'document'];
      expect(modalities).toHaveLength(5);
    });
  });

  describe('ModelCapabilitiesSchema', () => {
    it('should validate valid capabilities', () => {
      const capabilities: ModelCapabilities = {
        streaming: true,
        toolCalling: true,
        vision: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      };

      const result = ModelCapabilitiesSchema.safeParse(capabilities);
      expect(result.success).toBe(true);
    });

    it('should reject invalid capabilities', () => {
      const result = ModelCapabilitiesSchema.safeParse({
        streaming: 'yes',
        toolCalling: true,
        vision: false,
        inputModalities: ['text'],
        outputModalities: ['text'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('PricingMetadataSchema', () => {
    it('should validate valid pricing', () => {
      const pricing: PricingMetadata = {
        inputPricePerToken: 0.00001,
        outputPricePerToken: 0.00003,
        currency: 'USD',
        pricingUnit: '1k',
      };

      const result = PricingMetadataSchema.safeParse(pricing);
      expect(result.success).toBe(true);
    });

    it('should allow optional fields', () => {
      const result = PricingMetadataSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should reject negative prices', () => {
      const result = PricingMetadataSchema.safeParse({
        inputPricePerToken: -0.001,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ModelMetadataSchema', () => {
    it('should validate valid model metadata', () => {
      const metadata: ModelMetadata = {
        providerId: createProviderId('openai'),
        modelId: createModelId('gpt-4'),
        displayName: 'GPT-4',
        description: 'Advanced language model',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        capabilities: {
          streaming: true,
          toolCalling: true,
          vision: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
        },
        pricing: {
          inputPricePerToken: 0.00001,
          outputPricePerToken: 0.00003,
          currency: 'USD',
          pricingUnit: '1k',
        },
      };

      const result = ModelMetadataSchema.safeParse(metadata);
      expect(result.success).toBe(true);
    });

    it('should require displayName', () => {
      const result = ModelMetadataSchema.safeParse({
        providerId: 'openai',
        modelId: 'gpt-4',
        displayName: '',
        contextWindow: 128000,
        capabilities: {
          streaming: true,
          toolCalling: true,
          vision: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
        },
      });
      expect(result.success).toBe(false);
    });

    it('should require positive contextWindow', () => {
      const result = ModelMetadataSchema.safeParse({
        providerId: 'openai',
        modelId: 'gpt-4',
        displayName: 'GPT-4',
        contextWindow: 0,
        capabilities: {
          streaming: true,
          toolCalling: true,
          vision: false,
          inputModalities: ['text'],
          outputModalities: ['text'],
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProviderMetadataSchema', () => {
    it('should validate valid provider metadata', () => {
      const metadata: ProviderMetadata = {
        id: createProviderId('openai'),
        name: 'OpenAI',
        version: '1.0.0',
        description: 'OpenAI API provider',
        homepage: 'https://openai.com',
      };

      const result = ProviderMetadataSchema.safeParse(metadata);
      expect(result.success).toBe(true);
    });

    it('should reject invalid homepage URL', () => {
      const result = ProviderMetadataSchema.safeParse({
        id: 'openai',
        name: 'OpenAI',
        version: '1.0.0',
        homepage: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ProviderHealthSchema', () => {
    it('should validate valid health status', () => {
      const health: ProviderHealth = {
        status: 'healthy',
        lastChecked: Date.now(),
        latencyMs: 150,
      };

      const result = ProviderHealthSchema.safeParse(health);
      expect(result.success).toBe(true);
    });

    it('should allow degraded and unhealthy statuses', () => {
      const degraded = ProviderHealthSchema.safeParse({
        status: 'degraded',
        lastChecked: Date.now(),
        error: 'High latency',
      });
      expect(degraded.success).toBe(true);

      const unhealthy = ProviderHealthSchema.safeParse({
        status: 'unhealthy',
        lastChecked: Date.now(),
        error: 'Service down',
      });
      expect(unhealthy.success).toBe(true);
    });
  });

  describe('ModelMessageSchema', () => {
    it('should validate system message', () => {
      const message: ModelMessage = {
        role: 'system',
        content: 'You are a helpful assistant',
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate user message with string content', () => {
      const message: ModelMessage = {
        role: 'user',
        content: 'Hello, world!',
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate assistant message with tool calls', () => {
      const message: ModelMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } },
        ],
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate tool message', () => {
      const message: ModelMessage = {
        role: 'tool',
        content: 'Tool result',
        toolCallId: 'call_1',
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });
  });

  describe('GenerationParametersSchema', () => {
    it('should validate valid parameters', () => {
      const params: GenerationParameters = {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1000,
        stopSequences: ['\n\n'],
        responseFormat: 'json',
      };

      const result = GenerationParametersSchema.safeParse(params);
      expect(result.success).toBe(true);
    });

    it('should reject temperature out of range', () => {
      const result = GenerationParametersSchema.safeParse({ temperature: 3 });
      expect(result.success).toBe(false);
    });

    it('should reject topP out of range', () => {
      const result = GenerationParametersSchema.safeParse({ topP: 1.5 });
      expect(result.success).toBe(false);
    });

    it('should reject negative maxTokens', () => {
      const result = GenerationParametersSchema.safeParse({ maxTokens: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('UsageStatisticsSchema', () => {
    it('should validate valid usage', () => {
      const usage: UsageStatistics = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 10,
      };

      const result = UsageStatisticsSchema.safeParse(usage);
      expect(result.success).toBe(true);
    });

    it('should reject negative tokens', () => {
      const result = UsageStatisticsSchema.safeParse({
        promptTokens: -1,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FinishReasonSchema', () => {
    it('should allow all valid finish reasons', () => {
      const reasons: FinishReason[] = [
        'stop',
        'length',
        'tool_calls',
        'content_filter',
        'error',
        'other',
      ];

      for (const reason of reasons) {
        const result = FinishReasonSchema.safeParse(reason);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid finish reason', () => {
      const result = FinishReasonSchema.safeParse('invalid');
      expect(result.success).toBe(false);
    });
  });

  describe('ModelRequestSchema', () => {
    it('should validate valid request', () => {
      const request: ModelRequest = {
        model: createModelId('gpt-4'),
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
        parameters: { temperature: 0.7 },
      };

      const result = ModelRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should require model', () => {
      const result = ModelRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(result.success).toBe(false);
    });

    it('should require messages', () => {
      const result = ModelRequestSchema.safeParse({
        model: 'gpt-4',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ModelResponseSchema', () => {
    it('should validate valid response', () => {
      const response: ModelResponse = {
        id: 'chatcmpl-123',
        model: createModelId('gpt-4'),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finishReason: 'stop',
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      };

      const result = ModelResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('should require choices array', () => {
      const result = ModelResponseSchema.safeParse({
        id: 'chatcmpl-123',
        model: 'gpt-4',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ValidationResult', () => {
    it('should allow valid result with no errors', () => {
      const result: ValidationResult = { valid: true, errors: [] };
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should allow errors array', () => {
      const result: ValidationResult = {
        valid: false,
        errors: [{ code: 'INVALID_MODEL', message: 'Model not supported' }],
      };
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it('should allow warnings', () => {
      const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [{ code: 'DEPRECATED', message: 'Model will be deprecated' }],
      };
      expect(result.warnings).toHaveLength(1);
    });
  });
});