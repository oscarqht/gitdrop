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

it('skips existing bookmark URLs across collections and variants before creating folders', async () => {
  const { makeItem } = await import('../src/domain/operations');
  const existing = makeItem('bookmark', { title: 'Keep my title', url: 'https://example.com/' });
  existing.note = 'Keep my note';
  existing.variants!.push({ id: 'docs', name: 'Docs', url: 'https://example.com/docs', order: 'a1' });
  const before = structuredClone(existing);
  const entries = parseRaindropCsvWithCovers([
    'url,title,folder',
    'https://EXAMPLE.com:443,Changed title,Do not create',
    'https://example.com/docs,Changed variant,Do not create either',
    'https://example.com/new,New bookmark,New folder',
    'https://example.com/new,Repeated row,Another unused folder',
    'https://example.com/new?q=1,Distinct query,New folder',
  ].join('\n'), { existingBookmarks: [existing] });
  expect(entries.filter(entry => entry.item.kind === 'collection').map(entry => entry.item.title)).toEqual(['New folder']);
  expect(entries.filter(entry => entry.item.kind === 'bookmark').map(entry => entry.item.title)).toEqual(['New bookmark', 'Distinct query']);
  expect(existing).toEqual(before);
});

it('reuses collection paths and makes reimporting the same CSV a no-op', () => {
  const csv = 'url,folder\nhttps://a.test,Parent / Child\nhttps://b.test,parent / child\nhttps://a.test,Parent / Child';
  const first = parseRaindropCsvWithCovers(csv);
  expect(first.filter(entry => entry.item.kind === 'collection')).toHaveLength(2);
  expect(first.filter(entry => entry.item.kind === 'bookmark')).toHaveLength(2);
  const existing = first.map(entry => entry.item);
  expect(parseRaindropCsvWithCovers(csv, { existingCollections: existing, existingBookmarks: existing })).toEqual([]);
  const added = parseRaindropCsvWithCovers('url,folder\nhttps://c.test,PARENT / CHILD', { existingCollections: existing, existingBookmarks: existing });
  expect(added).toHaveLength(1);
  expect(added[0].item.parentId).toBe(first[1].item.id);
});
