import { z } from 'zod';

export type ModelId = string & { readonly __brand: unique symbol };
export type UsageStatistics = {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
};

export type StreamEventType =
  'stream:start' | 'stream:delta' | 'stream:complete' | 'stream:error' | 'stream:cancel';

export interface StreamEventMap {
  'stream:start': StreamStartEvent;
  'stream:delta': StreamDeltaEvent;
  'stream:complete': StreamCompleteEvent;
  'stream:error': StreamErrorEvent;
  'stream:cancel': StreamCancelEvent;
}

export interface StreamStartEvent {
  readonly type: 'stream:start';
  readonly conversationId: string;
  readonly messageId: string;
  readonly model: ModelId;
  readonly timestamp: number;
}

export interface StreamDeltaEvent {
  readonly type: 'stream:delta';
  readonly conversationId: string;
  readonly messageId: string;
  readonly delta: string;
  readonly timestamp: number;
}

export interface StreamCompleteEvent {
  readonly type: 'stream:complete';
  readonly conversationId: string;
  readonly messageId: string;
  readonly usage?: UsageStatistics | undefined;
  readonly finishReason: string;
  readonly timestamp: number;
}

export interface StreamErrorEvent {
  readonly type: 'stream:error';
  readonly conversationId: string;
  readonly messageId: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly providerErrorCode?: string | undefined;
  };
  readonly timestamp: number;
}

export interface StreamCancelEvent {
  readonly type: 'stream:cancel';
  readonly conversationId: string;
  readonly messageId: string;
  readonly timestamp: number;
}

export type StreamEvent =
  StreamStartEvent | StreamDeltaEvent | StreamCompleteEvent | StreamErrorEvent | StreamCancelEvent;

export const StreamStartEventSchema = z.object({
  type: z.literal('stream:start'),
  conversationId: z.string(),
  messageId: z.string(),
  model: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export const StreamDeltaEventSchema = z.object({
  type: z.literal('stream:delta'),
  conversationId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export const StreamCompleteEventSchema = z.object({
  type: z.literal('stream:complete'),
  conversationId: z.string(),
  messageId: z.string(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative().optional(),
      completionTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      cachedTokens: z.number().int().nonnegative().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
  finishReason: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export const StreamErrorEventSchema = z.object({
  type: z.literal('stream:error'),
  conversationId: z.string(),
  messageId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    providerErrorCode: z.string().optional(),
  }),
  timestamp: z.number().int().nonnegative(),
});

export const StreamCancelEventSchema = z.object({
  type: z.literal('stream:cancel'),
  conversationId: z.string(),
  messageId: z.string(),
  timestamp: z.number().int().nonnegative(),
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  StreamStartEventSchema,
  StreamDeltaEventSchema,
  StreamCompleteEventSchema,
  StreamErrorEventSchema,
  StreamCancelEventSchema,
]);

export type StreamEventInput = z.input<typeof StreamEventSchema>;
export type StreamEventOutput = z.output<typeof StreamEventSchema>;

export function createStreamStartEvent(
  conversationId: string,
  messageId: string,
  model: ModelId
): StreamStartEvent {
  return {
    type: 'stream:start',
    conversationId,
    messageId,
    model,
    timestamp: Date.now(),
  };
}

export function createStreamDeltaEvent(
  conversationId: string,
  messageId: string,
  delta: string
): StreamDeltaEvent {
  return {
    type: 'stream:delta',
    conversationId,
    messageId,
    delta,
    timestamp: Date.now(),
  };
}

export function createStreamCompleteEvent(
  conversationId: string,
  messageId: string,
  finishReason: string,
  usage?: UsageStatistics
): StreamCompleteEvent {
  return {
    type: 'stream:complete',
    conversationId,
    messageId,
    usage,
    finishReason,
    timestamp: Date.now(),
  };
}

export function createStreamErrorEvent(
  conversationId: string,
  messageId: string,
  error: {
    code: string;
    message: string;
    retryable: boolean;
    providerErrorCode?: string | undefined;
  }
): StreamErrorEvent {
  return {
    type: 'stream:error',
    conversationId,
    messageId,
    error,
    timestamp: Date.now(),
  };
}

export function createStreamCancelEvent(
  conversationId: string,
  messageId: string
): StreamCancelEvent {
  return {
    type: 'stream:cancel',
    conversationId,
    messageId,
    timestamp: Date.now(),
  };
}

export function validateStreamEvent(event: unknown): StreamEventOutput {
  return StreamEventSchema.parse(event);
}

export function safeValidateStreamEvent(
  event: unknown
): { success: true; data: StreamEventOutput } | { success: false; error: z.ZodError } {
  const result = StreamEventSchema.safeParse(event);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

export interface StreamingProvider {
  executeStream(
    request: {
      readonly model: ModelId;
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
      readonly parameters?: Record<string, unknown> | undefined;
    },
    signal?: AbortSignal
  ): AsyncIterable<StreamDeltaEvent | StreamCompleteEvent | StreamErrorEvent>;
}

export interface NonStreamingProvider {
  execute(
    request: {
      readonly model: ModelId;
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
      readonly parameters?: Record<string, unknown> | undefined;
    },
    signal?: AbortSignal
  ): Promise<{
    readonly content: string;
    readonly usage?: UsageStatistics | undefined;
    readonly finishReason: string;
  }>;
}

export type ProviderExecutor = StreamingProvider | NonStreamingProvider;

export function isStreamingProvider(provider: ProviderExecutor): provider is StreamingProvider {
  return typeof (provider as StreamingProvider).executeStream === 'function';
}

export function isNonStreamingProvider(
  provider: ProviderExecutor
): provider is NonStreamingProvider {
  return typeof (provider as NonStreamingProvider).execute === 'function';
}
