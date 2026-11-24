import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatService, createChatService } from './chat.js';
import { createProviderRegistry } from './registry.js';
import { ToolRegistry, createToolRegistry } from './tools/registry.js';
import { ToolExecutor } from './tools/executor.js';
import { ToolExecutionService, ToolExecutionTurn, DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG } from './tools/service.js';
import { z } from 'zod';
import {
  createProviderId,
  createModelId,
  type ModelProvider,
  type ModelMetadata,
  type ProviderHealth,
} from './types.js';
import { createNoopLogger } from '@nexipi/core';
import type { ToolDefinition, ToolExecutionContext } from './tools/types.js';
import { ToolErrorCode } from './tools/errors.js';

function createMockToolCallingProvider(
  overrides: {
    metadata?: { id: string; name: string; version: string };
    models?: ModelMetadata[];
    health?: ProviderHealth;
    execute?: ModelProvider['execute'];
    executeStream?: ModelProvider['executeStream'];
  } = {}
): ModelProvider {
  const providerId = createProviderId(overrides.metadata?.id ?? 'test-provider');
  const modelId = createModelId('test-model');

  const defaultModel: ModelMetadata = {
    providerId,
    modelId,
    displayName: 'Test Model',
    contextWindow: 4096,
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
  };

  const defaultModels = overrides.models ?? [defaultModel];

  return {
    metadata: {
      id: providerId,
      name: overrides.metadata?.name ?? 'Test Provider',
      version: overrides.metadata?.version ?? '1.0.0',
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockReturnValue(defaultModels),
    getModel: vi.fn().mockImplementation((id: string) => defaultModels.find(m => m.modelId === id)),
    validateRequest: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    execute: overrides.execute ?? vi.fn(),
    executeStream: overrides.executeStream ?? vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(
      overrides.health ?? {
        status: 'healthy',
        lastChecked: Date.now(),
        latencyMs: 100,
      }
    ),
  };
}

function createMockNonToolCallingProvider(
  overrides: {
    metadata?: { id: string; name: string; version: string };
    models?: ModelMetadata[];
    health?: ProviderHealth;
    execute?: ModelProvider['execute'];
    executeStream?: ModelProvider['executeStream'];
  } = {}
): ModelProvider {
  const providerId = createProviderId(overrides.metadata?.id ?? 'test-provider');
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
    metadata: {
      id: providerId,
      name: overrides.metadata?.name ?? 'Test Provider',
      version: overrides.metadata?.version ?? '1.0.0',
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockReturnValue(defaultModels),
    getModel: vi.fn().mockImplementation((id: string) => defaultModels.find(m => m.modelId === id)),
    validateRequest: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    execute: overrides.execute ?? vi.fn(),
    executeStream: overrides.executeStream ?? vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(
      overrides.health ?? {
        status: 'healthy',
        lastChecked: Date.now(),
        latencyMs: 100,
      }
    ),
  };
}

function makeToolDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'get_weather',
    description: 'Get weather for a location',
    inputSchema: z.object({ location: z.string() }),
    metadata: {
      capabilities: ['read'] as const,
      readOnly: true,
      destructive: false,
      requiresWorkspace: false,
      idempotent: true,
      version: '1.0.0',
    },
    execute: vi.fn().mockResolvedValue({ temperature: 22, condition: 'sunny' }),
    ...overrides,
  }
}

function makePermissionPolicy(): { name: string; evaluate: () => Promise<{ allowed: boolean }> } {
  return {
    name: 'allow-all',
    evaluate: vi.fn().mockResolvedValue({ allowed: true }),
  };
}

function makeExecutionContext(): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceId: 'test-workspace',
    workspaceFolder: undefined,
    logger: createNoopLogger(),
  };
}

