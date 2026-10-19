import { expect, it } from 'vitest';
import {
  createImportJob,
  nextRecordBatch,
  importCounts,
  retryCovers,
} from '../src/client/import-job';
import { parseRaindropCsvWithCovers } from '../src/domain/csv';

it('saves parent collections before bookmarks and counts only acknowledged batches', () => {
  const entries = parseRaindropCsvWithCovers(
    'url,folder\nhttps://a.test,Parent / Child\nhttps://b.test,Parent',
  );
  const job = createImportJob('large.csv', entries);
  expect(importCounts(job).bookmarks.saved).toBe(0);
  const batch = nextRecordBatch(job)!;
  expect(batch.records!.map((r) => r.kind)).toEqual(['collection', 'collection']);
  expect(batch.records![1].parentId).toBe(batch.records![0].id);
  expect(nextRecordBatch(structuredClone(job))).toEqual(batch);
  job.saved += batch.records!.length;
  expect(importCounts(job).collections.saved).toBe(2);
  expect(importCounts(job).bookmarks.saved).toBe(0);
  expect(nextRecordBatch(job)!.records!.every((r) => r.kind === 'bookmark')).toBe(true);
});

it('retries only failed covers and preserves successful and unavailable results', () => {
  const job = createImportJob(
    'links.csv',
    parseRaindropCsvWithCovers('url\nhttps://a.test\nhttps://b.test\nhttps://c.test'),
  );
  job.entries[0].coverStatus = 'fetched';
  job.entries[1].coverStatus = 'failed';
  job.entries[2].coverStatus = 'unavailable';
  retryCovers(job);
  expect(job.entries.map((e) => e.coverStatus)).toEqual(['fetched', 'pending', 'unavailable']);
});

it('bounds batches by UTF-8 payload size as well as record count', () => {
  const entries = parseRaindropCsvWithCovers('url\n' + Array.from({length: 101}, (_, i) => `https://b${i}.test`).join('\n'));
  const job = createImportJob('large.csv', entries);
  expect(nextRecordBatch(job)!.records).toHaveLength(100);
  for (const entry of job.entries.slice(0, 5)) entry.item.note = '☃'.repeat(500000);
  const batch = nextRecordBatch(job)!;
  expect(batch.records).toHaveLength(2);
  expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(4_000_000);
});
