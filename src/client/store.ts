'use client';
import { get, set, del } from 'idb-keyval';
import type { ImportJob } from './import-job';
import type { Library, Operation } from '../domain/types';
import { applyOperation, deletionBaseRecords } from '../domain/operations';
export type Snapshot = {
  library: Library;
  revision: string;
  diagnostics?: (string | { message: string; path?: string })[];
  mode: 'local' | 'github';
  syncStatus?: 'idle' | 'syncing' | 'synced' | 'error';
  syncError?: string;
};
export type Cache = { snapshot: Snapshot; pending: Operation[]; importJob?: ImportJob };
export function replay(snapshot: Snapshot, pending: Operation[]): Snapshot {
  let library = snapshot.library;
  for (const op of pending) {
    try {
      library = applyOperation(library, op);
    } catch {
      /* Server reports invalid operations without destroying queued work. */
    }
  }
  return { ...snapshot, library };
}
export const readCache = (scope: string) => get<Cache>(`gitdrop:${scope}`);
export const writeCache = (scope: string, value: Cache) => set(`gitdrop:${scope}`, value);
export const clearCache = (scope: string) => del(`gitdrop:${scope}`);
export function actorId() {
  let id = localStorage.getItem('gitdrop:actor');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('gitdrop:actor', id);
  }
  return id;
}

export function confirmedStatus(snapshot?: Snapshot) {
  return snapshot?.mode === 'github' || snapshot?.syncStatus === 'synced'
    ? 'Synced'
    : snapshot?.syncStatus === 'error'
      ? 'Sync failed'
      : snapshot?.syncStatus === 'syncing'
        ? 'Syncing'
        : 'Saved locally';
}

export function acknowledge(cache: Cache, snapshot: Snapshot, operationId: string): Cache {
  return { ...cache, snapshot, pending: cache.pending.filter((op) => op.id !== operationId) };
}

/** Capture deletion intent at authoring time, never from a later refreshed snapshot. */
export function authorOperation(
  snapshot: Snapshot,
  pending: Operation[],
  operation: Operation,
): Operation {
  const library = replay(snapshot, pending).library;
  if (operation.type !== 'delete' || !operation.recordId) return operation;
  const record = library.records[operation.recordId];
  return {
    ...operation,
    base: operation.base ?? record,
    ...(record?.kind === 'collection' && !operation.baseRecords
      ? { baseRecords: deletionBaseRecords(library, record.id) }
      : {}),
  };
}

export function canReachServer(mode: Snapshot['mode'] | undefined, online: boolean) {
  return mode === 'local' || online;
}

export const archivePending = (scope: string, cache: Cache) =>
  set(`gitdrop:recovery:${scope}:${Date.now()}`, structuredClone(cache));
