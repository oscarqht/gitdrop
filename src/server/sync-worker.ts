import { getStore, LocalStore } from '../storage';
import { hosted } from './auth';
type Worker = {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  status: 'idle' | 'syncing' | 'synced' | 'error';
  error?: string;
  revision?: string;
};
const globals = globalThis as typeof globalThis & { gitdropSync?: Worker };
const state = () => (globals.gitdropSync ??= { running: false, status: 'idle' });
export function syncState(revision?: string) {
  const s = state();
  return {
    syncStatus: s.status === 'synced' && revision && revision !== s.revision ? 'idle' : s.status,
    syncError: s.error,
  };
}
export async function syncNow(repositoryUrl?: string) {
  const s = state();
  if (s.running) throw new Error('Sync is already running; retry shortly.');
  s.running = true;
  s.status = 'syncing';
  s.error = undefined;
  try {
    const store = getStore();
    if (repositoryUrl !== undefined) {
      if (!(store instanceof LocalStore)) throw new Error('Repository setup requires local mode.');
      await store.initialize();
      await store.connectRepository(repositoryUrl);
    }
    const result = await store.sync();
    s.status = result.status?.startsWith('Local only') ? 'idle' : 'synced';
    s.revision = result.revision;
    return result;
  } catch (error) {
    s.status = 'error';
    s.error = error instanceof Error ? error.message : 'Sync failed';
    throw error;
  } finally {
    s.running = false;
  }
}
export function startSyncWorker() {
  if (hosted() || process.env.GITDROP_DISABLE_AUTO_SYNC === '1') return;
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => {
    if (!s.running) void syncNow().catch(() => {});
  }, 60_000);
  s.timer.unref();
  // Starts only after the first library request; never during a Next.js build.
  void syncNow().catch(() => {});
}
