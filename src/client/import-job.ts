import type { RaindropImportEntry } from '../domain/csv';
import type { Item, Operation } from '../domain/types';

export type CoverStatus = 'pending' | 'fetched' | 'unavailable' | 'failed';
export type ImportJob = {
  id: string;
  name: string;
  entries: (RaindropImportEntry & {
    coverStatus: CoverStatus;
    coverError?: string;
  })[];
  saved: number;
  paused: boolean;
  error?: string;
};
export function createImportJob(name: string, entries: RaindropImportEntry[]): ImportJob {
  return {
    id: crypto.randomUUID(),
    name,
    saved: 0,
    paused: false,
    // The parser emits collections in parent-first order.
    entries: entries.map((entry) => ({ ...entry, coverStatus: 'pending' })),
  };
}
export function nextRecordBatch(job: ImportJob): Operation | undefined {
  const remaining = job.entries.slice(job.saved);
  if (!remaining.length) return;
  const kind = remaining[0].item.kind;
  const records: Item[] = [];
  let bytes = 0;
  for (const entry of remaining.slice(0, 100)) {
    if (entry.item.kind !== kind) break;
    const size = new TextEncoder().encode(JSON.stringify(entry.item)).length;
    if (records.length && bytes + size > 4_000_000) break;
    records.push(entry.item);
    bytes += size;
  }
  return {
    id: `${job.id}-${job.saved}`,
    actor: 'csv-import',
    type: 'create',
    records,
  };
}
export function importCounts(job: ImportJob) {
  const count = (kind: 'collection' | 'bookmark') => ({
    total: job.entries.filter((e) => e.item.kind === kind).length,
    saved: job.entries.slice(0, job.saved).filter((e) => e.item.kind === kind).length,
  });
  const covers = job.entries.filter((e) => e.item.kind === 'bookmark');
  return {
    collections: count('collection'),
    bookmarks: count('bookmark'),
    covers: {
      total: covers.length,
      processed: covers.filter((e) => e.coverStatus !== 'pending').length,
      fetched: covers.filter((e) => e.coverStatus === 'fetched').length,
      unavailable: covers.filter((e) => e.coverStatus === 'unavailable').length,
      failed: covers.filter((e) => e.coverStatus === 'failed').length,
    },
  };
}
export function importComplete(job: ImportJob) {
  return (
    job.saved === job.entries.length &&
    !job.entries.some((e) => e.item.kind === 'bookmark' && e.coverStatus === 'pending')
  );
}
export function retryCovers(job: ImportJob) {
  for (const entry of job.entries)
    if (entry.coverStatus === 'failed') {
      entry.coverStatus = 'pending';
      delete entry.coverError;
    }
  job.error = undefined;
  job.paused = false;
}
