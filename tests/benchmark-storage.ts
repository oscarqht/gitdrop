/** Physical fixture benchmark; creates and removes its own temporary data repository. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLibrary, makeItem } from '../src/domain/operations';
import { encodeFiles, type Files } from '../src/storage/codec';
import { mediaHash } from '../src/storage/media';
import { LocalStore } from '../src/storage/local';

const count = Number(process.argv[2] || 10000);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdrop-benchmark-'));
const metrics: Record<string, number> = {};
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const baseline = process.memoryUsage();
let peak = baseline;
const sample = setInterval(() => {
  const current = process.memoryUsage();
  peak = {
    ...current,
    rss: Math.max(current.rss, peak.rss),
    heapUsed: Math.max(current.heapUsed, peak.heapUsed),
    external: Math.max(current.external, peak.external),
    arrayBuffers: Math.max(current.arrayBuffers, peak.arrayBuffers),
  };
}, 10);
async function time<T>(name: string, fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  metrics[name] = Math.round(performance.now() - start);
  return result;
}
try {
  const library = createLibrary();
  const inbox = makeItem('collection', { id: 'inbox', title: 'Inbox' });
  library.records.inbox = inbox;
  const cover = Buffer.alloc(20 * 1024, 7);
  const imageHash = mediaHash(cover);
  const media: Files = new Map([[`.gitdrop/media/by-hash/${imageHash}.webp`, cover]]);
  for (let index = 0; index < count; index++) {
    const item = makeItem('bookmark', {
      id: `b${index.toString().padStart(7, '0')}`,
      title: `Bookmark ${index}`,
      url: `https://example.com/${index}`,
      parentId: 'inbox',
      cover: { mode: 'image', imageFile: 'cover.webp', imageHash },
    });
    library.records[item.id] = item;
  }
  await time('encodeAndWriteMs', async () => {
    const files = encodeFiles(library, media);
    const entries = [...files];
    const parents = new Set(entries.map(([name]) => path.dirname(path.join(directory, name))));
    await Promise.all([...parents].map((parent) => fs.mkdir(parent, { recursive: true })));
    let next = 0;
    await Promise.all(
      Array.from({ length: 24 }, async () => {
        while (next < entries.length) {
          const [name, data] = entries[next++];
          await fs.writeFile(path.join(directory, name), data);
        }
      }),
    );
    metrics.files = files.size;
  });
  const store = new LocalStore(directory);
  await time('coldReadMs', async () => {
    const result = await store.read();
    if (result.diagnostics.length || Object.keys(result.library.records).length !== count + 1)
      throw new Error('Fixture validation failed');
  });
  await time('warmReadMs', () => store.read());
  await time('singleMutationMs', () =>
    store.mutate({
      id: 'benchmark-edit',
      actor: 'benchmark',
      type: 'update',
      recordId: 'b0000000',
      patch: { note: 'A benchmark note' },
    }),
  );
  metrics.coverBytes = count * cover.length;
  console.log(
    JSON.stringify(
      {
        count,
        ...metrics,
        memoryMiB: {
          baselineRss: mb(baseline.rss),
          peakRss: mb(peak.rss),
          rssIncrease: mb(peak.rss - baseline.rss),
          peakHeap: mb(peak.heapUsed),
          peakExternal: mb(peak.external),
          peakArrayBuffers: mb(peak.arrayBuffers),
        },
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sample);
  await fs.rm(directory, { recursive: true, force: true });
}
