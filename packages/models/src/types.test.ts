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
  type ModelToolCall,
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
  ModelToolCallSchema,
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
          { id: 'call_1', name: 'test', arguments: {} },
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

  describe('ModelToolCallSchema', () => {
    it('should validate a valid model tool call', () => {
      const toolCall: ModelToolCall = {
        id: 'call_123',
        name: 'read_file',
        arguments: { path: '/workspace/file.txt' },
      };

      const result = ModelToolCallSchema.safeParse(toolCall);
      expect(result.success).toBe(true);
    });

    it('should require id', () => {
      const result = ModelToolCallSchema.safeParse({
        name: 'read_file',
        arguments: { path: '/workspace/file.txt' },
      });
      expect(result.success).toBe(false);
    });

    it('should require name', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        arguments: { path: '/workspace/file.txt' },
      });
      expect(result.success).toBe(false);
    });

    it('should require arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
      });
      expect(result.success).toBe(false);
    });

    it('should reject function in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
        arguments: { fn: () => {} },
      });
      expect(result.success).toBe(false);
    });

    it('should reject undefined in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
        arguments: { value: undefined },
      });
      expect(result.success).toBe(false);
    });

    it('should reject symbol in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
        arguments: { sym: Symbol('test') },
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-finite numbers in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
        arguments: { value: Infinity },
      });
      expect(result.success).toBe(false);

      const result2 = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'read_file',
        arguments: { value: NaN },
      });
      expect(result2.success).toBe(false);
    });

    it('should accept nested JSON values', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'search_code',
        arguments: {
          query: 'function',
          options: {
            languages: ['typescript', 'javascript'],
            maxResults: 10,
            filters: { path: { include: ['src/**'] } },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('should accept arrays in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'batch_read',
        arguments: { paths: ['/a.txt', '/b.txt', '/c.txt'] },
      });
      expect(result.success).toBe(true);
    });

    it('should accept null in arguments', () => {
      const result = ModelToolCallSchema.safeParse({
        id: 'call_123',
        name: 'optional_tool',
        arguments: { optionalParam: null },
      });
      expect(result.success).toBe(true);
    });

    it('should be JSON-serializable', () => {
      const toolCall: ModelToolCall = {
        id: 'call_123',
        name: 'read_file',
        arguments: { path: '/workspace/file.txt' },
      };
      const serialized = JSON.stringify(toolCall);
      const parsed = JSON.parse(serialized);
      expect(parsed).toEqual(toolCall);
    });
  });

  describe('ModelRequest with tools', () => {
    it('should validate request with tools array', () => {
      const request: ModelRequest = {
        model: createModelId('gpt-4'),
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Read a file' },
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file from the workspace',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      };

      const result = ModelRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate request with multiple tools', () => {
      const request: ModelRequest = {
        model: createModelId('gpt-4'),
        messages: [{ role: 'user', content: 'Do something' }],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
          {
            name: 'write_file',
            description: 'Write a file',
            parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
          },
          {
            name: 'list_directory',
            description: 'List a directory',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      };

      const result = ModelRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate request without tools (backward compatibility)', () => {
      const request: ModelRequest = {
        model: createModelId('gpt-4'),
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = ModelRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate request with empty tools array', () => {
      const request: ModelRequest = {
        model: createModelId('gpt-4'),
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      };

      const result = ModelRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should reject invalid tool definition in tools array', () => {
      const result = ModelRequestSchema.safeParse({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: '',
            description: 'Invalid tool',
            parameters: {},
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should reject tool definition with function in parameters', () => {
      const result = ModelRequestSchema.safeParse({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: 'invalid_tool',
            description: 'Tool with function',
            parameters: { fn: () => {} },
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ModelMessage with toolCalls', () => {
    it('should validate assistant message with structured tool calls', () => {
      const message: ModelMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'read_file',
            arguments: { path: '/workspace/file.txt' },
          },
          {
            id: 'call_2',
            name: 'write_file',
            arguments: { path: '/workspace/out.txt', content: 'Hello' },
          },
        ],
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate assistant message with text content and tool calls', () => {
      const message: ModelMessage = {
        role: 'assistant',
        content: 'I will read the file for you.',
        toolCalls: [
          {
            id: 'call_1',
            name: 'read_file',
            arguments: { path: '/workspace/file.txt' },
          },
        ],
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate tool message with toolCallId', () => {
      const message: ModelMessage = {
        role: 'tool',
        content: 'File contents here',
        toolCallId: 'call_1',
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject toolCalls with invalid structure', () => {
      const result = ModelMessageSchema.safeParse({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: '', arguments: {} },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should reject toolCalls with function in arguments', () => {
      const result = ModelMessageSchema.safeParse({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'test', arguments: { fn: () => {} } },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should preserve tool call order', () => {
      const message: ModelMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'first_tool', arguments: { step: 1 } },
          { id: 'call_2', name: 'second_tool', arguments: { step: 2 } },
          { id: 'call_3', name: 'third_tool', arguments: { step: 3 } },
        ],
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.toolCalls).toHaveLength(3);
        expect(result.data.toolCalls?.[0].name).toBe('first_tool');
        expect(result.data.toolCalls?.[1].name).toBe('second_tool');
        expect(result.data.toolCalls?.[2].name).toBe('third_tool');
      }
    });

    it('should allow empty toolCalls array', () => {
      const message: ModelMessage = {
        role: 'assistant',
        content: 'No tools needed',
        toolCalls: [],
      };

      const result = ModelMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });
  });

  describe('ModelResponse with tool_calls finishReason', () => {
    it('should validate response with tool_calls finishReason', () => {
      const response: ModelResponse = {
        id: 'chatcmpl-123',
        model: createModelId('gpt-4'),
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call_1', name: 'read_file', arguments: { path: '/workspace/file.txt' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      };

      const result = ModelResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('should validate response with multiple choices containing tool calls', () => {
      const response: ModelResponse = {
        id: 'chatcmpl-123',
        model: createModelId('gpt-4'),
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', name: 'tool_a', arguments: {} }],
            },
            finishReason: 'tool_calls',
          },
          {
            index: 1,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_2', name: 'tool_b', arguments: {} }],
            },
            finishReason: 'tool_calls',
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      };

      const result = ModelResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });
  });
});
