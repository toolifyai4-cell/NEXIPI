export {
  PersistenceService as PersistenceFoundation,
  PersistenceError,
  ConversationValidationSchema,
  MessageValidationSchema,
  Conversation as FoundationConversation,
  Message as FoundationMessage,
  validateConversation,
  validateMessage,
  createConversationId,
  createMessageId,
  SQLDatabase,
} from './PersistenceService.js';

export {
  ConversationRepository,
  MessageRepository,
  SqlJsConversationRepository,
  SqlJsMessageRepository,
  CreateConversationInput as RepoCreateConversationInput,
  UpdateConversationInput as RepoUpdateConversationInput,
  CreateMessageInput as RepoCreateMessageInput,
  UpdateMessageInput as RepoUpdateMessageInput,
  ConversationResult as RepoConversationResult,
  ConversationListResult as RepoConversationListResult,
  MessageResult as RepoMessageResult,
  MessageListResult as RepoMessageListResult,
  DeleteResult as RepoDeleteResult,
  ConversationRecord,
  MessageRecord,
} from './repositories.js';

export {
  IPersistencePort,
  PersistencePort,
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

export {
  PersistenceService,
  createPersistenceService,
} from './PersistenceServiceWrapper.js';
