import { createEventEmitter, type EventMap, type EventName, type EventEmitter, type EventSubscription } from '@nexipi/core';
import type { Workspace, WorkspaceChangeEvent } from '../types.js';

export interface WorkspaceEventMap extends EventMap {
  'workspace:discovered': { workspace: Workspace; timestamp: number };
  'workspace:changed': { event: WorkspaceChangeEvent; timestamp: number };
  'workspace:error': { error: Error; context: string; timestamp: number };
}

export type WorkspaceEventName = EventName & keyof WorkspaceEventMap;

export interface WorkspaceEventEmitter extends EventEmitter<WorkspaceEventMap> {
  on<T extends WorkspaceEventName>(
    eventName: T,
    listener: (payload: WorkspaceEventMap[T]) => void | Promise<void>
  ): EventSubscription;

  off<T extends WorkspaceEventName>(
    eventName: T,
    listener: (payload: WorkspaceEventMap[T]) => void | Promise<void>
  ): boolean;

  emit<T extends WorkspaceEventName>(eventName: T, payload: WorkspaceEventMap[T]): void;

  emitAsync<T extends WorkspaceEventName>(eventName: T, payload: WorkspaceEventMap[T]): Promise<void[]>;
}

export function createWorkspaceEventEmitter(): WorkspaceEventEmitter {
  return createEventEmitter<WorkspaceEventMap>();
}