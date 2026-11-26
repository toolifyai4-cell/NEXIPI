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
  PersistenceServiceOptions,
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
  ProposalRepository,
  SqlJsProposalRepository,
  ProposalRecord,
  CreateProposalInput,
  ProposalResult,
  ProposalListResult,
  ProposalListFilter,
  ProposalStatusSchema,
  type ProposalStatus,
  executeInTransaction,
} from './proposal-repository.js';

export {
  ApprovalRepository,
  SqlJsApprovalRepository,
  ApprovalRecord,
  CreateApprovalInput,
  ApprovalResult,
  ApprovalListResult,
  ApprovalListFilter,
  ApprovalLifecycleStateSchema,
  ApprovalDecisionSchema,
  ContentHashSchema,
  ApprovalProvenanceSchema,
  type ApprovalLifecycleState,
  type ApprovalDecision,
  type ApprovalProvenance,
} from './approval-repository.js';

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
  PersistenceService as PersistencePortService,
  createPersistenceService,
} from './PersistenceServiceWrapper.js';
