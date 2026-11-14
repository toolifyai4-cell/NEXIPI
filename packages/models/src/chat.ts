import { EventEmitter, type EventMap, type EventName } from '@nexipi/core';
import { createLogger, type Logger } from '@nexipi/core';
import { EngineError, EngineErrorCode, isEngineError, type EngineErrorOptions } from '@nexipi/core';
import { sanitize } from '@nexipi/core';
import {
  ConversationId,
  MessageId,
  type Message,
  type MessageRole,
  type MessageStatus,
  type Conversation,
  type ConversationState,
  createConversation,
  createMessage,
  updateMessageStatus,
  appendMessageContent,
  isMessageTerminal,
  isMessageActive,
} from '@nexipi/shared';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelId,
  ProviderId,
  GenerationParameters,
  ModelMessage,
} from './types.js';
import { ProviderRegistry, createProviderRegistry } from './registry.js';
import {
  type StreamEvent,
  type StreamStartEvent,
  type StreamDeltaEvent,
  type StreamCompleteEvent,
  type StreamErrorEvent,
  type StreamCancelEvent,
  createStreamStartEvent,
  createStreamDeltaEvent,
  createStreamCompleteEvent,
  createStreamErrorEvent,
  createStreamCancelEvent,
} from '@nexipi/shared';

export interface ChatServiceEvents extends EventMap {
  'conversation:created': { conversation: Conversation; timestamp: number };
  'conversation:updated': { conversation: Conversation; timestamp: number };
  'conversation:deleted': { conversationId: ConversationId; timestamp: number };
  'message:created': { message: Message; timestamp: number };
  'message:updated': { message: Message; timestamp: number };
  'message:deleted': { messageId: MessageId; conversationId: ConversationId; timestamp: number };
  'stream:event': { event: StreamEvent; timestamp: number };
  'chat:error': { error: EngineError; conversationId?: ConversationId; messageId?: MessageId; timestamp: number };
}

export interface ChatServiceOptions {
  providerRegistry?: ProviderRegistry;
  defaultModel?: ModelId;
  defaultProvider?: ProviderId;
  logger?: Logger;
  maxHistoryLength?: number;
}

interface ActiveStream {
  controller: AbortController;
  conversationId: ConversationId;
  messageId: MessageId;
  promise: Promise<void>;
}

export class ChatService {
  private readonly conversations: Map<ConversationId, Conversation> = new Map();
  private readonly messages: Map<ConversationId, Map<MessageId, Message>> = new Map();
  private readonly eventEmitter: EventEmitter<ChatServiceEvents>;
  private readonly logger: Logger;
  private readonly providerRegistry: ProviderRegistry;
  private readonly defaultModel?: ModelId;
  private readonly defaultProvider?: ProviderId;
  private readonly maxHistoryLength: number;
  private readonly activeStreams: Map<MessageId, ActiveStream> = new Map();

  constructor(options: ChatServiceOptions = {}) {
    this.providerRegistry = options.providerRegistry ?? createProviderRegistry();
    this.defaultModel = options.defaultModel;
    this.defaultProvider = options.defaultProvider;
    this.logger = options.logger ?? createLogger({
      name: 'chat-service',
      version: '0.0.1',
      logLevel: 'info',
      maxConcurrentTasks: 10,
      taskTimeoutMs: 30000,
      shutdownTimeoutMs: 10000,
      enableTelemetry: false,
    });
    this.maxHistoryLength = options.maxHistoryLength ?? 100;
    this.eventEmitter = new EventEmitter<ChatServiceEvents>({
      onListenerError: (error, eventName) => {
        this.logger.error(`Listener error for event ${eventName}`, { error: error.message });
      },
    });
  }

  getEventEmitter(): EventEmitter<ChatServiceEvents> {
    return this.eventEmitter;
  }

