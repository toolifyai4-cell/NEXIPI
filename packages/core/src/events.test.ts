import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, createEventEmitter, type EventMap } from './events.js';

interface TestEvents extends EventMap {
  'test:event': { value: number };
  'test:other': { message: string };
}

describe('events', () => {
  describe('EventEmitter', () => {
    it('should register and emit events', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();
      emitter.on('test:event', listener);
      emitter.emit('test:event', { value: 42 });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ value: 42 });
    });

    it('should support multiple listeners for same event', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      emitter.on('test:event', listener1);
      emitter.on('test:event', listener2);
      emitter.emit('test:event', { value: 1 });
      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should unsubscribe listener', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();
      const subscription = emitter.on('test:event', listener);
      subscription.unsubscribe();
      emitter.emit('test:event', { value: 1 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should return false when unsubscribing non-existent listener', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();
      const result = emitter.off('test:event', listener);
      expect(result).toBe(false);
    });

    it('should return true when unsubscribing existing listener', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();
      emitter.on('test:event', listener);
      const result = emitter.off('test:event', listener);
      expect(result).toBe(true);
    });

    it('should not emit to removed listeners', () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener = vi.fn();
      emitter.on('test:event', listener);
      emitter.off('test:event', listener);
      emitter.emit('test:event', { value: 1 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', () => {
      const onListenerError = vi.fn();
      const emitter = new EventEmitter<TestEvents>({ onListenerError });
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();
      emitter.on('test:event', errorListener);
      emitter.on('test:event', goodListener);
      emitter.emit('test:event', { value: 1 });
      expect(goodListener).toHaveBeenCalledOnce();
      expect(onListenerError).toHaveBeenCalledOnce();
    });

    it('should handle async listener errors', async () => {
      const onListenerError = vi.fn();
      const emitter = new EventEmitter<TestEvents>({ onListenerError });
      const errorListener = vi.fn(async () => {
        throw new Error('Async listener error');
      });
      const goodListener = vi.fn();
      emitter.on('test:event', errorListener);
      emitter.on('test:event', goodListener);
      emitter.emit('test:event', { value: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(goodListener).toHaveBeenCalledOnce();
      expect(onListenerError).toHaveBeenCalledOnce();
    });

    it('should support emitAsync', async () => {
      const emitter = new EventEmitter<TestEvents>();
      const listener1 = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      const listener2 = vi.fn();
      emitter.on('test:event', listener1);
      emitter.on('test:event', listener2);
      await emitter.emitAsync('test:event', { value: 1 });
      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should return listener count', () => {
      const emitter = new EventEmitter<TestEvents>();
      expect(emitter.listenerCount('test:event')).toBe(0);
      emitter.on('test:event', vi.fn());
      expect(emitter.listenerCount('test:event')).toBe(1);
      emitter.on('test:event', vi.fn());
      expect(emitter.listenerCount('test:event')).toBe(2);
    });

    it('should return event names', () => {
      const emitter = new EventEmitter<TestEvents>();
      emitter.on('test:event', vi.fn());
      emitter.on('test:other', vi.fn());
      const names = emitter.eventNames();
      expect(names).toContain('test:event');
      expect(names).toContain('test:other');
      expect(names.length).toBe(2);
    });

    it('should remove all listeners for event', () => {
      const emitter = new EventEmitter<TestEvents>();
      emitter.on('test:event', vi.fn());
      emitter.on('test:event', vi.fn());
      emitter.removeAllListeners('test:event');
      expect(emitter.listenerCount('test:event')).toBe(0);
      expect(emitter.listenerCount('test:other')).toBe(0);
    });

    it('should remove all listeners when no event specified', () => {
      const emitter = new EventEmitter<TestEvents>();
      emitter.on('test:event', vi.fn());
      emitter.on('test:other', vi.fn());
      emitter.removeAllListeners();
      expect(emitter.listenerCount('test:event')).toBe(0);
      expect(emitter.listenerCount('test:other')).toBe(0);
    });
  });

  describe('createEventEmitter', () => {
    it('should create EventEmitter instance', () => {
      const emitter = createEventEmitter<TestEvents>();
      expect(emitter).toBeInstanceOf(EventEmitter);
    });
  });
});