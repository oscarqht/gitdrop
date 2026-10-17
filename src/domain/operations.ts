import {
  clone,
  editableFields,
  idSchema,
  itemSchema,
  type Item,
  type Library,
  type Operation,
  type Revision,
} from './types';
import { orderBetween } from './order';
export function createLibrary(): Library {
  return { schemaVersion: 1, records: {}, tombstones: {}, recovery: {}, appliedOperations: [] };
}
export function nextRevision(library: Library, actor: string): Revision {
  let counter = 0;
  for (const item of Object.values(library.records)) {
    counter = Math.max(counter, item.revision.counter);
    for (const r of Object.values(item.fieldRevisions ?? {}))
      counter = Math.max(counter, r.counter);
  }
  for (const t of Object.values(library.tombstones))
    counter = Math.max(
      counter,
      t.revision.counter,
      t.restoredRevision?.counter ?? 0,
      t.purgedRevision?.counter ?? 0,
    );
  for (const r of Object.values(library.clearedRecovery ?? {}))
    counter = Math.max(counter, r.counter);
  return { counter: counter + 1, actor };
}
export function makeItem(
  kind: Item['kind'],
  input: Partial<Item> & { title: string; url?: string },
  actor = 'local',
): Item {
  const now = new Date().toISOString();
  const variants =
    input.variants ??
    (kind === 'bookmark' && input.url
      ? [{ id: crypto.randomUUID(), name: 'Default', url: input.url, order: orderBetween() }]
      : undefined);
  return itemSchema.parse({
    variants,
    defaultVariantId: input.defaultVariantId ?? variants?.[0]?.id,
    id: crypto.randomUUID(),
    kind,
    parentId: null,
    description: '',
    note: '',
    tags: [],
    order: orderBetween(),
    cover: kind === 'collection' ? { mode: 'emoji', emoji: '📁' } : { mode: 'automatic' },
    createdAt: now,
    updatedAt: now,
    revision: { counter: 0, actor },
    ...input,
  });
}
function checkParent(library: Library, item: Item) {
  const seen = new Set([item.id]);
  let parent = item.parentId;
  while (parent) {
    if (seen.has(parent)) throw new Error('Collection hierarchy cannot contain cycles');
    seen.add(parent);
    const p = library.records[parent];
    if (!p || p.kind !== 'collection') throw new Error('Parent collection does not exist');
    parent = p.parentId;
  }
}
export function applyOperation(library: Library, operation: Operation): Library {
  if (!['create', 'update', 'delete', 'restore', 'purge', 'clearRecovery'].includes(operation.type))
    throw new Error('Unknown operation type');
  if (!operation.id || !operation.actor) throw new Error('Operation ID and actor are required');
  if (library.appliedOperations.includes(operation.id)) return library;
  const next = clone(library);
  const revision = nextRevision(next, operation.actor);
  const now = new Date().toISOString();
  const id = operation.recordId ?? operation.record?.id;
  if (id) idSchema.parse(id);
  if (!id && !operation.records?.length && !['clearRecovery', 'purge'].includes(operation.type))
    throw new Error('Record ID required');
  if (operation.type === 'create') {
    const records = operation.records?.length
      ? operation.records
      : operation.record
        ? [{ ...operation.record, id: id! }]
        : [];
    if (!records.length) throw new Error('Record required');
    for (const raw of records) {
      const recordId = idSchema.parse(raw.id);
      if (next.records[recordId] || next.tombstones[recordId])
        throw new Error('Record ID already exists');
      const item = itemSchema.parse({
        ...raw,
        id: recordId,
        revision,
        updatedAt: now,
        fieldRevisions: Object.fromEntries(editableFields.map((f) => [f, revision])),
      });
      checkParent(next, item);
      next.records[recordId] = item;
    }
  } else if (operation.type === 'update') {
    const current = next.records[id!];
    if (!current) throw new Error('Record not found');
    const patch = Object.fromEntries(
      editableFields
        .filter((f) => operation.patch && Object.hasOwn(operation.patch, f))
        .map((f) => [f, operation.patch![f]]),
    );
    const item = itemSchema.parse({
      ...current,
      ...patch,
      revision,
      updatedAt: now,
      fieldRevisions: {
        ...current.fieldRevisions,
        ...Object.fromEntries(Object.keys(patch).map((f) => [f, revision])),
      },
    });
    if (operation.actor === 'metadata') {
      for (const field of ['title', 'description'] as const)
        if (Object.hasOwn(patch, field)) {
          item.metadata ??= {};
          item.metadata[field] = { value: item[field], revision };
        }
    }
    if (patch.variants) {
      const fields = item.fieldRevisions!;
      for (const variant of item.variants ?? []) {
        const old = current.variants?.find((v) => v.id === variant.id);
        for (const field of ['name', 'url', 'order'] as const)
          if (!old || variant[field] !== old[field])
            fields[`variant:${variant.id}:${field}`] = revision;
      }
    }
    checkParent(next, item);
    next.records[id!] = item;
  } else if (operation.type === 'delete') {
    if (!next.records[id!]) throw new Error('Record not found');
    const ids = new Set([id!]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of Object.values(next.records))
        if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
          ids.add(item.id);
          changed = true;
        }
    }
    for (const key of ids) {
      next.tombstones[key] = { id: key, revision, deletedAt: now, record: next.records[key] };
      delete next.records[key];
    }
  } else if (operation.type === 'restore') {
    const tomb = next.tombstones[id!];
    if (!tomb?.record) throw new Error('Deleted item is no longer available');
    const restoreIds = new Set([id!]);
    if (tomb.record.kind === 'collection') {
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of Object.values(next.tombstones)) {
          if (
            entry.record?.parentId &&
            restoreIds.has(entry.record.parentId) &&
            !restoreIds.has(entry.id) &&
            entry.revision.counter === tomb.revision.counter &&
            entry.revision.actor === tomb.revision.actor &&
            !next.records[entry.id]
          ) {
            restoreIds.add(entry.id);
            changed = true;
          }
        }
      }
    }
    for (const key of restoreIds) {
      const entry = next.tombstones[key];
      const record = { ...entry.record!, revision, updatedAt: now };
      if (record.parentId && !next.records[record.parentId] && !restoreIds.has(record.parentId))
        record.parentId = null;
      entry.restoredRevision = revision;
      next.records[key] = record;
    } // Keep tombstones to prevent older clients resurrecting stale edits.
  } else if (operation.type === 'purge') {
    for (const key of id ? [id] : Object.keys(next.tombstones)) {
      if (next.tombstones[key]?.record) {
        delete next.tombstones[key].record;
        next.tombstones[key].purgedRevision = revision;
      }
    }
  } else if (operation.type === 'clearRecovery') {
    next.clearedRecovery ??= {};
    for (const key of id ? [id] : Object.keys(next.recovery)) {
      next.clearedRecovery[key] = revision;
      delete next.recovery[key];
    }
  }
  next.appliedOperations.push(operation.id);
  return next;
}

/** Snapshot the complete subtree at the time a user requests deletion. */
export function deletionBaseRecords(library: Library, id: string): Item[] {
  idSchema.parse(id);
  if (!library.records[id]) return [];
  const children = new Map<string, Item[]>();
  for (const item of Object.values(library.records))
    if (item.parentId) {
      const bucket = children.get(item.parentId) ?? [];
      bucket.push(item);
      children.set(item.parentId, bucket);
    }
  const result: Item[] = [];
  const seen = new Set<string>();
  const pending = [library.records[id]];
  while (pending.length) {
    const item = pending.pop()!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(clone(item));
    pending.push(...(children.get(item.id) ?? []));
  }
  return result;
}
