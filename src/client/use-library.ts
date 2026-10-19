'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOperation } from '../domain/operations';
import {
  createImportJob,
  nextRecordBatch,
  importComplete,
  retryCovers,
  type ImportJob,
} from './import-job';
import type { RaindropImportEntry } from '../domain/csv';
import type { Operation } from '../domain/types';
import {
  archivePending,
  canReachServer,
  authorOperation,
  acknowledge,
  confirmedStatus,
  actorId,
  readCache,
  replay,
  writeCache,
  clearCache,
  type Snapshot,
  type Cache,
} from './store';

function getClientCredentialsHeaders() {
  if (typeof window === 'undefined') return {};
  const headers: Record<string, string> = {};
  const repo = localStorage.getItem('gitdrop:github_repository');
  const token = localStorage.getItem('gitdrop:github_token');
  if (repo) headers['x-github-repository'] = repo;
  if (token) headers['x-github-token'] = token;
  return headers;
}

export function useLibrary() {
  const [data, setData] = useState<Snapshot>();
  const [importJob, setImportJob] = useState<ImportJob>();
  const [mode, setMode] = useState<'local' | 'github'>('local');
  const [status, setStatus] = useState('Loading');
  const [error, setError] = useState('');
  const [login, setLogin] = useState(false);
  const [online, setOnline] = useState(true);
  const verified = useRef(false);
  const state = useRef<Cache | undefined>(undefined);
  const scope = useRef('');
  const busy = useRef<Promise<void> | null>(null);
  const active = useRef(true);
  const actionsWaiting = useRef(0);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());
  const publish = useCallback(async (requireDurable = false) => {
    if (!state.current) return;
    setData(replay(state.current.snapshot, state.current.pending));
    setImportJob(state.current.importJob ? structuredClone(state.current.importJob) : undefined);
    try {
      await writeCache(scope.current, state.current);
    } catch {
      setError('Browser storage is unavailable. Keep this tab open until pending edits are saved.');
      if (requireDurable)
        throw new Error(
          'Could not save import progress on this device. Free browser storage and retry.',
        );
    }
  }, []);
  const request = useCallback(async (url: string, init?: RequestInit) => {
    const credHeaders = getClientCredentialsHeaders();
    let headers: HeadersInit | undefined = init?.headers;
    if (Object.keys(credHeaders).length > 0) {
      if (headers instanceof Headers) {
        for (const [k, v] of Object.entries(credHeaders)) {
          if (!headers.has(k)) headers.set(k, v);
        }
      } else if (Array.isArray(headers)) {
        headers = [...headers, ...Object.entries(credHeaders)];
      } else {
        headers = { ...credHeaders, ...headers };
      }
    }
    const r = await fetch(url, { ...init, headers });
    if (r.status === 401) {
      verified.current = false;
      setLogin(true);
      throw new Error('Please sign in to continue');
    }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(typeof b.error === 'string' ? b.error : 'The request could not be completed');
    }
    return r.json();
  }, []);
  const drain = useCallback(async () => {
    if (!verified.current) return;
    if (busy.current) return busy.current;
    if (!state.current || !canReachServer(state.current.snapshot.mode, navigator.onLine)) return;
    const work = Promise.resolve().then(async () => {
      try {
        while (
          active.current &&
          state.current &&
          verified.current &&
          canReachServer(state.current.snapshot.mode, navigator.onLine)
        ) {
          if (!state.current.pending.length) {
            const job = state.current.importJob;
            if (actionsWaiting.current || !job || job.paused || job.error || importComplete(job))
              break;
            // The complete plan is persisted before any request. Stable IDs make lost responses safe to retry.
            await publish(true);
            const batch = nextRecordBatch(job);
            if (batch) {
              setStatus('Saving import');
              const next = await request('/api/operations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
              });
              job.saved += batch.records!.length;
              state.current = { ...state.current, snapshot: next };
            } else {
              setStatus('Fetching covers');
              const entries = job.entries
                .filter((e) => e.item.kind === 'bookmark' && e.coverStatus === 'pending')
                .slice(0, 4);
              const next = await request('/api/import-covers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  entries: entries.map((e) => ({
                    recordId: e.item.id,
                    ...(e.coverUrl ? { coverUrl: e.coverUrl } : {}),
                  })),
                }),
              });
              for (const outcome of next.coverOutcomes) {
                const entry = entries.find((e) => e.item.id === outcome.recordId);
                if (entry) {
                  entry.coverStatus = outcome.status;
                  entry.coverError = outcome.error;
                }
              }
              const { coverOutcomes: _, ...snapshot } = next;
              state.current = { ...state.current, snapshot };
            }
            await publish(true);
            continue;
          }
          setStatus('Pending');
          const op = state.current.pending[0];
          const next = await request('/api/operations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op),
          });
          state.current = acknowledge(state.current, next, op.id);
          await publish();
        }
        setStatus(confirmedStatus(state.current?.snapshot));
        setError('');
      } catch (e) {
        if (state.current?.importJob && !importComplete(state.current.importJob)) {
          state.current.importJob.error = networkMessage(e);
          await publish();
        }
        setStatus('Failed');
        setError(networkMessage(e));
      }
    });
    busy.current = work;
    try {
      await work;
    } finally {
      busy.current = null;
    }
  }, [publish, request]);
  const refresh = useCallback(async () => {
    if (!verified.current) return;
    try {
      if (busy.current) await busy.current;
      const pendingBefore = state.current?.pending;
      const revision =
        state.current?.snapshot.mode === 'github' ? state.current.snapshot.revision : undefined;
      const next = await request(
        `/api/library${revision ? '?revision=' + encodeURIComponent(revision) : ''}`,
      );
      if (busy.current) {
        await busy.current;
        return;
      }
      if (pendingBefore !== state.current?.pending) return;
      if (!next.unchanged)
        state.current = {
          ...state.current,
          snapshot: next,
          pending: state.current?.pending || [],
        };
      if (!state.current) return;
      await publish();
      setStatus(state.current.pending.length ? 'Pending' : confirmedStatus(state.current.snapshot));
      await drain();
    } catch (e) {
      setStatus(state.current ? 'Cached' : 'Failed');
      setError(!navigator.onLine && state.current ? '' : networkMessage(e));
    }
  }, [drain, publish, request]);
  useEffect(() => {
    active.current = true;
    verified.current = false;
    if ('serviceWorker' in navigator && process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then(async (registrations) => {
          for (const registration of registrations)
            if (registration.active?.scriptURL.endsWith('/sw.js')) await registration.unregister();
          if ('caches' in window)
            for (const key of await caches.keys())
              if (key.startsWith('gitdrop-shell-')) await caches.delete(key);
        })
        .catch(() => {});
    }
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production')
      void navigator.serviceWorker
        .register('/sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then((registration) => {
          const assets = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((url) => new URL(url).pathname.startsWith('/_next/static/'));
          registration.active?.postMessage({ type: 'CACHE_SHELL', assets });
        })
        .catch(() => {});
    (async () => {
      try {
        const lastScope = localStorage.getItem('gitdrop:lastScope');
        if (lastScope) {
          const cached = await readCache(lastScope);
          if (cached) {
            scope.current = lastScope;
            state.current = cached;
            await publish();
            setStatus('Cached');
          }
        }
        const session = await request('/api/session');
        if (session.mode) setMode(session.mode);
        if (!session.authenticated) {
          state.current = undefined;
          setData(undefined);
          setLogin(true);
          return;
        }
        scope.current = session.scope;
        verified.current = true;
        localStorage.setItem('gitdrop:lastScope', session.scope);
        const cached = await readCache(session.scope);
        state.current = undefined;
        setData(undefined);
        if (cached) {
          state.current = cached;
          await publish();
          setStatus('Cached');
        }
        if (session.mode === 'github' && session.configured === false) {
          setStatus('Connect repository');
          setError(
            'Please configure your GitHub repository and personal access token in Settings.',
          );
          return;
        }
        await refresh();
      } catch (e) {
        const last = localStorage.getItem('gitdrop:lastScope');
        if (!navigator.onLine && last) {
          scope.current = last;
          const cached = await readCache(last);
          if (cached) {
            state.current = cached;
            await publish();
            setStatus('Cached');
          }
        }
        setError(!navigator.onLine && state.current ? '' : networkMessage(e));
      }
    })();
    const change = () => {
      setOnline(navigator.onLine);
      if (canReachServer(state.current?.snapshot.mode, navigator.onLine)) void refresh();
      else setStatus('Cached');
    };
    setOnline(navigator.onLine);
    window.addEventListener('online', change);
    window.addEventListener('offline', change);
    window.addEventListener('focus', change);
    const timer = setInterval(() => {
      if (!document.hidden && canReachServer(state.current?.snapshot.mode, navigator.onLine))
        void refresh();
    }, 30000);
    return () => {
      active.current = false;
      clearInterval(timer);
      window.removeEventListener('online', change);
      window.removeEventListener('offline', change);
      window.removeEventListener('focus', change);
    };
  }, [publish, refresh, request]);
  const mutate = async (input: Omit<Operation, 'id' | 'actor'>) => {
    if (!state.current || !verified.current) {
      setError('Connect to verify this library before editing.');
      return;
    }
    if (state.current.snapshot.mode === 'github' && !navigator.onLine) {
      setError('You can browse offline. Reconnect to make changes.');
      return;
    }
    const op = authorOperation(state.current.snapshot, state.current.pending, {
      ...input,
      id: crypto.randomUUID(),
      actor: actorId(),
    } as Operation);
    try {
      applyOperation(replay(state.current.snapshot, state.current.pending).library, op);
    } catch (e) {
      setError(networkMessage(e));
      throw e;
    }
    state.current.pending.push(op);
    await publish();
    setStatus('Pending');
    void drain();
  };
  const action = async (url: string, body?: BodyInit) => {
    if (!verified.current) return;
    actionsWaiting.current++;
    const previous = actionQueue.current;
    let release!: () => void;
    actionQueue.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      // Finish the current batch; normal edits and actions get priority over the next import batch.
      await drain();
      if (state.current?.pending.length)
        throw new Error('Resolve pending changes before continuing');
      setStatus('Pending');
      const work = Promise.resolve().then(async () => {
        const next = await request(url, {
          method: 'POST',
          body,
          headers: typeof body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
        });
        state.current = {
          ...state.current,
          snapshot: next,
          pending: state.current?.pending || [],
        };
        await publish();
      });
      busy.current = work;
      try {
        await work;
      } finally {
        busy.current = null;
      }
      setStatus(confirmedStatus(state.current?.snapshot));
      setError('');
      return true;
    } catch (e) {
      setError(networkMessage(e));
      setStatus('Failed');
      return false;
    } finally {
      actionsWaiting.current--;
      release();
      void drain();
    }
  };
  const recoverPending = async () => {
    if (!state.current?.pending.length || busy.current) return;
    if (
      !confirm(
        'Export pending edits and remove them from the retry queue? The current server library will be reloaded. A recovery copy will also remain in this browser.',
      )
    )
      return;
    try {
      const backup = structuredClone(state.current);
      await archivePending(scope.current, backup);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], {
          type: 'application/json',
        }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'gitdrop-pending-recovery.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      state.current = { ...backup, snapshot: backup.snapshot, pending: [] };
      await publish();
      await refresh();
    } catch (e) {
      setError(networkMessage(e));
    }
  };
  const startImport = async (name: string, entries: RaindropImportEntry[]) => {
    if (!verified.current || !state.current)
      throw new Error('Connect to verify this library before importing.');
    if (state.current.importJob && !importComplete(state.current.importJob))
      throw new Error('Finish the current import before starting another.');
    const previous = state.current.importJob;
    state.current.importJob = createImportJob(name, entries);
    try {
      await publish(true);
    } catch (error) {
      state.current.importJob = previous;
      await publish();
      throw error;
    }
    void drain();
  };
  const controlImport = async (command: 'pause' | 'resume' | 'retry' | 'dismiss') => {
    const job = state.current?.importJob;
    if (!job || !state.current) return;
    if (command === 'dismiss') {
      if (!importComplete(job)) return;
      delete state.current.importJob;
    } else if (command === 'pause') job.paused = true;
    else {
      job.error = undefined;
      job.paused = false;
      if (command === 'retry') retryCovers(job);
    }
    await publish(true);
    if (command === 'resume' || command === 'retry') void drain();
  };
  const logout = async () => {
    if (state.current?.importJob && !importComplete(state.current.importJob)) {
      setError('Finish the import before signing out. You can pause it and return later.');
      return;
    }
    if (state.current?.pending.length) {
      setError('Sync pending edits before signing out.');
      return;
    }
    await clearCache(scope.current);
    if ('caches' in window)
      for (const key of await caches.keys())
        if (key.startsWith('gitdrop-')) await caches.delete(key);
    localStorage.removeItem('gitdrop:lastScope');
    localStorage.removeItem('gitdrop:github_repository');
    localStorage.removeItem('gitdrop:github_token');
    await fetch('/api/auth/logout', { method: 'POST' });
    location.reload();
  };
  return {
    data,
    importJob,
    startImport,
    controlImport,
    mode: data?.mode ?? mode,
    status,
    error,
    setError,
    login,
    online,
    mutate,
    action,
    refresh,
    logout,
    recoverPending,
    pendingCount: state.current?.pending.length || 0,
    disabled: !verified.current || !data || (data.mode === 'github' && !online),
  };
}

function networkMessage(error: unknown) {
  const message = (error as Error)?.message || 'Request failed';
  return /failed to fetch|fetch failed|networkerror/i.test(message)
    ? 'Connection unavailable. Your cached library and pending edits are kept on this device.'
    : message;
}
