import { z } from 'zod';

export type ProviderId = string & { readonly __brand: unique symbol };
export type ModelId = string & { readonly __brand: unique symbol };

export function createProviderId(id: string): ProviderId {
  return id as ProviderId;
}

export function createModelId(id: string): ModelId {
  return id as ModelId;
}

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'document';

export const ModalitySchema = z.enum(['text', 'image', 'audio', 'video', 'document']);

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
}

export const ModelCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  toolCalling: z.boolean(),
  vision: z.boolean(),
  inputModalities: z.array(ModalitySchema),
  outputModalities: z.array(ModalitySchema),
});

export type ModelCapabilitiesInput = z.input<typeof ModelCapabilitiesSchema>;
export type ModelCapabilitiesOutput = z.output<typeof ModelCapabilitiesSchema>;

export interface PricingMetadata {
  readonly inputPricePerToken?: number | undefined;
  readonly outputPricePerToken?: number | undefined;
  readonly currency?: string | undefined;
  readonly pricingUnit?: '1k' | '1m' | undefined;
}

export const PricingMetadataSchema = z.object({
  inputPricePerToken: z.number().nonnegative().optional(),
  outputPricePerToken: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  pricingUnit: z.enum(['1k', '1m']).optional(),
});

export type PricingMetadataInput = z.input<typeof PricingMetadataSchema>;
export type PricingMetadataOutput = z.output<typeof PricingMetadataSchema>;

export interface ModelMetadata {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number | undefined;
  readonly capabilities: ModelCapabilities;
  readonly pricing?: PricingMetadata | undefined;
  readonly deprecated?: boolean | undefined;
  readonly releaseDate?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const ModelMetadataSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string().min(1),
  description: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: ModelCapabilitiesSchema,
  pricing: PricingMetadataSchema.optional(),
  deprecated: z.boolean().optional(),
  releaseDate: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ModelMetadataInput = z.input<typeof ModelMetadataSchema>;
export type ModelMetadataOutput = z.output<typeof ModelMetadataSchema>;

export interface ProviderMetadata {
  readonly id: ProviderId;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly homepage?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const ProviderMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  homepage: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ProviderMetadataInput = z.input<typeof ProviderMetadataSchema>;
export type ProviderMetadataOutput = z.output<typeof ProviderMetadataSchema>;

export interface ProviderHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly lastChecked: number;
  readonly latencyMs?: number | undefined;
  readonly error?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const ProviderHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  lastChecked: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ProviderHealthInput = z.input<typeof ProviderHealthSchema>;
export type ProviderHealthOutput = z.output<typeof ProviderHealthSchema>;

export interface ModelRequest {
  readonly model: ModelId;
  readonly messages: readonly ModelMessage[];
  readonly parameters?: GenerationParameters | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const ModelMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(z.unknown()).optional(),
});

export type ModelMessage = z.output<typeof ModelMessageSchema>;
export type ModelMessageInput = z.input<typeof ModelMessageSchema>;

export interface GenerationParameters {
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
  readonly topK?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly minTokens?: number | undefined;
  readonly stopSequences?: readonly string[] | undefined;
  readonly presencePenalty?: number | undefined;
  readonly frequencyPenalty?: number | undefined;
  readonly seed?: number | undefined;
  readonly responseFormat?: 'text' | 'json' | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const GenerationParametersSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  minTokens: z.number().int().nonnegative().optional(),
  stopSequences: z.array(z.string()).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type GenerationParametersInput = z.input<typeof GenerationParametersSchema>;
export type GenerationParametersOutput = z.output<typeof GenerationParametersSchema>;

export interface ModelResponse {
  readonly id: string;
  readonly model: ModelId;
  readonly choices: readonly ModelChoice[];
  readonly usage: UsageStatistics;
  readonly finishReason: FinishReason;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ModelChoice {
  readonly index: number;
  readonly message: ModelMessage;
  readonly finishReason: FinishReason;
}

export const ModelChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: ModelMessageSchema,
  finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error', 'other']),
});

export type ModelChoiceOutput = z.output<typeof ModelChoiceSchema>;

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other';

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
  'other',
]);

export interface UsageStatistics {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export const UsageStatisticsSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UsageStatisticsInput = z.input<typeof UsageStatisticsSchema>;
export type UsageStatisticsOutput = z.output<typeof UsageStatisticsSchema>;

export const ModelRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ModelMessageSchema),
  parameters: GenerationParametersSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ModelRequestInput = z.input<typeof ModelRequestSchema>;
export type ModelRequestOutput = z.output<typeof ModelRequestSchema>;

export const ModelResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(ModelChoiceSchema),
  usage: UsageStatisticsSchema,
  finishReason: FinishReasonSchema,
  metadata: z.record(z.unknown()).optional(),
});

export type ModelResponseInput = z.input<typeof ModelResponseSchema>;
export type ModelResponseOutput = z.output<typeof ModelResponseSchema>;

export interface ProviderCredentials {
  readonly providerId: ProviderId;
  readonly credentials: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Credential storage interface. Implementations store and retrieve the actual
 * credential values. Secret redaction is a logging/diagnostic concern and must
 * not alter values returned by `get`.
 */
export interface CredentialStore {
  get(providerId: ProviderId): Promise<ProviderCredentials | undefined>;
  set(credentials: ProviderCredentials): Promise<void>;
  delete(providerId: ProviderId): Promise<boolean>;
  list(): Promise<ProviderId[]>;
}

export interface ModelProvider {
  readonly metadata: ProviderMetadata;

  initialize(credentials: ProviderCredentials): Promise<void>;
  dispose(): Promise<void>;

  listModels(): readonly ModelMetadata[];
  getModel(modelId: ModelId): ModelMetadata | undefined;
  validateRequest(request: ModelRequest): Promise<ValidationResult>;

  execute(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;

  healthCheck(): Promise<ProviderHealth>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings?: readonly ValidationWarning[] | undefined;
}

export interface ValidationError {
  readonly code: string;
  readonly message: string;
  readonly path?: ReadonlyArray<string | number> | undefined;
}

export interface ValidationWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: ReadonlyArray<string | number> | undefined;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): void;
  unregister(providerId: ProviderId): Promise<boolean>;
  get(providerId: ProviderId): ModelProvider | undefined;
  list(): readonly ModelProvider[];
  has(providerId: ProviderId): boolean;
  getModel(providerId: ProviderId, modelId: ModelId): ModelMetadata | undefined;
  listModels(providerId?: ProviderId): readonly ModelMetadata[];
  validateProvider(providerId: ProviderId): Promise<ValidationResult>;
}
