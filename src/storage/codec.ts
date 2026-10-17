import { createHash } from 'node:crypto';
import path from 'node:path';
import { mediaHash } from './media';
import {
  compareRevision,
  idSchema,
  itemSchema,
  validateLibrary,
  type Item,
  type Library,
} from '../domain/types';
import { createLibrary } from '../domain/operations';

export const gitBlobHash = (data: Buffer) =>
  createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
export type Files = Map<string, Buffer> & { directories?: string[] };
export type Decoded = { library: Library; diagnostics: string[]; paths: Record<string, string> };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function safePath(value: string) {
  return (
    !!value &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    !value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  );
}
export function slug(value: string) {
  return (
    value
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/[. ]+$/, '')
      .slice(0, 70) || 'Untitled'
  ).replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i, '_$1');
}
export function decodeFiles(files: Files, actor = 'external'): Decoded {
  const diagnostics: string[] = [];
  const paths: Record<string, string> = {};
  let library = createLibrary();
  library.records = {};
  let manifests: Record<string, { hash: string; path: string; record?: Item }> = {};
  const state = files.get('.gitdrop/state.json');
  if (!state && files.has('.gitdrop/manifest.json'))
    diagnostics.push('Missing .gitdrop/state.json; restore it from Git history before writing.');
  if (state && !files.has('.gitdrop/manifest.json'))
    diagnostics.push('Missing .gitdrop/manifest.json; restore it from Git history before writing.');
  if (state)
    try {
      const parsed = JSON.parse(state.toString());
      library = validateLibrary({ ...parsed, records: {} });
    } catch {
      diagnostics.push('Invalid .gitdrop/state.json; repair it before writing.');
    }
  try {
    const parsed = JSON.parse(files.get('.gitdrop/manifest.json')?.toString() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected manifest object');
    for (const [id, value] of Object.entries(parsed)) {
      idSchema.parse(id);
      const entry = value as { hash?: unknown; path?: unknown; record?: unknown };
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        typeof entry.path !== 'string' ||
        !safePath(entry.path) ||
        entry.path.startsWith('.gitdrop/')
      )
        throw new Error('Invalid manifest entry');
      if (entry.record !== undefined && itemSchema.parse(entry.record).id !== id)
        throw new Error('Manifest identity mismatch');
    }
    manifests = parsed;
  } catch {
    diagnostics.push('Invalid source manifest.');
  }
  const candidates = [...files]
    .filter(([p]) => !p.startsWith('.gitdrop/') && p.endsWith('.json'))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!state && candidates.length && !files.has('.gitdrop/manifest.json'))
    diagnostics.push(
      'Missing Gitdrop control files; restore state and manifest from Git history before writing.',
    );
  const dirs = new Map<string, string>();
  const staleFiles = new Set<string>();
  for (const [file, buffer] of candidates) {
    try {
      const item = JSON.parse(buffer.toString());
      itemSchema.parse(item);
      if (item.kind === 'collection' && path.posix.basename(file) !== '_collection.json')
        throw new Error('Collection metadata must be named _collection.json');
      if (item.kind === 'bookmark' && path.posix.basename(file) === '_collection.json')
        throw new Error('Expected collection metadata');
      const existing = library.records[item.id];
      if (existing) {
        const existingFile = paths[item.id];
        const cmp = compareRevision(item.revision, existing.revision);
        const manifestPath = manifests[item.id]?.path;
        const itemIsCanonical =
          existing.kind === item.kind &&
          (cmp > 0 || (cmp === 0 && manifestPath === file && manifestPath !== existingFile));
        const existingIsCanonical =
          existing.kind === item.kind &&
          (cmp < 0 || (cmp === 0 && manifestPath === existingFile && manifestPath !== file));
        if (existingIsCanonical) {
          staleFiles.add(file);
          continue;
        }
        if (!itemIsCanonical) throw new Error(`Duplicate ID ${item.id}`);
        staleFiles.add(existingFile);
        if (existing.kind === 'collection') dirs.delete(path.posix.dirname(existingFile));
      }
      library.records[item.id] = item;
      paths[item.id] = file;
      if (item.kind === 'collection') dirs.set(path.posix.dirname(file), item.id);
    } catch (e) {
      diagnostics.push(`${file}: ${(e as Error).message}`);
    }
  }
  // Every ordinary folder with records is adopted as a collection, parent first.
  const needed = new Set<string>(files.directories || []);
  for (const [file] of files)
    if (!staleFiles.has(file) && !file.startsWith('.') && safePath(file)) {
      let dir = path.posix.dirname(file);
      while (dir !== '.') {
        needed.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
  for (const dir of [...needed].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )) {
    if (dirs.has(dir)) continue;
    if (files.has(`${dir}/_collection.json`)) continue; // Never replace malformed metadata.
    const id = `folder_${hash(dir).slice(0, 24)}`;
    const date = new Date(0).toISOString();
    library.records[id] = {
      id,
      kind: 'collection',
      title: path.posix.basename(dir).replace(/--[a-zA-Z0-9_-]+$/, ''),
      parentId: dirs.get(path.posix.dirname(dir)) || null,
      description: '',
      note: '',
      tags: [],
      order: 'a0',
      cover: { mode: 'emoji', emoji: '📁' },
      createdAt: date,
      updatedAt: date,
      revision: { counter: 1, actor },
    };
    dirs.set(dir, id);
    paths[id] = `${dir}/_collection.json`;
  }
  for (const item of Object.values(library.records)) {
    const file = paths[item.id];
    const ownDir = path.posix.dirname(file);
    const parentDir = item.kind === 'collection' ? path.posix.dirname(ownDir) : ownDir;
    const parentId = dirs.get(parentDir) || null;
    const original = hash(item);
    const manifest = manifests[item.id];
    if (item.parentId !== parentId) item.parentId = parentId;
    // Keep covers adjacent after a manual move/rename of the record and image.
    const sibling = file.replace(/\.json$/, '.webp');
    if (files.has(sibling)) {
      item.cover.imageFile = path.posix.basename(sibling);
      item.cover.imageHash = mediaHash(files.get(sibling)!);
    }
    if (
      manifest &&
      (manifest.hash !== original || manifest.path !== file || hash(item) !== original)
    ) {
      item.revision = {
        counter: item.revision.counter + 1,
        actor: `${actor}_${hash({ file, item }).slice(0, 12)}`,
      };
      item.fieldRevisions = Object.fromEntries(
        Object.keys(item)
          .filter((k) => !['revision', 'fieldRevisions', 'id', 'kind'].includes(k))
          .map((k) => [k, item.revision]),
      );
    }
  }
  if (!diagnostics.length) {
    for (const [id, entry] of Object.entries(manifests)) {
      if (library.records[id] || library.tombstones[id] || !entry.record) continue;
      try {
        const old = itemSchema.parse(entry.record);
        if (old.id !== id) throw new Error('Manifest ID mismatch');
        library.tombstones[id] = {
          id,
          revision: { counter: old.revision.counter + 1, actor: `external-delete-${id}` },
          deletedAt: old.updatedAt,
          record: old,
        };
        paths[id] = entry.path;
      } catch {
        diagnostics.push(`Invalid source manifest record: ${id}`);
      }
    }
    for (const item of Object.values(library.records)) {
      const seen = new Set<string>([item.id]);
      let parent = item.parentId;
      while (parent) {
        if (seen.has(parent)) {
          diagnostics.push(`Collection cycle at ${item.id}`);
          break;
        }
        seen.add(parent);
        const ancestor = library.records[parent];
        if (!ancestor || ancestor.kind !== 'collection') {
          diagnostics.push(`Missing collection for ${item.id}`);
          break;
        }
        parent = ancestor.parentId;
      }
    }
  }
  return { library, diagnostics, paths };
}
export function encodeFiles(
  library: Library,
  previous: Files = new Map(),
  existingPaths: Record<string, string> = {},
): Files {
  const output: Files = new Map();
  const paths: Record<string, string> = {};
  const visiting = new Set<string>();
  const usedPaths = new Set<string>();
  function location(item: Item): string {
    if (paths[item.id]) return paths[item.id];
    if (visiting.has(item.id)) throw new Error('Collection cycle');
    visiting.add(item.id);
    const parent = item.parentId ? library.records[item.parentId] : null;
    if (item.parentId && (!parent || parent.kind !== 'collection'))
      throw new Error(`Missing collection for ${item.id}`);
    const directory = parent ? path.posix.dirname(location(parent)) : '';
    const old = existingPaths[item.id];
    const name =
      item.kind === 'collection'
        ? old
          ? path.posix.basename(path.posix.dirname(old))
          : `${slug(item.title)}--${item.id.slice(0, 8)}`
        : old
          ? path.posix.basename(old)
          : `${slug(item.title)}--${item.id.slice(0, 8)}.json`;
    const target = path.posix.join(
      directory,
      name,
      item.kind === 'collection' ? '_collection.json' : '',
    );
    if (!safePath(target)) throw new Error('Unsafe record path');
    if (usedPaths.has(target.toLocaleLowerCase('en-US')))
      throw new Error(`Path collision: ${target}`);
    usedPaths.add(target.toLocaleLowerCase('en-US'));
    paths[item.id] = target;
    visiting.delete(item.id);
    return target;
  }
  previous = new Map(previous);
  for (const [file, data] of [...previous])
    if (file.endsWith('.webp'))
      previous.set(`.gitdrop/media/by-hash/${mediaHash(data)}.webp`, data);
  const sortedRecords = Object.values(library.records).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const manifest: Record<string, { hash: string; path: string; record: Item }> = {};
  for (const item of sortedRecords) {
    const file = location(item);
    const copy = structuredClone(item);
    if (copy.cover.imageFile) {
      const oldPath = existingPaths[item.id] || file;
      const adjacent = previous.get(
        path.posix.join(path.posix.dirname(oldPath), copy.cover.imageFile),
      );
      const image =
        (copy.cover.imageHash
          ? previous.get(`.gitdrop/media/by-hash/${copy.cover.imageHash}.webp`)
          : undefined) ??
        (adjacent && (!copy.cover.imageHash || mediaHash(adjacent) === copy.cover.imageHash)
          ? adjacent
          : undefined) ??
        (() => {
          const legacy = previous.get(`.gitdrop/media/${item.id}.webp`);
          return legacy && (!copy.cover.imageHash || mediaHash(legacy) === copy.cover.imageHash)
            ? legacy
            : undefined;
        })();
      const target = file.replace(/\.json$/, '.webp');
      if (image) {
        output.set(target, image);
        copy.cover.imageFile = path.posix.basename(target);
        copy.cover.imageHash = mediaHash(image);
      }
    }
    output.set(file, Buffer.from(JSON.stringify(copy, null, 2) + '\n'));
    manifest[item.id] = { hash: hash(copy), path: file, record: copy };
  }
  const orderedPaths = Object.fromEntries(sortedRecords.map((item) => [item.id, paths[item.id]]));
  const { records, ...state } = library;
  output.set('.gitdrop/state.json', Buffer.from(JSON.stringify(state, null, 2) + '\n'));
  output.set('.gitdrop/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  // Derived shards are disposable; source manifest is used to detect stale manual edits.
  const shards: Record<string, Item[]> = {};
  for (const item of sortedRecords) {
    const key = hash(item.id).slice(0, 2);
    (shards[key] ??= []).push(JSON.parse(output.get(paths[item.id])!.toString()));
  }
  for (const [key, items] of Object.entries(shards))
    output.set(`.gitdrop/index/${key}.json`, Buffer.from(JSON.stringify(items)));
  // Retain images needed by trash/recovery and unknown user files, but never obsolete record files.
  const known = new Set([
    ...Object.values(existingPaths),
    ...[...previous.keys()].filter((file) => !file.startsWith('.gitdrop/') && file.endsWith('.json')),
  ]);
  const managedImages = new Set([...known].map((file) => file.replace(/\.json$/, '.webp')));
  for (const [file, data] of previous)
    if (
      !output.has(file) &&
      !file.endsWith('.json') &&
      !known.has(file) &&
      !file.startsWith('.gitdrop/index/') &&
      !managedImages.has(file) &&
      !file.startsWith('.gitdrop/media/') &&
      file !== '.gitdrop/state.json' &&
      file !== '.gitdrop/manifest.json'
    )
      output.set(file, data);
  for (const [id, file] of Object.entries(existingPaths)) {
    const image = previous.get(file.replace(/\.json$/, '.webp'));
    if (image && library.tombstones[id]?.record) output.set(`.gitdrop/media/${id}.webp`, image);
  }
  const retainedHashes = new Set(
    [
      ...Object.values(library.tombstones).map((t) => t.record),
      ...Object.values(library.recovery).map((r) => r.record),
    ]
      .map((item) => item?.cover.imageHash)
      .filter(Boolean),
  );
  for (const [file, data] of previous)
    if (
      file.startsWith('.gitdrop/media/by-hash/') &&
      retainedHashes.has(mediaHash(data)) &&
      !output.has(file)
    )
      output.set(file, data);
  const sourceHashes = Object.fromEntries(
    [...output]
      .filter(([p]) => p.endsWith('.json') && !p.startsWith('.gitdrop/index/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, b]) => [p, gitBlobHash(b)]),
  );
  output.set(
    '.gitdrop/index/snapshot.json',
    Buffer.from(
      JSON.stringify({
        sourceHashes,
        library: { ...library, records: {} },
        paths: orderedPaths,
        shards: Object.keys(shards).map((key) => `.gitdrop/index/${key}.json`),
        shardHashes: Object.fromEntries(
          Object.keys(shards).map((key) => {
            const p = `.gitdrop/index/${key}.json`;
            return [p, gitBlobHash(output.get(p)!)];
          }),
        ),
      }),
    ),
  );
  return output;
}
