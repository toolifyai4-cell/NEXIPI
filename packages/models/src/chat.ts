import { EventEmitter, type EventMap, type EventName } from '@nexipi/core';
import { createLogger, type Logger } from '@nexipi/core';
import { EngineError, EngineErrorCode, type EngineErrorOptions } from '@nexipi/core';
import {
  type ConversationId,
  type MessageId,
  type Message,
  type MessageRole,
  type MessageStatus,
  type Conversation,
  type ConversationState,
  createConversation,
  createMessage,
  isMessageTerminal,
  isMessageActive,
} from '@nexipi/shared';
import type {
  ModelProvider,
  ModelRequest,
  ModelId,
  ProviderId,
  GenerationParameters,
  ModelMessage,
} from './types.js';
import type { ProviderRegistry } from './registry.js';
import { createProviderRegistry } from './registry.js';
import {
  type StreamEvent,
  createStreamStartEvent,
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
  'chat:error': {
    error: EngineError;
    conversationId?: ConversationId;
    messageId?: MessageId;
    timestamp: number;
  };
}

export interface ChatServiceOptions {
  providerRegistry?: ProviderRegistry;
  defaultModel?: ModelId;
  defaultProvider?: ProviderId;
  logger?: Logger;
  maxHistoryLength?: number;
  /** Concurrency policy for multiple requests in the same conversation */
  concurrencyPolicy?: 'queue' | 'cancel-previous' | 'allow-all';
}

type ConcurrencyPolicy = 'queue' | 'cancel-previous' | 'allow-all';

interface ActiveStream {
  controller: AbortController;
  conversationId: ConversationId;
  messageId: MessageId;
  promise: Promise<void>;
  requestId: string;
  /** Tracks if this stream was intentionally cancelled (by user or disposal) */
  intentionallyCancelled: boolean;
}

interface PendingRequest {
  conversationId: ConversationId;
  userContent: string;
  options: {
    model?: ModelId;
    provider?: ProviderId;
    parameters?: GenerationParameters;
    systemPrompt?: string;
  };
  resolve: (messageId: MessageId) => void;
  reject: (error: Error) => void;
}

interface ActiveRequestInfo {
  conversationId: ConversationId;
  messageId: MessageId;
}

export class ChatService {
  private readonly conversations: Map<ConversationId, Conversation> = new Map();
  private readonly messages: Map<ConversationId, Map<MessageId, Message>> = new Map();
  private readonly eventEmitter: EventEmitter<ChatServiceEvents>;
  private readonly logger: Logger;
  private readonly providerRegistry: ProviderRegistry;
  private readonly defaultModel: ModelId | undefined;
  private readonly defaultProvider: ProviderId | undefined;
  private readonly maxHistoryLength: number;
  private readonly concurrencyPolicy: ConcurrencyPolicy;
  private readonly activeStreams: Map<MessageId, ActiveStream> = new Map();
  private readonly requestQueue: Map<ConversationId, PendingRequest[]> = new Map();
  /** Tracks all active requests by requestId for request-scoped validation */
  private readonly activeRequests: Map<string, ActiveRequestInfo> = new Map();
  /** Tracks the primary request per conversation (for queue/cancel-previous policies) */
  private readonly primaryRequestId: Map<ConversationId, string> = new Map();
  private _isDisposed = false;

