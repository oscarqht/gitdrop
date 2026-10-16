import { Readable } from 'node:stream';
import { once } from 'node:events';
import { ZipFile } from 'yazl';
import type { Store } from '../storage/types';
/** Feed one entry at a time; output backpressure bounds memory and cancellation releases store locks. */
export function archiveStream(store: Store): ReadableStream<Uint8Array> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const entries = store.exportEntries();
  let active: Readable | undefined;
  zip.on('error', (error) => output.destroy(error));
  output.on('error', () => {});
  output.on('close', () => {
    if (active && !active.readableEnded) active.destroy(new Error('Export cancelled'));
  });
  void (async () => {
    try {
      for await (const { name, data } of entries) {
        if (output.destroyed) break;
        active = Readable.from([data]);
        const consumed = once(active, 'end');
        zip.addReadStream(active, name, { size: data.length });
        await consumed;
      }
      if (!output.destroyed) zip.end();
    } catch (error) {
      output.destroy(error as Error);
    } finally {
      await entries.return(undefined);
    }
  })();
  return Readable.toWeb(output) as ReadableStream<Uint8Array>;
}
