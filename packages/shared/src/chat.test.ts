import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConversationId,
  createMessageId,
  type MessageRole,
  type MessageStatus,
  type Conversation,
  type Message,
  createConversation,
  createMessage,
  updateMessageStatus,
  appendMessageContent,
  isMessageTerminal,
  isMessageActive,
  validateMessage,
  validateConversation,
  safeValidateMessage,
  safeValidateConversation,
} from './chat.js';

describe('chat types', () => {
  describe('createConversationId', () => {
    it('should create a branded conversation ID', () => {
      const id = createConversationId('test-123');
      expect(id).toBe('test-123');
    });
  });

  describe('createMessageId', () => {
    it('should create a branded message ID', () => {
      const id = createMessageId('msg-456');
      expect(id).toBe('msg-456');
    });
  });

  describe('createConversation', () => {
    it('should create a conversation with default title', () => {
      const id = createConversationId('conv-1');
      const conversation = createConversation(id);

      expect(conversation.id).toBe(id);
      expect(conversation.title).toBe('New Conversation');
      expect(conversation.createdAt).toBeGreaterThan(0);
      expect(conversation.updatedAt).toBe(conversation.createdAt);
    });

    it('should create a conversation with custom title', () => {
      const id = createConversationId('conv-2');
      const conversation = createConversation(id, 'Custom Title');

      expect(conversation.title).toBe('Custom Title');
    });
  });

  describe('createMessage', () => {
    it('should create a user message with pending status', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'user', 'Hello');

      expect(message.id).toBeDefined();
      expect(message.conversationId).toBe(conversationId);
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello');
      expect(message.status).toBe('pending');
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it('should create an assistant message with custom status', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', 'Hi there', 'streaming');

      expect(message.role).toBe('assistant');
      expect(message.status).toBe('streaming');
    });

    it('should include metadata when provided', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'user', 'Test', 'pending', { source: 'test' });

      expect(message.metadata).toEqual({ source: 'test' });
    });
  });

  describe('updateMessageStatus', () => {
    it('should update message status', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', '', 'pending');
      const updated = updateMessageStatus(message, 'streaming');

      expect(updated.status).toBe('streaming');
      expect(updated.content).toBe('');
      expect(updated.metadata?.statusUpdatedAt).toBeDefined();
    });

    it('should update message content when provided', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', 'Hello', 'streaming');
      const updated = updateMessageStatus(message, 'completed', 'Hello world');

      expect(updated.status).toBe('completed');
      expect(updated.content).toBe('Hello world');
    });

    it('should preserve original message properties', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', 'Test', 'pending', { custom: 'data' });
      const updated = updateMessageStatus(message, 'completed');

      expect(updated.id).toBe(message.id);
      expect(updated.conversationId).toBe(message.conversationId);
      expect(updated.role).toBe(message.role);
      expect(updated.timestamp).toBe(message.timestamp);
      expect(updated.metadata?.custom).toBe('data');
    });
  });

  describe('appendMessageContent', () => {
    it('should append delta to message content', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', 'Hello', 'streaming');
      const updated = appendMessageContent(message, ' world');

      expect(updated.content).toBe('Hello world');
      expect(updated.metadata?.lastDeltaAt).toBeDefined();
    });

    it('should preserve other message properties', () => {
      const conversationId = createConversationId('conv-1');
      const message = createMessage(conversationId, 'assistant', 'Start', 'streaming', { foo: 'bar' });
      const updated = appendMessageContent(message, ' middle');

      expect(updated.id).toBe(message.id);
      expect(updated.role).toBe('assistant');
      expect(updated.status).toBe('streaming');
      expect(updated.metadata?.foo).toBe('bar');
    });
  });

  describe('isMessageTerminal', () => {
    it('should return true for completed status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'done', 'completed');
      expect(isMessageTerminal(message)).toBe(true);
    });

    it('should return true for failed status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'error', 'failed');
      expect(isMessageTerminal(message)).toBe(true);
    });

    it('should return true for cancelled status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'stopped', 'cancelled');
      expect(isMessageTerminal(message)).toBe(true);
    });

    it('should return false for pending status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'waiting', 'pending');
      expect(isMessageTerminal(message)).toBe(false);
    });

    it('should return false for streaming status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'generating', 'streaming');
      expect(isMessageTerminal(message)).toBe(false);
    });
  });

  describe('isMessageActive', () => {
    it('should return true for pending status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'waiting', 'pending');
      expect(isMessageActive(message)).toBe(true);
    });

    it('should return true for streaming status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'generating', 'streaming');
      expect(isMessageActive(message)).toBe(true);
    });

    it('should return false for completed status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'done', 'completed');
      expect(isMessageActive(message)).toBe(false);
    });

    it('should return false for failed status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'error', 'failed');
      expect(isMessageActive(message)).toBe(false);
    });

    it('should return false for cancelled status', () => {
      const message = createMessage(createConversationId('c'), 'assistant', 'stopped', 'cancelled');
      expect(isMessageActive(message)).toBe(false);
    });
  });

  describe('validateMessage', () => {
    it('should validate a complete message', () => {
      const message = createMessage(createConversationId('c'), 'user', 'Hello', 'completed');
      const validated = validateMessage(message);

      expect(validated).toEqual(message);
    });

    it('should throw on invalid role', () => {
      const message = createMessage(createConversationId('c'), 'user', 'Hello', 'completed');
      const invalid = { ...message, role: 'invalid' as MessageRole };

      expect(() => validateMessage(invalid)).toThrow();
    });

    it('should throw on invalid status', () => {
      const message = createMessage(createConversationId('c'), 'user', 'Hello', 'completed');
      const invalid = { ...message, status: 'invalid' as MessageStatus };

      expect(() => validateMessage(invalid)).toThrow();
    });

    it('should throw on missing required fields', () => {
      expect(() => validateMessage({})).toThrow();
    });
  });

  describe('validateConversation', () => {
    it('should validate a complete conversation', () => {
      const conversation = createConversation(createConversationId('c'), 'Test');
      const validated = validateConversation(conversation);

      expect(validated).toEqual(conversation);
    });

    it('should use default title when not provided', () => {
      const conversation = createConversation(createConversationId('c'));
      const validated = validateConversation(conversation);

      expect(validated.title).toBe('New Conversation');
    });

    it('should throw on missing required fields', () => {
      expect(() => validateConversation({})).toThrow();
    });
  });

  describe('safeValidateMessage', () => {
    it('should return success for valid message', () => {
      const message = createMessage(createConversationId('c'), 'user', 'Hello', 'completed');
      const result = safeValidateMessage(message);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    });

    it('should return failure for invalid message', () => {
      const result = safeValidateMessage({ role: 'invalid' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });

  describe('safeValidateConversation', () => {
    it('should return success for valid conversation', () => {
      const conversation = createConversation(createConversationId('c'), 'Test');
      const result = safeValidateConversation(conversation);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(conversation);
      }
    });

    it('should return failure for invalid conversation', () => {
      const result = safeValidateConversation({ id: 123 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });
});