  constructor(options: ChatServiceOptions = {}) {
    this.providerRegistry = options.providerRegistry ?? createProviderRegistry();
    this.defaultModel = options.defaultModel;
    this.defaultProvider = options.defaultProvider;
    this.logger =
      options.logger ??
      createLogger({
        name: 'chat-service',
        version: '0.0.1',
        logLevel: 'info',
        maxConcurrentTasks: 10,
        taskTimeoutMs: 30000,
        shutdownTimeoutMs: 10000,
        enableTelemetry: false,
      });
    this.maxHistoryLength = options.maxHistoryLength ?? 100;
    this.concurrencyPolicy = options.concurrencyPolicy ?? 'cancel-previous';
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

  /** Get the current concurrency policy */
  getConcurrencyPolicy(): ConcurrencyPolicy {
    return this.concurrencyPolicy;
  }

  /** Check if the service has been disposed */
  isDisposed(): boolean {
    return this._isDisposed;
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getRequestQueue(conversationId: ConversationId): PendingRequest[] {
    let queue = this.requestQueue.get(conversationId);
    if (!queue) {
      queue = [];
      this.requestQueue.set(conversationId, queue);
    }
    return queue;
  }

  private clearRequestQueue(conversationId: ConversationId): void {
    const queue = this.requestQueue.get(conversationId);
    if (queue) {
      for (const req of queue) {
        req.reject(
          new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Request cancelled due to new request')
        );
      }
      this.requestQueue.delete(conversationId);
    }
  }

  createConversation(title: string = 'New Conversation'): Conversation {
    const conversationId =
      `${Date.now()}-${Math.random().toString(36).substr(2, 9)}` as ConversationId;
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
    this.eventEmitter.emit('conversation:updated', {
      conversation: updated,
      timestamp: Date.now(),
    });
    return updated;
  }

  deleteConversation(conversationId: ConversationId): boolean {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return false;
    }

    this.cancelActiveStream(conversationId);
    this.primaryRequestId.delete(conversationId);
    this.clearRequestQueue(conversationId);

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
      this.eventEmitter.emit('message:deleted', {
        messageId,
        conversationId,
        timestamp: Date.now(),
      });
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

  // eslint-disable-next-line @typescript-eslint/require-await
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
    if (this._isDisposed) {
      throw new EngineError(EngineErrorCode.INTERNAL_ERROR, 'ChatService has been disposed');
    }

    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new EngineError(
        EngineErrorCode.INVALID_CONFIGURATION,
        `Conversation ${conversationId} not found`
      );
    }

    const requestId = this.generateRequestId();
    const primaryRequestId = this.primaryRequestId.get(conversationId);

    // Handle concurrency based on policy
    if (primaryRequestId) {
      switch (this.concurrencyPolicy) {
        case 'cancel-previous': {
          // Cancel the currently active stream for this conversation
          this.cancelActiveStream(conversationId);
          this.clearRequestQueue(conversationId);
          this.logger.info('Cancelled previous request due to new request', {
            conversationId,
            previousRequestId: primaryRequestId,
            newRequestId: requestId,
          });
          break;
        }
        case 'queue': {
          // Queue the new request
          return new Promise<MessageId>((resolve, reject) => {
            const queue = this.getRequestQueue(conversationId);
            queue.push({
              conversationId,
              userContent: content,
              options,
              resolve,
              reject,
            });
          });
        }
        case 'allow-all': {
          // Allow all requests to run concurrently - no blocking
          break;
        }
      }
    }

    // Register this request as active
    this.activeRequests.set(requestId, { conversationId, messageId: '' as MessageId });
    // For queue/cancel-previous, this becomes the primary request
    if (this.concurrencyPolicy !== 'allow-all') {
      this.primaryRequestId.set(conversationId, requestId);
    }

    const userMessage = this.addMessage(conversationId, 'user', content, 'completed');
    if (!userMessage) {
      this.activeRequests.delete(requestId);
      if (this.primaryRequestId.get(conversationId) === requestId) {
        this.primaryRequestId.delete(conversationId);
      }
      throw new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Failed to create user message');
    }

    const assistantMessage = this.addMessage(conversationId, 'assistant', '', 'pending');
    if (!assistantMessage) {
      this.activeRequests.delete(requestId);
      if (this.primaryRequestId.get(conversationId) === requestId) {
        this.primaryRequestId.delete(conversationId);
      }
      throw new EngineError(EngineErrorCode.INTERNAL_ERROR, 'Failed to create assistant message');
    }

    // Update the active request info with the actual messageId
    this.activeRequests.set(requestId, { conversationId, messageId: assistantMessage.id });

    this.updateMessage(conversationId, assistantMessage.id, { status: 'streaming' });

    const controller = new AbortController();
    const streamPromise = this.executeStream(
      conversationId,
      assistantMessage.id,
      controller.signal,
      options,
      requestId
    );

    const activeStream: ActiveStream = {
      controller,
      conversationId,
      messageId: assistantMessage.id,
      promise: streamPromise,
      requestId,
      intentionallyCancelled: false,
    };
    this.activeStreams.set(assistantMessage.id, activeStream);

    streamPromise
      .then(() => {
        if (!this._isDisposed) {
          this.activeStreams.delete(assistantMessage.id);
          this.activeRequests.delete(requestId);
          if (this.primaryRequestId.get(conversationId) === requestId) {
            this.primaryRequestId.delete(conversationId);
            this.processNextRequest(conversationId);
          }
        }
      })
      .catch(error => {
        // Check if this stream was intentionally cancelled
        const stream = this.activeStreams.get(assistantMessage.id);
        const intentionallyCancelled = stream?.intentionallyCancelled ?? false;

        if (!this._isDisposed && !intentionallyCancelled) {
          this.activeStreams.delete(assistantMessage.id);
          this.activeRequests.delete(requestId);
          if (this.primaryRequestId.get(conversationId) === requestId) {
            this.primaryRequestId.delete(conversationId);
            this.processNextRequest(conversationId);
          }
          if (!controller.signal.aborted) {
            this.logger.error('Stream execution failed', {
              conversationId,
              messageId: assistantMessage.id,
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Service is disposed or intentionally cancelled - ensure message is marked as cancelled
          this.updateMessage(conversationId, assistantMessage.id, { status: 'cancelled' });
        }
      });

    return assistantMessage.id;
  }

  private processNextRequest(conversationId: ConversationId): void {
    const queue = this.requestQueue.get(conversationId);
    if (queue && queue.length > 0) {
      const nextRequest = queue.shift()!;
      // Fire and forget - the sendMessage will handle the promise
      this.sendMessage(conversationId, nextRequest.userContent, nextRequest.options)
        .then(nextRequest.resolve)
        .catch(nextRequest.reject);
    }
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
    },
    requestId: string
  ): Promise<void> {
    const providerId = options.provider ?? this.defaultProvider;
    const modelId = options.model ?? this.defaultModel;

    if (!providerId) {
      this.handleStreamError(conversationId, messageId, {
        code: 'NO_PROVIDER',
        message: 'No model provider configured',
        retryable: false,
      });
      return;
    }

    if (!modelId) {
      this.handleStreamError(conversationId, messageId, {
        code: 'NO_MODEL',
        message: 'No model selected',
        retryable: false,
      });
      return;
    }

    const provider = this.providerRegistry.get(providerId);
    if (!provider) {
      this.handleStreamError(conversationId, messageId, {
        code: 'PROVIDER_NOT_FOUND',
        message: `Provider ${providerId} not found`,
        retryable: false,
      });
      return;
    }

    const modelMetadata = provider.getModel(modelId);
    if (!modelMetadata) {
      this.handleStreamError(conversationId, messageId, {
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
      requestId,
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
        await this.executeStreamingProvider(
          provider,
          request,
          conversationId,
          messageId,
          signal,
          requestId
        );
      } else if (typeof provider.execute === 'function') {
        await this.executeNonStreamingProvider(
          provider,
          request,
          conversationId,
          messageId,
          signal,
          requestId
        );
      } else {
        this.handleStreamError(conversationId, messageId, {
          code: 'PROVIDER_NOT_SUPPORTED',
          message: 'Provider does not implement execute or executeStream',
          retryable: false,
        });
      }
    } catch (error) {
      // Validate that this request is still active (not cancelled/superseded)
      if (!this.activeRequests.has(requestId)) {
        this.logger.debug('Ignoring error from cancelled/superseded request', {
          conversationId,
          requestId,
        });
        return;
      }

      // Check for abort errors FIRST - these always result in cancelled status
      const isAbortError =
        signal.aborted ||
        error instanceof DOMException ||
        (error !== null &&
          typeof error === 'object' &&
          'name' in error &&
          (error.name === 'AbortError' || error.name === 'CancellationError')) ||
        (error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ABORT_ERR');

      if (isAbortError) {
        this.logger.info('Stream cancelled', { conversationId, messageId, requestId });
        this.eventEmitter.emit('stream:event', {
          event: createStreamCancelEvent(conversationId, messageId),
          timestamp: Date.now(),
        });
        this.updateMessage(conversationId, messageId, { status: 'cancelled' });
        return;
      }

      // Check current message status - if already cancelled, don't overwrite
      const currentMessage = this.getMessage(conversationId, messageId);
      if (currentMessage?.status === 'cancelled') {
        this.logger.debug('Message already cancelled, ignoring error', {
          conversationId,
          messageId,
          requestId,
        });
        return;
      }

      // Check if this stream was intentionally cancelled (by user or disposal)
      const stream = this.activeStreams.get(messageId);
      const intentionallyCancelled = stream?.intentionallyCancelled ?? false;

      // If intentionally cancelled, treat as cancellation regardless of error type
      if (intentionallyCancelled) {
        this.logger.info('Stream cancelled intentionally', {
          conversationId,
          messageId,
          requestId,
        });
        this.eventEmitter.emit('stream:event', {
          event: createStreamCancelEvent(conversationId, messageId),
          timestamp: Date.now(),
        });
        this.updateMessage(conversationId, messageId, { status: 'cancelled' });
        return;
      }

      // Genuine provider error - mark as failed
      this.logger.error('Stream execution error', {
        conversationId,
        messageId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.handleStreamError(conversationId, messageId, {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private async executeStreamingProvider(
    provider: ModelProvider,
    request: ModelRequest,
    conversationId: ConversationId,
    messageId: MessageId,
    signal: AbortSignal,
    requestId: string
  ): Promise<void> {
    if (!provider.executeStream) {
      throw new Error('Provider does not support streaming');
    }
    let hasCompleted = false;
    let accumulatedContent = '';

    for await (const event of provider.executeStream(request, signal)) {
      // Validate request is still active before processing
      if (!this.activeRequests.has(requestId)) {
        this.logger.debug('Ignoring event from cancelled/superseded request', {
          conversationId,
          requestId,
          eventType: event.type,
        });
        return;
      }

      // If service is disposed, stop processing events
      if (this._isDisposed) {
        this.logger.debug('Ignoring event - service disposed', {
          conversationId,
          requestId,
          eventType: event.type,
        });
        return;
      }

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
          this.logger.warn('Duplicate stream:complete event ignored', {
            conversationId,
            messageId,
          });
          continue;
        }
        // Don't overwrite cancelled status with completion
        const currentMessage = this.getMessage(conversationId, messageId);
        if (currentMessage?.status === 'cancelled') {
          this.logger.debug('Ignoring late stream:complete - message already cancelled', {
            conversationId,
            messageId,
          });
          break;
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
        // Don't overwrite cancelled status with error
        const currentMessage = this.getMessage(conversationId, messageId);
        if (currentMessage?.status === 'cancelled') {
          this.logger.debug('Ignoring late stream:error - message already cancelled', {
            conversationId,
            messageId,
          });
          break;
        }
        hasCompleted = true;
        this.handleStreamError(conversationId, messageId, event.error);
        break;
      }
    }

    // Handle case where generator completes without explicit completion event
    // (e.g., when signal is aborted and generator exits cleanly or throws AbortError)
    if (!hasCompleted) {
      const currentMessage = this.getMessage(conversationId, messageId);
      const alreadyCancelled = currentMessage?.status === 'cancelled';

      // Check if this stream was intentionally cancelled
      const stream = this.activeStreams.get(messageId);
      const intentionallyCancelled = stream?.intentionallyCancelled ?? false;

      if (signal.aborted || intentionallyCancelled) {
        this.logger.info('Stream cancelled (generator completed after abort)', {
          conversationId,
          messageId,
          requestId,
        });
        if (!alreadyCancelled) {
          this.eventEmitter.emit('stream:event', {
            event: createStreamCancelEvent(conversationId, messageId),
            timestamp: Date.now(),
          });
          this.updateMessage(conversationId, messageId, { status: 'cancelled' });
        }
      } else {
        this.updateMessage(conversationId, messageId, {
          content: accumulatedContent,
          status: 'completed',
        });
      }
    }
  }

  private async executeNonStreamingProvider(
    provider: ModelProvider,
    request: ModelRequest,
    conversationId: ConversationId,
    messageId: MessageId,
    signal: AbortSignal,
    requestId: string
  ): Promise<void> {
    this.updateMessage(conversationId, messageId, { status: 'streaming' });

    const resultPromise = provider.execute(request, signal);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new DOMException('Timeout', 'AbortError')), 30000)
    );

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);

      // Validate request is still active before processing result
      if (!this.activeRequests.has(requestId)) {
        this.logger.debug('Ignoring result from cancelled/superseded request', {
          conversationId,
          requestId,
        });
        return;
      }

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Don't overwrite cancelled status with completion
      const currentMessage = this.getMessage(conversationId, messageId);
      if (currentMessage?.status === 'cancelled') {
        this.logger.debug('Ignoring late non-streaming completion - message already cancelled', {
          conversationId,
          messageId,
        });
        return;
      }

      // ModelResponse has choices array with message.content per the provider contract
      const content =
        result.choices && result.choices.length > 0
          ? typeof result.choices[0]?.message.content === 'string'
            ? result.choices[0].message.content
            : ''
          : '';

      const completeEvent = createStreamCompleteEvent(
        conversationId,
        messageId,
        result.finishReason,
        result.usage
      );

      this.updateMessage(conversationId, messageId, {
        content,
        status: 'completed',
        metadata: {
          usage: result.usage,
          finishReason: result.finishReason,
        },
      });

      this.eventEmitter.emit('stream:event', { event: completeEvent, timestamp: Date.now() });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }
      // Don't overwrite cancelled status with error
      const currentMessage = this.getMessage(conversationId, messageId);
      if (currentMessage?.status === 'cancelled') {
        this.logger.debug('Ignoring late non-streaming error - message already cancelled', {
          conversationId,
          messageId,
        });
        return;
      }
      this.handleStreamError(conversationId, messageId, {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private handleStreamError(
    conversationId: ConversationId,
    messageId: MessageId,
    error: {
      code: string;
      message: string;
      retryable: boolean;
      providerErrorCode?: string | undefined;
    }
  ): void {
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
        stream.intentionallyCancelled = true;
        stream.controller.abort();
        this.activeStreams.delete(messageId);
        this.activeRequests.delete(stream.requestId);
        this.logger.info('Active stream cancelled', {
          conversationId,
          messageId,
          requestId: stream.requestId,
        });
        // Update message status to cancelled
        this.updateMessage(conversationId, messageId, { status: 'cancelled' });
        // Emit stream:cancel event
        this.eventEmitter.emit('stream:event', {
          event: createStreamCancelEvent(conversationId, messageId),
          timestamp: Date.now(),
        });
      }
    }
    // Clear any queued requests for this conversation
    this.clearRequestQueue(conversationId);
  }

  cancelMessage(messageId: MessageId): boolean {
    const stream = this.activeStreams.get(messageId);
    if (stream) {
      stream.intentionallyCancelled = true;
      stream.controller.abort();
      this.activeStreams.delete(messageId);
      this.activeRequests.delete(stream.requestId);
      this.logger.info('Message stream cancelled', { messageId, requestId: stream.requestId });
      // Emit stream:cancel event
      this.eventEmitter.emit('stream:event', {
        event: createStreamCancelEvent(stream.conversationId, messageId),
        timestamp: Date.now(),
      });
      this.updateMessage(stream.conversationId, messageId, { status: 'cancelled' });
      // If this was the primary request, process next in queue
      if (this.primaryRequestId.get(stream.conversationId) === stream.requestId) {
        this.primaryRequestId.delete(stream.conversationId);
        this.processNextRequest(stream.conversationId);
      }
      return true;
    }
    return false;
  }

  retryMessage(
    conversationId: ConversationId,
    messageId: MessageId
  ): Promise<MessageId | undefined> {
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

  dispose(): Promise<void> {
    this._isDisposed = true;
    const abortPromises: Array<Promise<void>> = [];
    const streamInfos: Array<{
      conversationId: ConversationId;
      messageId: MessageId;
      requestId: string;
      intentionallyCancelled: boolean;
    }> = [];
    // First, mark all streams as cancelled and update message status
    for (const stream of this.activeStreams.values()) {
      stream.intentionallyCancelled = true;
      // Update message status BEFORE aborting, so catch handlers see 'cancelled' status
      this.updateMessage(stream.conversationId, stream.messageId, { status: 'cancelled' });
      this.logger.info('Stream cancelled due to disposal', {
        conversationId: stream.conversationId,
        messageId: stream.messageId,
        requestId: stream.requestId,
      });
      streamInfos.push({
        conversationId: stream.conversationId,
        messageId: stream.messageId,
        requestId: stream.requestId,
        intentionallyCancelled: true,
      });
    }
    // Now abort all streams - this will trigger generators to throw
    for (const stream of this.activeStreams.values()) {
      stream.controller.abort();
      abortPromises.push(stream.promise.catch(() => {}));
    }
    // Reject all queued requests
    for (const queue of this.requestQueue.values()) {
      for (const req of queue) {
        req.reject(new EngineError(EngineErrorCode.INTERNAL_ERROR, 'ChatService disposed'));
      }
    }
    this.requestQueue.clear();
    this.eventEmitter.removeAllListeners();
    this.logger.info('ChatService disposed');
    // Ensure all cancelled streams have correct status after promises settle (fallback)
    // Use a timeout to avoid hanging on providers that ignore abort signals
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, 1000));
    return Promise.race([Promise.all(abortPromises), timeoutPromise]).then(() => {
      for (const info of streamInfos) {
        this.updateMessage(info.conversationId, info.messageId, { status: 'cancelled' });
      }
      // Now clear tracking maps after all streams have settled
      this.activeStreams.clear();
      this.activeRequests.clear();
      this.primaryRequestId.clear();
    });
  }
}

export function createChatService(options?: ChatServiceOptions): ChatService {
  return new ChatService(options);
}