  getLogger(): Logger {
    return this.logger;
  }

  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }

  createConversation(title: string = 'New Conversation'): Conversation {
    const conversationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}` as ConversationId;
    const conversation = createConversation(conversationId, title);
    this.conversations.set(conversationId, conversation);
    this.messages.set(conversationId, new Map());
    this.logger.info('Conversation created', { conversationId, title });
    this.eventEmitter.emit('conversation:created', { conversation, timestamp: Date.now() });
    return conversation;
  }

  getConversation(conversationId: ConversationId): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  listConversations(): readonly Conversation[] {
    return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateConversationTitle(conversationId: ConversationId, title: string): Conversation | undefined {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return undefined;
    }
    const updated: Conversation = {
      ...conversation,
      title,
      updatedAt: Date.now(),
    };
    this.conversations.set(conversationId, updated);
    this.logger.debug('Conversation title updated', { conversationId, title });
    this.eventEmitter.emit('conversation:updated', { conversation: updated, timestamp: Date.now() });
    return updated;
  }

  deleteConversation(conversationId: ConversationId): boolean {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return false;
    }

    this.cancelActiveStream(conversationId);

    this.conversations.delete(conversationId);
    this.messages.delete(conversationId);
    this.logger.info('Conversation deleted', { conversationId });
    this.eventEmitter.emit('conversation:deleted', { conversationId, timestamp: Date.now() });
    return true;
  }

  getMessages(conversationId: ConversationId): readonly Message[] {
    const convMessages = this.messages.get(conversationId);
    if (!convMessages) {
      return [];
    }
    return Array.from(convMessages.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  getMessage(conversationId: ConversationId, messageId: MessageId): Message | undefined {
    return this.messages.get(conversationId)?.get(messageId);
  }

  addMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
    status: MessageStatus = 'pending',
    metadata?: Record<string, unknown>
  ): Message | undefined {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.logger.warn('Cannot add message: conversation not found', { conversationId });
      return undefined;
    }

    const message = createMessage(conversationId, role, content, status, metadata);
    const convMessages = this.messages.get(conversationId)!;
    convMessages.set(message.id, message);

    this.updateConversationTimestamp(conversationId);

    this.logger.debug('Message added', { conversationId, messageId: message.id, role, status });
    this.eventEmitter.emit('message:created', { message, timestamp: Date.now() });
    return message;
  }

  updateMessage(
    conversationId: ConversationId,
    messageId: MessageId,
    updates: Partial<Pick<Message, 'content' | 'status' | 'metadata'>>
  ): Message | undefined {
    const convMessages = this.messages.get(conversationId);
    if (!convMessages) {
      return undefined;
    }

    const message = convMessages.get(messageId);
    if (!message) {
      return undefined;
    }

    const updated: Message = {
      ...message,
      ...updates,
      metadata: {
        ...message.metadata,
        ...updates.metadata,
      },
    };

    convMessages.set(messageId, updated);
    this.updateConversationTimestamp(conversationId);

    this.logger.debug('Message updated', { conversationId, messageId, status: updated.status });
    this.eventEmitter.emit('message:updated', { message: updated, timestamp: Date.now() });
    return updated;
  }

  deleteMessage(conversationId: ConversationId, messageId: MessageId): boolean {
    const convMessages = this.messages.get(conversationId);
    if (!convMessages) {
      return false;
    }

    const deleted = convMessages.delete(messageId);
    if (deleted) {
      this.updateConversationTimestamp(conversationId);
      this.logger.debug('Message deleted', { conversationId, messageId });
      this.eventEmitter.emit('message:deleted', { messageId, conversationId, timestamp: Date.now() });
    }
    return deleted;
  }

  getConversationState(conversationId: ConversationId): ConversationState | undefined {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return undefined;
    }

    const messages = this.getMessages(conversationId);
    const activeMessage = messages.find(m => isMessageActive(m));
    const errorMessage = messages.find(m => m.status === 'failed');

    return {
      conversation,
      messages,
      activeMessageId: activeMessage?.id ?? null,
      isLoading: activeMessage !== undefined,
      error: errorMessage?.content ?? null,
    };
  }

  async sendMessage(
    conversationId: ConversationId,
    content: string,
    options: {
      model?: ModelId;
      provider?: ProviderId;
      parameters?: GenerationParameters;
      systemPrompt?: string;
    } = {}
  ): Promise<MessageId> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new EngineError(EngineErrorCode.INVALID_CONFIGURATION, `Conversation ${conversationId} not found`);
    }

    const userMessage = this.addMessage(conversationId, 'user', content, 'completed');
    if (!userMessage) {
      throw new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Failed to create user message');
    }

    const assistantMessage = this.addMessage(conversationId, 'assistant', '', 'pending');
    if (!assistantMessage) {
      throw new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Failed to create assistant message');
    }

    const controller = new AbortController();
    const streamPromise = this.executeStream(conversationId, assistantMessage.id, controller.signal, options);

    const activeStream: ActiveStream = {
      controller,
      conversationId,
      messageId: assistantMessage.id,
      promise: streamPromise,
    };
    this.activeStreams.set(assistantMessage.id, activeStream);

    this.updateMessage(conversationId, assistantMessage.id, { status: 'streaming' });

    streamPromise
      .then(() => {
        this.activeStreams.delete(assistantMessage.id);
      })
      .catch((error) => {
        this.activeStreams.delete(assistantMessage.id);
        if (!controller.signal.aborted) {
          this.logger.error('Stream execution failed', {
            conversationId,
            messageId: assistantMessage.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return assistantMessage.id;
  }

  private async executeStream(
    conversationId: ConversationId,
    messageId: MessageId,
    signal: AbortSignal,
    options: {
      model?: ModelId;
      provider?: ProviderId;
      parameters?: GenerationParameters;
      systemPrompt?: string;
    }
  ): Promise<void> {
    const providerId = options.provider ?? this.defaultProvider;
    const modelId = options.model ?? this.defaultModel;

    if (!providerId) {
      await this.handleStreamError(conversationId, messageId, {
        code: 'NO_PROVIDER',
        message: 'No model provider configured',
        retryable: false,
      });
      return;
    }

    if (!modelId) {
      await this.handleStreamError(conversationId, messageId, {
        code: 'NO_MODEL',
        message: 'No model selected',
        retryable: false,
      });
      return;
    }

    const provider = this.providerRegistry.get(providerId);
    if (!provider) {
      await this.handleStreamError(conversationId, messageId, {
        code: 'PROVIDER_NOT_FOUND',
        message: `Provider ${providerId} not found`,
        retryable: false,
      });
      return;
    }

    const modelMetadata = provider.getModel(modelId);
    if (!modelMetadata) {
      await this.handleStreamError(conversationId, messageId, {
        code: 'MODEL_NOT_FOUND',
        message: `Model ${modelId} not found in provider ${providerId}`,
        retryable: false,
      });
      return;
    }

    const messages = this.buildModelMessages(conversationId, options.systemPrompt);
    const request: ModelRequest = {
      model: modelId,
      messages,
      parameters: options.parameters,
    };

    this.logger.info('Executing model request', {
      conversationId,
      messageId,
      providerId,
      modelId,
      messageCount: messages.length,
    });

    this.eventEmitter.emit('stream:event', {
      event: createStreamStartEvent(conversationId, messageId, modelId),
      timestamp: Date.now(),
    });

    try {
      // Check if provider supports streaming
      const supportsStreaming = typeof provider.executeStream === 'function';
      
      if (supportsStreaming) {
        await this.executeStreamingProvider(provider, request, conversationId, messageId, signal);
      } else if (typeof provider.execute === 'function') {
        await this.executeNonStreamingProvider(provider, request, conversationId, messageId, signal);
      } else {
        await this.handleStreamError(conversationId, messageId, {
          code: 'PROVIDER_NOT_SUPPORTED',
          message: 'Provider does not implement execute or executeStream',
          retryable: false,
        });
      }
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
        this.logger.info('Stream cancelled', { conversationId, messageId });
        this.eventEmitter.emit('stream:event', {
          event: createStreamCancelEvent(conversationId, messageId),
          timestamp: Date.now(),
        });
        this.updateMessage(conversationId, messageId, { status: 'cancelled' });
      } else {
        this.logger.error('Stream execution error', {
          conversationId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  private async executeStreamingProvider(
    provider: ModelProvider,
    request: ModelRequest,
    conversationId: ConversationId,
    messageId: MessageId,
    signal: AbortSignal
  ): Promise<void> {
    let hasCompleted = false;
    let accumulatedContent = '';

    for await (const event of provider.executeStream(request, signal)) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (event.type === 'stream:delta') {
        accumulatedContent += event.delta;
        this.updateMessage(conversationId, messageId, {
          content: accumulatedContent,
          status: 'streaming',
        });

        this.eventEmitter.emit('stream:event', { event, timestamp: Date.now() });
      } else if (event.type === 'stream:complete') {
        if (hasCompleted) {
          this.logger.warn('Duplicate stream:complete event ignored', { conversationId, messageId });
          continue;
        }
        hasCompleted = true;

        this.updateMessage(conversationId, messageId, {
          content: accumulatedContent,
          status: 'completed',
          metadata: {
            usage: event.usage,
            finishReason: event.finishReason,
          },
        });

        this.eventEmitter.emit('stream:event', { event, timestamp: Date.now() });
        break;
      } else if (event.type === 'stream:error') {
        if (hasCompleted) {
          this.logger.warn('Stream error after completion ignored', { conversationId, messageId });
          continue;
        }
        hasCompleted = true;
        await this.handleStreamError(conversationId, messageId, event.error);
        break;
      }
    }

    if (!hasCompleted && !signal.aborted) {
      this.updateMessage(conversationId, messageId, {
        content: accumulatedContent,
        status: 'completed',
      });
    }
  }

  private async executeNonStreamingProvider(
    provider: ModelProvider,
    request: ModelRequest,
    conversationId: ConversationId,
    messageId: MessageId,
    signal: AbortSignal
  ): Promise<void> {
    this.updateMessage(conversationId, messageId, { status: 'streaming' });

    const resultPromise = provider.execute(request, signal);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new DOMException('Timeout', 'AbortError')), 30000)
    );

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const completeEvent = createStreamCompleteEvent(
        conversationId,
        messageId,
        result.finishReason,
        result.usage
      );

      this.updateMessage(conversationId, messageId, {
        content: result.content,
        status: 'completed',
        metadata: {
          usage: result.usage,
          finishReason: result.finishReason,
        },
      });

      this.eventEmitter.emit('stream:event', { event: completeEvent, timestamp: Date.now() });
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      await this.handleStreamError(conversationId, messageId, {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private async handleStreamError(
    conversationId: ConversationId,
    messageId: MessageId,
    error: { code: string; message: string; retryable: boolean; providerErrorCode?: string | undefined }
  ): Promise<void> {
    const errorEvent = createStreamErrorEvent(conversationId, messageId, error);

    this.updateMessage(conversationId, messageId, {
      status: 'failed',
      metadata: {
        error: errorEvent.error,
      },
    });

    this.eventEmitter.emit('stream:event', { event: errorEvent, timestamp: Date.now() });
    this.eventEmitter.emit('chat:error', {
      error: new EngineError(EngineErrorCode.INTERNAL_ERROR, error.message, {
        context: { ...errorEvent.error, conversationId, messageId },
      } as EngineErrorOptions),
      conversationId,
      messageId,
      timestamp: Date.now(),
    });
  }

  private buildModelMessages(
    conversationId: ConversationId,
    systemPrompt?: string
  ): readonly ModelMessage[] {
    const messages = this.getMessages(conversationId);
    const modelMessages: ModelMessage[] = [];

    if (systemPrompt) {
      modelMessages.push({ role: 'system', content: systemPrompt });
    }

    const recentMessages = messages.slice(-this.maxHistoryLength);
    for (const msg of recentMessages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        if (isMessageTerminal(msg) || msg.status === 'streaming') {
          modelMessages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    return modelMessages;
  }

  cancelActiveStream(conversationId: ConversationId): void {
    for (const [messageId, stream] of this.activeStreams.entries()) {
      if (stream.conversationId === conversationId) {
        stream.controller.abort();
        this.activeStreams.delete(messageId);
        this.logger.info('Active stream cancelled', { conversationId, messageId });
      }
    }
  }

  cancelMessage(messageId: MessageId): boolean {
    const stream = this.activeStreams.get(messageId);
    if (stream) {
      stream.controller.abort();
      this.activeStreams.delete(messageId);
      this.logger.info('Message stream cancelled', { messageId });
      return true;
    }
    return false;
  }

  retryMessage(conversationId: ConversationId, messageId: MessageId): Promise<MessageId | undefined> {
    const message = this.getMessage(conversationId, messageId);
    if (!message || message.role !== 'assistant') {
      return Promise.resolve(undefined);
    }

    if (message.status !== 'failed' && message.status !== 'cancelled') {
      return Promise.resolve(undefined);
    }

    this.updateMessage(conversationId, messageId, { status: 'pending', content: '' });

    const userMessages = this.getMessages(conversationId).filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];

    if (!lastUserMessage) {
      return Promise.resolve(undefined);
    }

    return this.sendMessage(conversationId, lastUserMessage.content);
  }

  on<T extends EventName>(
    eventName: T,
    listener: (payload: ChatServiceEvents[T]) => void | Promise<void>
  ) {
    return this.eventEmitter.on(eventName, listener);
  }

  off<T extends EventName>(
    eventName: T,
    listener: (payload: ChatServiceEvents[T]) => void | Promise<void>
  ) {
    return this.eventEmitter.off(eventName, listener);
  }

  private updateConversationTimestamp(conversationId: ConversationId): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      const updated: Conversation = {
        ...conversation,
        updatedAt: Date.now(),
      };
      this.conversations.set(conversationId, updated);
    }
  }

  async dispose(): Promise<void> {
    for (const stream of this.activeStreams.values()) {
      stream.controller.abort();
    }
    this.activeStreams.clear();
    this.conversations.clear();
    this.messages.clear();
    this.eventEmitter.removeAllListeners();
    this.logger.info('ChatService disposed');
  }
}

export function createChatService(options?: ChatServiceOptions): ChatService {
  return new ChatService(options);
}