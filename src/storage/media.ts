import { createHash } from 'node:crypto';
export type MediaReference = { sha: string; source: 'file' | 'git'; location: string };
const prefix = 'gitdrop-media-reference:';
export const mediaReference = (reference: MediaReference) =>
  Buffer.from(prefix + JSON.stringify(reference));
export function parseMediaReference(value: Buffer): MediaReference | null {
  if (!value.subarray(0, prefix.length).equals(Buffer.from(prefix))) return null;
  const ref = JSON.parse(value.subarray(prefix.length).toString());
  if (
    !/^[a-f0-9]{40}$/.test(ref.sha) ||
    !['file', 'git'].includes(ref.source) ||
    typeof ref.location !== 'string'
  )
    throw new Error('Invalid media reference');
  return ref;
}
export const mediaHash = (value: Buffer) =>
  parseMediaReference(value)?.sha ||
  createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
