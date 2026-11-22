import {
  IPersistencePort,
  CreateConversationInput,
  UpdateConversationInput,
  Conversation,
  ConversationResult,
  ConversationListResult,
  CreateMessageInput,
  UpdateMessageInput,
  Message,
  MessageResult,
  MessageListResult,
  DeleteResult,
} from './port.js';
import {
  ConversationRepository,
  MessageRepository,
  ConversationRecord,
  MessageRecord,
  CreateConversationInput as RepoCreateConversationInput,
  UpdateConversationInput as RepoUpdateConversationInput,
  CreateMessageInput as RepoCreateMessageInput,
  UpdateMessageInput as RepoUpdateMessageInput,
  ConversationResult as RepoConversationResult,
  ConversationListResult as RepoConversationListResult,
  MessageResult as RepoMessageResult,
  MessageListResult as RepoMessageListResult,
  DeleteResult as RepoDeleteResult,
} from './repositories.js';
import { PersistenceError, PersistenceService as FoundationPersistenceService } from './PersistenceService.js';
import { ConversationId, MessageId } from '@nexipi/shared';

function toRepoConversationInput(input: CreateConversationInput): RepoCreateConversationInput {
  return {
    id: input.id,
    workspace_id: input.workspaceId,
    title: input.title,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    metadata: input.metadata,
  };
}

function toRepoUpdateConversationInput(input: UpdateConversationInput): RepoUpdateConversationInput {
  return {
    title: input.title,
    metadata: input.metadata,
  };
}

function toRepoMessageInput(input: CreateMessageInput): RepoCreateMessageInput {
  return {
    id: input.id,
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    status: input.status,
    timestamp: input.timestamp,
    seq: input.seq,
    metadata: input.metadata,
  };
}

function toRepoUpdateMessageInput(input: UpdateMessageInput): RepoUpdateMessageInput {
  return {
    content: input.content,
    status: input.status,
    metadata: input.metadata,
  };
}

function fromConversationRecord(record: ConversationRecord): Conversation {
  return {
    id: record.id as ConversationId,
    workspaceId: record.workspace_id,
    title: record.title,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    metadata: record.metadata,
  };
}

function fromMessageRecord(record: MessageRecord): Message {
  return {
    id: record.id as MessageId,
    conversationId: record.conversation_id as ConversationId,
    role: record.role,
    content: record.content,
    status: record.status,
    timestamp: record.timestamp,
    seq: record.seq,
    metadata: record.metadata,
  };
}

function fromRepoConversationResult(result: RepoConversationResult): ConversationResult {
  return {
    conversation: result.conversation ? fromConversationRecord(result.conversation) : null,
    error: result.error,
  };
}

function fromRepoConversationListResult(result: RepoConversationListResult): ConversationListResult {
  return {
    conversations: result.conversations.map(fromConversationRecord),
    error: result.error,
  };
}

function fromRepoMessageResult(result: RepoMessageResult): MessageResult {
  return {
    message: result.message ? fromMessageRecord(result.message) : null,
    error: result.error,
  };
}

function fromRepoMessageListResult(result: RepoMessageListResult): MessageListResult {
  return {
    messages: result.messages.map(fromMessageRecord),
    error: result.error,
  };
}

function fromRepoDeleteResult(result: RepoDeleteResult): DeleteResult {
  return {
    deleted: result.deleted,
    error: result.error,
  };
}

export class PersistenceService implements IPersistencePort {
  private readonly conversationRepository: ConversationRepository;
  private readonly messageRepository: MessageRepository;
  private readonly foundationService: FoundationPersistenceService;
  private readonly ownsFoundationService: boolean;
  private disposed = false;

  constructor(
    conversationRepository: ConversationRepository,
    messageRepository: MessageRepository,
    foundationService?: FoundationPersistenceService
  ) {
    this.conversationRepository = conversationRepository;
    this.messageRepository = messageRepository;
    this.foundationService = foundationService ?? new FoundationPersistenceService();
    this.ownsFoundationService = foundationService === undefined;
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new PersistenceError('Cannot initialize: service has been disposed');
    }
    if (this.ownsFoundationService) {
      await this.foundationService.init();
    }
  }

  isAvailable(): boolean {
    if (this.disposed) {
      return false;
    }
    return this.foundationService.isInitialized();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.ownsFoundationService) {
      this.foundationService.close();
    }
  }

  async createConversation(input: CreateConversationInput): Promise<ConversationResult> {
    this.assertAvailable();
    const result = await this.conversationRepository.create(toRepoConversationInput(input));
    return fromRepoConversationResult(result);
  }

  async getConversation(id: ConversationId): Promise<ConversationResult> {
    this.assertAvailable();
    const result = await this.conversationRepository.getById(id);
    return fromRepoConversationResult(result);
  }

  async listConversations(workspaceId?: string): Promise<ConversationListResult> {
    this.assertAvailable();
    const result = await this.conversationRepository.list(workspaceId);
    return fromRepoConversationListResult(result);
  }

  async updateConversation(id: ConversationId, input: UpdateConversationInput): Promise<ConversationResult> {
    this.assertAvailable();
    const result = await this.conversationRepository.update(id, toRepoUpdateConversationInput(input));
    return fromRepoConversationResult(result);
  }

  async deleteConversation(id: ConversationId): Promise<DeleteResult> {
    this.assertAvailable();
    const result = await this.conversationRepository.delete(id);
    return fromRepoDeleteResult(result);
  }

  async createMessage(input: CreateMessageInput): Promise<MessageResult> {
    this.assertAvailable();
    const result = await this.messageRepository.create(toRepoMessageInput(input));
    return fromRepoMessageResult(result);
  }

  async getMessage(id: MessageId): Promise<MessageResult> {
    this.assertAvailable();
    const result = await this.messageRepository.getById(id);
    return fromRepoMessageResult(result);
  }

  async getMessagesByConversationId(conversationId: ConversationId): Promise<MessageListResult> {
    this.assertAvailable();
    const result = await this.messageRepository.getByConversationId(conversationId);
    return fromRepoMessageListResult(result);
  }

  async updateMessage(id: MessageId, input: UpdateMessageInput): Promise<MessageResult> {
    this.assertAvailable();
    const result = await this.messageRepository.update(id, toRepoUpdateMessageInput(input));
    return fromRepoMessageResult(result);
  }

  async deleteMessage(id: MessageId): Promise<DeleteResult> {
    this.assertAvailable();
    const result = await this.messageRepository.delete(id);
    return fromRepoDeleteResult(result);
  }

  async deleteMessagesByConversationId(conversationId: ConversationId): Promise<DeleteResult> {
    this.assertAvailable();
    const result = await this.messageRepository.deleteByConversationId(conversationId);
    return fromRepoDeleteResult(result);
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new PersistenceError('Persistence service has been disposed');
    }
    if (!this.foundationService.isInitialized()) {
      throw new PersistenceError('Persistence not initialized. Call initialize() first.');
    }
  }
}

export function createPersistenceService(
  conversationRepository: ConversationRepository,
  messageRepository: MessageRepository,
  foundationService?: FoundationPersistenceService
): PersistenceService {
  return new PersistenceService(conversationRepository, messageRepository, foundationService);
}