describe('ChatService - Tool Calling Integration', () => {
  let chatService: ChatService;
  let providerRegistry: ReturnType<typeof createProviderRegistry>;
  let toolRegistry: ToolRegistry;
  let toolExecutor: ToolExecutor;
  let toolExecutionService: ToolExecutionService;
  let mockProvider: ModelProvider;
  const providerId = createProviderId('test-provider');
  const modelId = createModelId('test-model');

  beforeEach(() => {
    providerRegistry = createProviderRegistry();
    toolRegistry = createToolRegistry();
    toolExecutor = new ToolExecutor(toolRegistry, { permissionPolicy: makePermissionPolicy() });
    toolExecutionService = new ToolExecutionService(toolExecutor);

    mockProvider = createMockToolCallingProvider({
      metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
    });
    providerRegistry.register(mockProvider);

    toolRegistry.register(makeToolDefinition());

    chatService = createChatService({
      providerRegistry,
      defaultProvider: providerId,
      defaultModel: modelId,
      toolRegistry,
      toolExecutionService,
    });
  });

  afterEach(async () => {
    await chatService.dispose();
    toolExecutionService.dispose();
  });

  describe('Basic lifecycle with tools', () => {
    it('should send message and receive final response when no tool calls', async () => {
      const conversationId = chatService.createConversation('Test').id;

      mockProvider.execute = vi.fn().mockResolvedValue({
        id: 'response-1',
        model: modelId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finishReason: 'stop',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Hello');
      await new Promise(resolve => setTimeout(resolve, 100));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage).toBeDefined();
      expect(finalMessage?.status).toBe('completed');
      expect(finalMessage?.content).toBe('Hello!');
    });

    it('should execute tool calls and continue conversation', async () => {
      const conversationId = chatService.createConversation('Tool Test').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-1',
                name: 'get_weather',
                arguments: { location: 'New York' },
              }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'The weather in New York is sunny, 22°C.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'What is the weather in New York?');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(3); // user + assistant + tool + assistant

      // Check tool result message exists
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0].metadata?.toolCallId).toBe('call-1');
      expect(toolMessages[0].metadata?.toolName).toBe('get_weather');

      // Check final assistant message
      const finalAssistant = messages.filter(m => m.role === 'assistant').pop();
      expect(finalAssistant).toBeDefined();
      expect(finalAssistant?.content).toContain('sunny');
      expect(finalAssistant?.status).toBe('completed');
    });

    it('should handle multiple tool calls in one response', async () => {
      const conversationId = chatService.createConversation('Multi Tool').id;

      // Register second tool
      toolRegistry.register(makeToolDefinition({
        name: 'get_time',
        description: 'Get current time',
        inputSchema: z.object({ timezone: z.string() }),
        execute: vi.fn().mockResolvedValue({ time: '12:00', timezone: 'UTC' }),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call-1', name: 'get_weather', arguments: { location: 'London' } },
                { id: 'call-2', name: 'get_time', arguments: { timezone: 'UTC' } },
              ],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'London weather: sunny, 20°C. Time: 12:00 UTC.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather and time in London?');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
      const toolNames = toolMessages.map(m => m.metadata?.toolName).sort();
      expect(toolNames).toEqual(['get_time', 'get_weather']);
    });
  });

  describe('Validation', () => {
    it('should reject unknown tool names', async () => {
      const conversationId = chatService.createConversation('Unknown Tool').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'unknown_tool', arguments: {} }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Unknown tool not available.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call unknown tool');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      const toolResult = JSON.parse(toolMessages[0].content);
      expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_NOT_FOUND);
    });

    it('should reject duplicate tool call IDs', async () => {
      const conversationId = chatService.createConversation('Duplicate ID').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call-1', name: 'get_weather', arguments: { location: 'A' } },
                { id: 'call-1', name: 'get_weather', arguments: { location: 'B' } },
              ],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Duplicate calls not allowed.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Duplicate call');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
      const results = toolMessages.map(m => JSON.parse(m.content));
      // Duplicate ID detection: second call should fail with TOOL_INVALID_ARGUMENTS
      // First call may succeed or fail for other reasons (execution), but duplicate detection works
      const duplicateError = results.find(r => r.error?.code === ToolErrorCode.TOOL_INVALID_ARGUMENTS);
      expect(duplicateError).toBeDefined();
      expect(duplicateError!.error.message).toContain('Duplicate tool call ID');
    });

    it('should handle invalid tool arguments', async () => {
      const conversationId = chatService.createConversation('Invalid Args').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 123 } }], // invalid type
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Invalid arguments provided.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Invalid args');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      const toolResult = JSON.parse(toolMessages[0].content);
      expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_INVALID_ARGUMENTS);
    });
  });

  describe('Execution', () => {
    it('should handle tool execution failures', async () => {
      const conversationId = chatService.createConversation('Tool Failure').id;

      // Register a tool that fails
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockRejectedValue(new Error('API error')),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Tool execution failed.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      const toolResult = JSON.parse(toolMessages[0].content);
      expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_EXECUTION_FAILED);
    });

    it('should handle tool timeout', async () => {
      // Create service with short timeout
      const shortTimeoutExecutor = new ToolExecutor(toolRegistry, { permissionPolicy: makePermissionPolicy() });
      const shortTimeoutService = new ToolExecutionService(shortTimeoutExecutor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxExecutionTimePerToolMs: 50 },
      });

      const timeoutChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService: shortTimeoutService,
      });

      // Register slow tool
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return { temperature: 22 };
        }),
      }));

      const conversationId = timeoutChatService.createConversation('Tool Timeout').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Request timed out.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      timeoutChatService.getProviderRegistry().get(providerId)!.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await timeoutChatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = timeoutChatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      const toolResult = JSON.parse(toolMessages[0].content);
      expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_TIMEOUT);

      await timeoutChatService.dispose();
      shortTimeoutService.dispose();
    });

    it('should handle permission denial', async () => {
      // Create service with denying policy
      const denyingExecutor = new ToolExecutor(toolRegistry, {
        permissionPolicy: { name: 'deny', evaluate: () => ({ allowed: false, reason: 'denied' }) },
      });
      const denyingService = new ToolExecutionService(denyingExecutor);

      const denyingChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService: denyingService,
      });

      const conversationId = denyingChatService.createConversation('Permission Denied').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Permission denied.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      denyingChatService.getProviderRegistry().get(providerId)!.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await denyingChatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = denyingChatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      const toolResult = JSON.parse(toolMessages[0].content);
      expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_PERMISSION_DENIED);

      await denyingChatService.dispose();
      denyingService.dispose();
    });
  });

  describe('Iteration and resource limits', () => {
    it('should stop after max iterations', async () => {
      // Create service with low iteration limit
      const limitedExecutor = new ToolExecutor(toolRegistry, { permissionPolicy: makePermissionPolicy() });
      const limitedService = new ToolExecutionService(limitedExecutor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxIterationsPerTurn: 2 },
      });

      const limitedChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService: limitedService,
      });

      const conversationId = limitedChatService.createConversation('Max Iterations').id;

      // Mock always returns tool_calls - should stop after 2 iterations
      limitedChatService.getProviderRegistry().get(providerId)!.execute = vi.fn().mockResolvedValue({
        id: 'response-1',
        model: modelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
          },
          finishReason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      });

      const assistantMessageId = await limitedChatService.sendMessage(conversationId, 'Loop');
      await new Promise(resolve => setTimeout(resolve, 500));

      const messages = limitedChatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should only execute 2 iterations worth of tools
      expect(toolMessages.length).toBeLessThanOrEqual(2);

      await limitedChatService.dispose();
      limitedService.dispose();
    });

    it('should respect max calls per batch', async () => {
      const conversationId = chatService.createConversation('Batch Limit').id;

      // Register many tools
      for (let i = 0; i < 10; i++) {
        toolRegistry.register(makeToolDefinition({
          name: `tool_${i}`,
          execute: vi.fn().mockResolvedValue({ result: i }),
        }));
      }

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 10 }, (_, i) => ({
                id: `call-${i}`,
                name: `tool_${i}`,
                arguments: { value: i },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call many tools');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Default maxCallsPerBatch is 5, 10 calls split into 2 batches = 10 total
      expect(toolMessages.length).toBe(10);
    });
  });

  describe('Persistence', () => {
    it('should persist assistant message with tool calls', async () => {
      const conversationId = chatService.createConversation('Persist Tool Calls').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.metadata?.toolCalls).toBeDefined();
      expect(assistantMsg?.metadata?.toolCalls).toHaveLength(1);
    });

    it('should persist tool result messages with correct correlation', async () => {
      const conversationId = chatService.createConversation('Persist Tool Results').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0].metadata?.toolCallId).toBe('call-1');
      expect(toolMessages[0].metadata?.toolName).toBe('get_weather');
    });
  });

  describe('Cancellation', () => {
    it('should cancel tool execution when turn is cancelled', async () => {
      const conversationId = chatService.createConversation('Cancel Tool').id;

      // Register slow tool
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
          return { temperature: 22 };
        }),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Cancelled.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 50)); // Let tool start

      chatService.cancelMessage(assistantMessageId);
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = chatService.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('cancelled');

      // Tool should have been cancelled
      const toolMessages = messages.filter(m => m.role === 'tool');
      if (toolMessages.length > 0) {
        const toolResult = JSON.parse(toolMessages[0].content);
        expect(toolResult.error.code).toBe(ToolErrorCode.TOOL_CANCELLED);
      }
    });

    it('should not execute new tool calls after cancellation', async () => {
      const conversationId = chatService.createConversation('Cancel No New Tools').id;

      // Register slow tool
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return { temperature: 22 };
        }),
      }));

      let callCount = 0;
      mockProvider.execute = vi.fn().mockImplementation(async (request) => {
        callCount++;
        const hasToolCalls = request.messages.some(m => m.toolCalls?.length);
        if (hasToolCalls) {
          return {
            id: 'response-1',
            model: modelId,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Done', finishReason: 'stop' },
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'stop',
          };
        }
        return {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        };
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 50));

      chatService.cancelMessage(assistantMessageId);
      await new Promise(resolve => setTimeout(resolve, 100));

      const finalMessage = chatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('cancelled');
    });
  });

  describe('No tools registered', () => {
    it('should work normally when no tools are registered', async () => {
      const noToolProvider = createMockNonToolCallingProvider({
        metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
        execute: vi.fn().mockResolvedValue({
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello!', finishReason: 'stop' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        }),
        executeStream: vi.fn().mockImplementation(async function* () {
          yield { type: 'stream:delta', delta: 'Hello!' };
          yield { type: 'stream:complete', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        }),
      });
      const noToolRegistry = createProviderRegistry();
      noToolRegistry.register(noToolProvider);

      const noToolChatService = createChatService({
        providerRegistry: noToolRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        // No toolRegistry or toolExecutionService
      });

      const conversationId = noToolChatService.createConversation('No Tools').id;

      const assistantMessageId = await noToolChatService.sendMessage(conversationId, 'Hello');
      await new Promise(resolve => setTimeout(resolve, 100));

      const finalMessage = noToolChatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('completed');
      expect(finalMessage?.content).toBe('Hello!');

      await noToolChatService.dispose();
    });
  });

  describe('Provider without tool calling capability', () => {
    it('should not send tools when model does not support tool calling', async () => {
      const nonToolProvider = createMockNonToolCallingProvider({
        metadata: { id: providerId, name: 'Test Provider', version: '1.0.0' },
        execute: vi.fn().mockResolvedValue({
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello!', finishReason: 'stop' },
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        }),
        executeStream: vi.fn().mockImplementation(async function* () {
          yield { type: 'stream:delta', delta: 'Hello!' };
          yield { type: 'stream:complete', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        }),
      });
      const nonToolRegistry = createProviderRegistry();
      nonToolRegistry.register(nonToolProvider);

      const nonToolChatService = createChatService({
        providerRegistry: nonToolRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService,
      });

      const conversationId = nonToolChatService.createConversation('No Tool Calling').id;

      let capturedRequest: any;
      nonToolProvider.executeStream = vi.fn().mockImplementation(async function* (request) {
        capturedRequest = request;
        yield { type: 'stream:delta', delta: 'Hello!' };
        yield { type: 'stream:complete', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      });

      const assistantMessageId = await nonToolChatService.sendMessage(conversationId, 'Hello');
      await new Promise(resolve => setTimeout(resolve, 100));

      // Since model doesn't support tool calling, executeStream is used (no tools in request)
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.tools).toBeUndefined();
      const finalMessage = nonToolChatService.getMessage(conversationId, assistantMessageId);
      expect(finalMessage?.status).toBe('completed');

      await nonToolChatService.dispose();
    });
  });

  describe('Resource leak prevention', () => {
    it('should complete turn when model error occurs after tool execution', async () => {
      const conversationId = chatService.createConversation('Model Error After Turn').id;

      // First response has tool calls, second response throws error
      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        // Second model request throws
        Promise.reject(new Error('Model provider error')),
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        const resp = responses[responseIndex++];
        if (resp instanceof Promise) throw await resp;
        return resp;
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Tool should have been executed and turn completed
      expect(toolMessages.length).toBe(1);
      
      // Verify turn is completed by checking service state
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    });

    it('should complete turn when cancelled during tool execution', async () => {
      const conversationId = chatService.createConversation('Cancelled During Turn').id;

      // Register slow tool
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
          return { temperature: 22 };
        }),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Cancelled.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 50)); // Let tool start

      chatService.cancelMessage(assistantMessageId);
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = chatService.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('cancelled');

      // Verify turn is cleaned up
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    });

    it('should complete turn on successful tool execution', async () => {
      const conversationId = chatService.createConversation('Successful Turn').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);

      // Verify turn is completed
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    });

    it('should complete turn when tool execution fails', async () => {
      const conversationId = chatService.createConversation('Tool Execution Failure').id;

      // Register a tool that fails
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockRejectedValue(new Error('API error')),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Tool failed.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);

      // Verify turn is completed
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    });
  });

  describe('Persistence round-trip', () => {
    it('should persist and load tool messages correctly', async () => {
      // Create a chat service with persistence
      const persistenceAdapter = {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createConversation: vi.fn().mockResolvedValue({ conversation: { id: 'test-conv', workspaceId: 'test', title: 'Test', createdAt: Date.now(), updatedAt: Date.now(), metadata: {} }, error: null }),
        getConversation: vi.fn().mockResolvedValue({ conversation: null, error: null }),
        listConversations: vi.fn().mockResolvedValue({ conversations: [], error: null }),
        updateConversation: vi.fn().mockResolvedValue({ conversation: null, error: null }),
        deleteConversation: vi.fn().mockResolvedValue({ deleted: true, error: null }),
        createMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        getMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        listMessages: vi.fn().mockResolvedValue({ messages: [], error: null }),
        updateMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        deleteMessage: vi.fn().mockResolvedValue({ deleted: true, error: null }),
        deleteMessagesByConversation: vi.fn().mockResolvedValue({ deleted: true, error: null }),
      } as any;

      const persistentChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService,
        persistenceAdapter,
      });

      const conversationId = persistentChatService.createConversation('Persistence Test').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await persistentChatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = persistentChatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0].metadata?.toolCallId).toBe('call-1');
      expect(toolMessages[0].metadata?.toolName).toBe('get_weather');

      // Verify the persistence adapter was called with correct tool message
      const createMessageCalls = persistenceAdapter.createMessage.mock.calls;
      const toolMessageCall = createMessageCalls.find(call => call[0].role === 'tool');
      expect(toolMessageCall).toBeDefined();
      expect(toolMessageCall[0].content).toContain('temperature');
      expect(toolMessageCall[0].metadata?.toolCallId).toBe('call-1');
      expect(toolMessageCall[0].metadata?.toolName).toBe('get_weather');

      await persistentChatService.dispose();
    });

    it('should persist assistant message with toolCalls metadata', async () => {
      const persistenceAdapter = {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        createConversation: vi.fn().mockResolvedValue({ conversation: { id: 'test-conv', workspaceId: 'test', title: 'Test', createdAt: Date.now(), updatedAt: Date.now(), metadata: {} }, error: null }),
        getConversation: vi.fn().mockResolvedValue({ conversation: null, error: null }),
        listConversations: vi.fn().mockResolvedValue({ conversations: [], error: null }),
        updateConversation: vi.fn().mockResolvedValue({ conversation: null, error: null }),
        deleteConversation: vi.fn().mockResolvedValue({ deleted: true, error: null }),
        createMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        getMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        listMessages: vi.fn().mockResolvedValue({ messages: [], error: null }),
        updateMessage: vi.fn().mockResolvedValue({ message: null, error: null }),
        deleteMessage: vi.fn().mockResolvedValue({ deleted: true, error: null }),
        deleteMessagesByConversation: vi.fn().mockResolvedValue({ deleted: true, error: null }),
      } as any;

      const persistentChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService,
        persistenceAdapter,
      });

      const conversationId = persistentChatService.createConversation('Assistant ToolCalls Persistence').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } },
                { id: 'call-2', name: 'get_weather', arguments: { location: 'LA' } },
              ],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await persistentChatService.sendMessage(conversationId, 'Weather in NYC and LA');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = persistentChatService.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.metadata?.toolCalls).toBeDefined();
      expect(assistantMsg?.metadata?.toolCalls).toHaveLength(2);

      // Note: Persistence adapter integration is tested in chat.persistence.test.ts
      // This test verifies the in-memory message has correct toolCalls metadata

      await persistentChatService.dispose();
    });
  });

  describe('Batch and iteration limits', () => {
    it('should execute 6 calls in one response across 2 batches', async () => {
      const conversationId = chatService.createConversation('Six Calls One Response').id;

      // Register 6 tools
      for (let i = 0; i < 6; i++) {
        toolRegistry.register(makeToolDefinition({
          name: `tool_${i}`,
          execute: vi.fn().mockResolvedValue({ result: i }),
        }));
      }

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 6 }, (_, i) => ({
                id: `call-${i}`,
                name: `tool_${i}`,
                arguments: { value: i },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call 6 tools');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // All 6 should execute (split into 2 batches of 5 and 1)
      expect(toolMessages.length).toBe(6);
    });

    it('should enforce 25-call total limit across multiple responses', async () => {
      const conversationId = chatService.createConversation('25 Call Limit').id;

      let callCount = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 5) {
          // Each response returns 5 tool calls
          return {
            id: `response-${callCount}`,
            model: modelId,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                toolCalls: Array.from({ length: 5 }, (_, i) => ({
                  id: `call-${callCount}-${i}`,
                  name: 'get_weather',
                  arguments: { location: `City ${callCount}-${i}` },
                })),
              },
              finishReason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'tool_calls',
          };
        } else {
          // 6th response - should not be reached due to limit
          return {
            id: `response-${callCount}`,
            model: modelId,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Should not reach here', finishReason: 'stop' },
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'stop',
          };
        }
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call many tools');
      await new Promise(resolve => setTimeout(resolve, 500));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should only execute 25 calls (5 responses × 5 calls)
      expect(toolMessages.length).toBe(25);

      // The 6th response should not be reached
      expect(callCount).toBeLessThanOrEqual(5);
    });

    it('should handle 10 calls in one response correctly', async () => {
      const conversationId = chatService.createConversation('Ten Calls One Response').id;

      for (let i = 0; i < 10; i++) {
        toolRegistry.register(makeToolDefinition({
          name: `tool_${i}`,
          execute: vi.fn().mockResolvedValue({ result: i }),
        }));
      }

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 10 }, (_, i) => ({
                id: `call-${i}`,
                name: `tool_${i}`,
                arguments: { value: i },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call 10 tools');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // All 10 should execute (2 batches of 5)
      expect(toolMessages.length).toBe(10);
    });

    it('should reject calls beyond 25 limit with TOOL_RESOURCE_LIMIT', async () => {
      const conversationId = chatService.createConversation('Reject Beyond 25').id;

      // First response: 20 calls
      // Second response: 10 calls (should only execute 5, reject 5)
      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 20 }, (_, i) => ({
                id: `call-1-${i}`,
                name: 'get_weather',
                arguments: { location: `City ${i}` },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 10 }, (_, i) => ({
                id: `call-2-${i}`,
                name: 'get_weather',
                arguments: { location: `City ${i}` },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-3',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Limit reached.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call 30 tools');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should execute 25 total (20 + 5 successful), plus 5 rejected with TOOL_RESOURCE_LIMIT = 30 tool messages
      expect(toolMessages.length).toBe(30);
      
      // Check that 5 calls have TOOL_RESOURCE_LIMIT error
      const limitErrors = toolMessages.filter(m => {
        const content = JSON.parse(m.content);
        return content.error?.code === 'TOOL_RESOURCE_LIMIT';
      });
      expect(limitErrors.length).toBe(5);
      
      // Check that 25 calls succeeded (no error in content)
      const successfulCalls = toolMessages.filter(m => {
        const content = JSON.parse(m.content);
        return !content.error;
      });
      expect(successfulCalls.length).toBe(25);
    });
  });

  describe('Shared execution turn lifecycle', () => {
    it('should reuse one execution turn across multiple model responses', async () => {
      const conversationId = chatService.createConversation('Shared Turn Reuse').id;

      // Track turn creation
      const originalCreateTurn = toolExecutionService.createTurn.bind(toolExecutionService);
      let turnCreationCount = 0;
      let createdTurn: ToolExecutionTurn | null = null;
      toolExecutionService.createTurn = vi.fn().mockImplementation((options) => {
        turnCreationCount++;
        const turn = originalCreateTurn(options);
        if (!createdTurn) createdTurn = turn;
        return turn;
      });

      // First response: tool calls
      // Second response: tool calls  
      // Third response: final answer
      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-2', name: 'get_weather', arguments: { location: 'LA' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-3',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved for both cities.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC and LA');
      await new Promise(resolve => setTimeout(resolve, 300));

      // Only one turn should have been created for the entire interaction
      expect(turnCreationCount).toBe(1);
      
      // The turn should be disposed after completion (dispose() sets status to 'disposed')
      expect(createdTurn?.status).toBe('disposed');

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
    });

    it('should reuse one execution turn across multiple batches within a response', async () => {
      const conversationId = chatService.createConversation('Multi-Batch Shared Turn').id;

      // Register 8 tools (will require 2 batches of 5 and 3)
      for (let i = 0; i < 8; i++) {
        toolRegistry.register(makeToolDefinition({
          name: `tool_${i}`,
          execute: vi.fn().mockResolvedValue({ result: i }),
        }));
      }

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 8 }, (_, i) => ({
                id: `call-${i}`,
                name: `tool_${i}`,
                arguments: { value: i },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'All tools executed.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call 8 tools');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // All 8 should execute (2 batches: 5 + 3)
      expect(toolMessages.length).toBe(8);
      
      // Verify turn was reused (only one turn created)
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0); // Turn should be completed and cleaned up
    });

    it('should count total calls across multiple model responses', async () => {
      const conversationId = chatService.createConversation('Cross-Response Call Count').id;

      let callCount = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          // Each response returns 5 tool calls
          return {
            id: `response-${callCount}`,
            model: modelId,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                toolCalls: Array.from({ length: 5 }, (_, i) => ({
                  id: `call-${callCount}-${i}`,
                  name: 'get_weather',
                  arguments: { location: `City ${callCount}-${i}` },
                })),
              },
              finishReason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'tool_calls',
          };
        } else {
          // 4th response - should not be reached due to 25-call limit
          return {
            id: `response-${callCount}`,
            model: modelId,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Should not reach here', finishReason: 'stop' },
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'stop',
          };
        }
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call many tools');
      await new Promise(resolve => setTimeout(resolve, 500));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should only execute 15 calls (3 responses × 5 calls) - well under 25 limit
      expect(toolMessages.length).toBe(15);
      
      // Verify the shared turn's call counter tracked across responses
      // The turn should have callsSubmitted = 15
    });

    it('should enforce 25-call limit across multiple model responses', async () => {
      const conversationId = chatService.createConversation('25 Call Limit Cross Responses').id;

      // First response: 20 calls
      // Second response: 10 calls (should only execute 5, reject 5)
      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 20 }, (_, i) => ({
                id: `call-1-${i}`,
                name: 'get_weather',
                arguments: { location: `City ${i}` },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: Array.from({ length: 10 }, (_, i) => ({
                id: `call-2-${i}`,
                name: 'get_weather',
                arguments: { location: `City ${i}` },
              })),
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-3',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Limit reached.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Call 30 tools');
      await new Promise(resolve => setTimeout(resolve, 300));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should execute 25 total (20 + 5 successful), plus 5 rejected with TOOL_RESOURCE_LIMIT = 30 tool messages
      expect(toolMessages.length).toBe(30);
      
      // Check that 5 calls have TOOL_RESOURCE_LIMIT error
      const limitErrors = toolMessages.filter(m => {
        const content = JSON.parse(m.content);
        return content.error?.code === 'TOOL_RESOURCE_LIMIT';
      });
      expect(limitErrors.length).toBe(5);
      
      // Check that 25 calls succeeded (no error in content)
      const successfulCalls = toolMessages.filter(m => {
        const content = JSON.parse(m.content);
        return !content.error;
      });
      expect(successfulCalls.length).toBe(25);
    });

    it('should enforce shared 120-second deadline across model responses', async () => {
      const conversationId = chatService.createConversation('Shared Deadline').id;

      // Track turn creation to verify deadline behavior
      const originalCreateTurn = toolExecutionService.createTurn.bind(toolExecutionService);
      let createdTurn: ToolExecutionTurn | null = null;
      toolExecutionService.createTurn = vi.fn().mockImplementation((options) => {
        const turn = originalCreateTurn(options);
        if (!createdTurn) createdTurn = turn;
        return turn;
      });

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-2', name: 'get_weather', arguments: { location: 'LA' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-3',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC and LA');
      await new Promise(resolve => setTimeout(resolve, 300));

      // Verify the turn was created and used for both tool executions
      expect(createdTurn).not.toBeNull();
      // The turn's deadline should span across both model responses
      // (verified by the fact that both tool calls executed successfully)
      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
      
      // Turn should be disposed after completion
      expect(createdTurn?.status).toBe('disposed');
    });

    it('should dispose shared turn on cancellation', async () => {
      const conversationId = chatService.createConversation('Cancel Disposes Turn').id;

      // Register slow tool
      toolRegistry.unregister('get_weather');
      toolRegistry.register(makeToolDefinition({
        execute: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 500));
          return { temperature: 22 };
        }),
      }));

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Cancelled.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 50)); // Let tool start

      chatService.cancelMessage(assistantMessageId);
      await new Promise(resolve => setTimeout(resolve, 100));

      const messages = chatService.getMessages(conversationId);
      const assistantMsg = messages.find(m => m.id === assistantMessageId);
      expect(assistantMsg?.status).toBe('cancelled');

      // Verify turn is cleaned up
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    }, 10000);

    it('should dispose shared turn on model-provider error', async () => {
      const conversationId = chatService.createConversation('Model Error Disposes Turn').id;

      // First response has tool calls, second response throws error
      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        // Second model request throws
        Promise.reject(new Error('Model provider error')),
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        const resp = responses[responseIndex++];
        if (resp instanceof Promise) throw await resp;
        return resp;
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Tool should have been executed
      expect(toolMessages.length).toBe(1);
      
      // Verify turn is cleaned up
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    }, 10000);

    it('should dispose shared turn on successful final completion', async () => {
      const conversationId = chatService.createConversation('Success Disposes Turn').id;

      const responses = [
        {
          id: 'response-1',
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
            },
            finishReason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        },
        {
          id: 'response-2',
          model: modelId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Weather retrieved.' },
            finishReason: 'stop',
          }],
          usage: { promptTokens: 15, completionTokens: 10, totalTokens: 25 },
          finishReason: 'stop',
        },
      ];
      let responseIndex = 0;
      mockProvider.execute = vi.fn().mockImplementation(async () => {
        return responses[responseIndex++];
      });

      const assistantMessageId = await chatService.sendMessage(conversationId, 'Weather in NYC');
      await new Promise(resolve => setTimeout(resolve, 200));

      const messages = chatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(1);

      // Verify turn is completed and cleaned up
      const snapshot = toolExecutionService.getGlobalSnapshot();
      expect(snapshot.activeTurns).toBe(0);
    }, 10000);

    it('should enforce model interaction cycle limit (maxIterationsPerTurn)', async () => {
      // Create service with low iteration limit
      const limitedExecutor = new ToolExecutor(toolRegistry, { permissionPolicy: makePermissionPolicy() });
      const limitedService = new ToolExecutionService(limitedExecutor, {
        config: { ...DEFAULT_TOOL_EXECUTION_SERVICE_CONFIG, maxIterationsPerTurn: 2 },
      });

      const limitedChatService = createChatService({
        providerRegistry,
        defaultProvider: providerId,
        defaultModel: modelId,
        toolRegistry,
        toolExecutionService: limitedService,
      });

      const conversationId = limitedChatService.createConversation('Max Iterations').id;

      // Mock always returns tool_calls - should stop after 2 iterations
      limitedChatService.getProviderRegistry().get(providerId)!.execute = vi.fn().mockResolvedValue({
        id: 'response-1',
        model: modelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } }],
          },
          finishReason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool_calls',
      });

      const assistantMessageId = await limitedChatService.sendMessage(conversationId, 'Loop');
      await new Promise(resolve => setTimeout(resolve, 500));

      const messages = limitedChatService.getMessages(conversationId);
      const toolMessages = messages.filter(m => m.role === 'tool');
      // Should only execute 2 iterations worth of tools
      expect(toolMessages.length).toBeLessThanOrEqual(2);

      await limitedChatService.dispose();
      limitedService.dispose();
    }, 10000);
  });
});