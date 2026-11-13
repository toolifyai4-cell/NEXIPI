export type EventName = string;

export interface EventMap {
  [eventName: EventName]: unknown;
}

export type EventListener<T extends EventName, E extends EventMap> = (
  payload: E[T]
) => void | Promise<void>;

export interface EventSubscription {
  unsubscribe: () => void;
}

export interface EventEmitterOptions {
  onListenerError?: (error: Error, eventName: EventName, payload: unknown) => void;
}

export class EventEmitter<E extends EventMap = EventMap> {
  private readonly listeners: Map<EventName, Set<EventListener<EventName, E>>> = new Map();
  private readonly options: EventEmitterOptions;

  constructor(options: EventEmitterOptions = {}) {
    this.options = options;
  }

  on<T extends EventName>(eventName: T, listener: EventListener<T, E>): EventSubscription {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(listener as EventListener<EventName, E>);

    return {
      unsubscribe: () => this.off(eventName, listener),
    };
  }

  off<T extends EventName>(eventName: T, listener: EventListener<T, E>): boolean {
    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners) {
      return false;
    }
    const result = eventListeners.delete(listener as EventListener<EventName, E>);
    if (eventListeners.size === 0) {
      this.listeners.delete(eventName);
    }
    return result;
  }

  emit<T extends EventName>(eventName: T, payload: E[T]): void {
    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners || eventListeners.size === 0) {
      return;
    }

    const listenersSnapshot = [...eventListeners];
    for (const listener of listenersSnapshot) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) =>
            this.handleListenerError(error as Error, eventName, payload)
          );
        }
      } catch (error) {
        this.handleListenerError(error as Error, eventName, payload);
      }
    }
  }

  emitAsync<T extends EventName>(eventName: T, payload: E[T]): Promise<void[]> {
    const eventListeners = this.listeners.get(eventName);
    if (!eventListeners || eventListeners.size === 0) {
      return Promise.resolve([]);
    }

    const listenersSnapshot = [...eventListeners];
    const promises: Array<Promise<void>> = [];
    for (const listener of listenersSnapshot) {
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          promises.push(
            result.catch((error: unknown) =>
              this.handleListenerError(error as Error, eventName, payload)
            )
          );
        } else {
          promises.push(Promise.resolve());
        }
      } catch (error) {
        this.handleListenerError(error as Error, eventName, payload);
        promises.push(Promise.resolve());
      }
    }

    return Promise.all(promises);
  }

  listenerCount(eventName: EventName): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }

  eventNames(): EventName[] {
    return Array.from(this.listeners.keys());
  }

  removeAllListeners(eventName?: EventName): void {
    if (eventName) {
      this.listeners.delete(eventName);
    } else {
      this.listeners.clear();
    }
  }

  private handleListenerError(error: Error, eventName: EventName, payload: unknown): void {
    if (this.options.onListenerError) {
      try {
        this.options.onListenerError(error, eventName, payload);
      } catch {
        // Ignore errors in error handler
      }
    }
  }
}

export function createEventEmitter<E extends EventMap = EventMap>(
  options?: EventEmitterOptions
): EventEmitter<E> {
  return new EventEmitter<E>(options);
}
