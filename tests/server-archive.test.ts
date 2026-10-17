import { describe, it, expect } from 'vitest';
import { archiveStream } from '../src/server/archive';
import type { Store } from '../src/storage/types';
import AdmZip from 'adm-zip';
describe('streaming archive', () => {
  it('produces a valid archive with bounded entry production', async () => {
    let produced = 0;
    const store = {
      async *exportEntries() {
        for (let i = 0; i < 10; i++) {
          produced++;
          yield { name: `${i}.txt`, data: Buffer.from(`item ${i}`) };
        }
      },
    } as Store;
    const data = await new Response(archiveStream(store)).arrayBuffer();
    const zip = new AdmZip(Buffer.from(data));
    expect(zip.getEntries()).toHaveLength(10);
    expect(zip.readAsText('9.txt')).toBe('item 9');
    expect(produced).toBe(10);
  });
  it('releases an export iterator when the browser cancels', async () => {
    let released = false;
    let produced = 0;
    const store = {
      async *exportEntries() {
        try {
          for (let i = 0; i < 100; i++) {
            produced++;
            yield { name: `${i}.bin`, data: Buffer.alloc(1000000, i) };
          }
        } finally {
          released = true;
        }
      },
    } as Store;
    const reader = archiveStream(store).getReader();
    await reader.read();
    await reader.cancel();
    for (let n = 0; n < 30 && !released; n++) await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(true);
    expect(produced).toBeLessThan(100);
  });
});
