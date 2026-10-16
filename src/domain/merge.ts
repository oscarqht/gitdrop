import { diffArrays } from 'diff';
import {
  clone,
  compareRevision,
  editableFields,
  stable,
  sortedVariants,
  type Item,
  type Library,
  type Revision,
  type URLVariant,
} from './types';
import { createLibrary } from './operations';
import { orderBetween } from './order';
function hash(s: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ s.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
function changed(a: unknown, b: unknown) {
  return stable(a) !== stable(b);
}
function newer<T extends { revision: Revision }>(a: T, b: T): T {
  const n = compareRevision(a.revision, b.revision);
  return n > 0 ? a : n < 0 ? b : stable(a) > stable(b) ? a : b;
}
function recover(out: Library, item: Item, reason: string) {
  const id = hash(stable({ item, reason }));
  if (out.clearedRecovery?.[id]) return;
  out.recovery[id] = {
    id,
    recordId: item.id,
    reason,
    record: clone(item),
    createdAt: item.updatedAt,
  };
}
export function mergeTags(base: string[], a: string[], b: string[]): string[] {
  const original = new Set(base);
  const left = new Set(a);
  const right = new Set(b);
  return [...new Set([...a, ...b])]
    .filter((t) => !original.has(t) || (left.has(t) && right.has(t)))
    .sort();
}
interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}
function edits(base: string[], value: string[]): LineEdit[] {
  const result: LineEdit[] = [];
  let position = 0;
  let pending: LineEdit | undefined;
  for (const change of diffArrays(base, value)) {
    if (!change.added && !change.removed) {
      if (pending) {
        result.push(pending);
        pending = undefined;
      }
      position += change.value.length;
    } else {
      pending ??= { start: position, end: position, lines: [] };
      if (change.removed) {
        position += change.value.length;
        pending.end = position;
      } else pending.lines.push(...change.value);
    }
  }
  if (pending) result.push(pending);
  return result;
}
export function mergeNotes(base: string, a: string, b: string): string | null {
  if (a === b) return a;
  if (a === base) return b;
  if (b === base) return a;
  const lines = base.split('\n');
  const left = edits(lines, a.split('\n'));
  const right = edits(lines, b.split('\n'));
  const combined = [...left];
  for (const y of right) {
    let duplicate = false;
    for (const x of left) {
      if (stable(x) === stable(y)) {
        duplicate = true;
        break;
      }
      if (x.start === y.start || !(x.end <= y.start || y.end <= x.start)) return null;
    }
    if (!duplicate) combined.push(y);
  }
  for (const change of combined.sort((m, n) => n.start - m.start))
    lines.splice(change.start, change.end - change.start, ...change.lines);
  return lines.join('\n');
}
function mergeVariants(
  out: Library,
  base: Item | undefined,
  a: Item,
  b: Item,
): URLVariant[] | undefined {
  if (a.kind !== 'bookmark') return undefined;
  const original = new Map((base?.variants ?? []).map((v) => [v.id, v]));
  const left = new Map((a.variants ?? []).map((v) => [v.id, v]));
  const right = new Map((b.variants ?? []).map((v) => [v.id, v]));
  const result: URLVariant[] = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const av = left.get(id),
      bv = right.get(id),
      ov = original.get(id);
    if (!av || !bv) {
      const remaining = (av ?? bv)!;
      if (ov) {
        if (changed(remaining, ov)) recover(out, av ? a : b, `Variant ${id} edited while removed`);
        continue;
      }
      result.push(clone(remaining));
      continue;
    }
    const value = { id, name: '', url: '', order: '' };
    for (const field of ['name', 'url', 'order'] as const) {
      if (av[field] === bv[field]) value[field] = av[field];
      else if (ov && av[field] === ov[field]) value[field] = bv[field];
      else if (ov && bv[field] === ov[field]) value[field] = av[field];
      else {
        const ar =
            a.fieldRevisions?.[`variant:${id}:${field}`] ??
            a.fieldRevisions?.variants ??
            a.revision,
          br =
            b.fieldRevisions?.[`variant:${id}:${field}`] ??
            b.fieldRevisions?.variants ??
            b.revision;
        const winner =
          compareRevision(ar, br) > 0
            ? a
            : compareRevision(ar, br) < 0
              ? b
              : stable(av[field]) > stable(bv[field])
                ? a
                : b;
        value[field] = winner === a ? av[field] : bv[field];
        recover(out, winner === a ? b : a, `Concurrent variant ${id} ${field} edit`);
      }
    }
    result.push(value);
  }
  if (!result.length) {
    // Concurrent removal of different variants must not leave an unusable bookmark.
    const winner = newer(a, b);
    const retained =
      winner.variants?.find((v) => v.id === winner.defaultVariantId) ?? winner.variants?.[0];
    if (retained) {
      result.push(clone(retained));
      recover(out, winner, 'Concurrent variant removals retained one URL');
    }
  }
  return result;
}
function mergeItem(out: Library, base: Item | undefined, a: Item, b: Item): Item {
  if (!changed(a, b)) return clone(a);
  const result = clone(newer(a, b));
  result.fieldRevisions = { ...result.fieldRevisions };
  for (const key of new Set([
    ...Object.keys(a.fieldRevisions ?? {}),
    ...Object.keys(b.fieldRevisions ?? {}),
  ])) {
    const ar = a.fieldRevisions?.[key],
      br = b.fieldRevisions?.[key];
    result.fieldRevisions[key] = ar && br ? (compareRevision(ar, br) >= 0 ? ar : br) : (ar ?? br)!;
  }
  for (const field of editableFields) {
    const av = a[field];
    const bv = b[field];
    const original = base?.[field];
    const ar = a.fieldRevisions?.[field] ?? a.revision;
    const br = b.fieldRevisions?.[field] ?? b.revision;
    let value: unknown;
    let revision = compareRevision(ar, br) >= 0 ? ar : br;
    if (field === 'variants') value = mergeVariants(out, base, a, b);
    else if (!changed(av, bv)) value = av;
    else if (base && !changed(av, original)) {
      value = bv;
      revision = br;
    } else if (base && !changed(bv, original)) {
      value = av;
      revision = ar;
    } else if (field === 'tags') value = mergeTags(base?.tags ?? [], a.tags, b.tags);
    else {
      const note = field === 'note' ? mergeNotes(base?.note ?? '', a.note, b.note) : null;
      if (note !== null) value = note;
      else {
        const winner =
          compareRevision(ar, br) > 0
            ? a
            : compareRevision(ar, br) < 0
              ? b
              : stable(av) > stable(bv)
                ? a
                : b;
        value = winner[field];
        recover(out, winner === a ? b : a, `Concurrent ${field} edit`);
      }
    }
    (result as unknown as Record<string, unknown>)[field] = value;
    result.fieldRevisions[field] = revision;
  }
  for (const field of ['title', 'description'] as const) {
    const markers = [a.metadata?.[field], b.metadata?.[field]].filter(
      (marker): marker is { value: string; revision: Revision } => !!marker,
    );
    if (!markers.length) continue;
    const matching = markers.filter(
      (marker) =>
        marker.value === result[field] &&
        compareRevision(marker.revision, result.fieldRevisions![field]) === 0,
    );
    const marker = (matching.length ? matching : markers)
      .sort(
        (a, b) =>
          compareRevision(a.revision, b.revision) ||
          (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
      )
      .at(-1)!;
    result.metadata ??= {};
    result.metadata[field] = clone(marker);
  }
  if (result.kind === 'bookmark' && !result.variants?.some((v) => v.id === result.defaultVariantId))
    result.defaultVariantId = sortedVariants(result)[0]?.id;
  return result;
}
function repairParents(out: Library) {
  const orphaned: Item[] = [];
  for (const item of Object.values(out.records).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    if (!item.parentId) continue;
    const parent = out.records[item.parentId];
    if (!parent || parent.kind !== 'collection') {
      recover(out, item, 'Parent collection removed');
      orphaned.push(item);
      continue;
    }
    const seen = new Set([item.id]);
    let current: string | null = item.parentId;
    while (current) {
      if (seen.has(current)) {
        recover(out, item, 'Concurrent moves formed a cycle');
        item.parentId = null;
        break;
      }
      seen.add(current);
      current = out.records[current]?.parentId ?? null;
    }
  }
  if (orphaned.length) {
    const id = 'gitdrop-recovered';
    if (!out.records[id]) {
      const time = orphaned.map((i) => i.updatedAt).sort()[0];
      out.records[id] = {
        id,
        kind: 'collection',
        title: 'Recovered',
        parentId: null,
        description: '',
        note: '',
        tags: [],
        order: orderBetween(),
        cover: { mode: 'emoji', emoji: '🛟' },
        createdAt: time,
        updatedAt: time,
        revision: { counter: 0, actor: 'system' },
      };
    }
    for (const item of orphaned) item.parentId = id;
  }
}
export function mergeLibraries(base: Library, local: Library, remote: Library): Library {
  const out = createLibrary();
  out.appliedOperations = [
    ...new Set([...local.appliedOperations, ...remote.appliedOperations]),
  ].sort();
  for (const id of new Set([
    ...Object.keys(local.clearedRecovery ?? {}),
    ...Object.keys(remote.clearedRecovery ?? {}),
  ])) {
    const a = local.clearedRecovery?.[id],
      b = remote.clearedRecovery?.[id];
    out.clearedRecovery ??= {};
    out.clearedRecovery[id] = a && b ? (compareRevision(a, b) >= 0 ? a : b) : (a ?? b)!;
  }
  // Recovery removals carry durable markers to resist stale clients.

  for (const id of new Set([...Object.keys(local.recovery), ...Object.keys(remote.recovery)])) {
    if (out.clearedRecovery?.[id]) continue;
    if (base.recovery[id] && (!local.recovery[id] || !remote.recovery[id])) continue;
    const a = local.recovery[id],
      b = remote.recovery[id];
    out.recovery[id] = clone(a && b ? (stable(a) > stable(b) ? a : b) : (a ?? b));
  }
  for (const id of new Set([...Object.keys(local.tombstones), ...Object.keys(remote.tombstones)])) {
    const a = local.tombstones[id],
      b = remote.tombstones[id];
    const tomb = clone(a && b ? newer(a, b) : (a ?? b));
    if (a && b && compareRevision(a.revision, b.revision) === 0) {
      const restores = [a.restoredRevision, b.restoredRevision]
        .filter((r): r is Revision => !!r)
        .sort(compareRevision);
      if (restores.length) tomb.restoredRevision = restores[restores.length - 1];
    }
    const purges = [a?.purgedRevision, b?.purgedRevision]
      .filter((r): r is Revision => !!r)
      .sort(compareRevision);
    if (purges.length) tomb.purgedRevision = purges[purges.length - 1];
    if (tomb.purgedRevision && compareRevision(tomb.purgedRevision, tomb.revision) >= 0)
      delete tomb.record;
    if (base.tombstones[id]?.record && ((a && !a.record) || (b && !b.record))) delete tomb.record;
    out.tombstones[id] = tomb;
  }
  const ids = [
    ...new Set([
      ...Object.keys(base.records),
      ...Object.keys(local.records),
      ...Object.keys(remote.records),
    ]),
  ].sort();
  for (const id of ids) {
    const original = base.records[id];
    const a = local.records[id];
    const b = remote.records[id];
    const tomb = out.tombstones[id];
    let item = a && b ? mergeItem(out, original, a, b) : clone(a ?? b);
    if (!item) continue;
    // A record can outlive a tombstone only through an explicit restore already present on a side.
    const restored =
      tomb?.restoredRevision && compareRevision(item.revision, tomb.restoredRevision) >= 0;
    if (tomb && !restored) {
      if (original && changed(item, original)) {
        recover(out, item, 'Edited while deleted');
        const parentTomb = original.parentId ? out.tombstones[original.parentId] : undefined;
        if (
          parentTomb &&
          compareRevision(parentTomb.revision, tomb.revision) === 0 &&
          !out.records[original.parentId!]
        ) {
          // Deleting a collection must not erase a concurrent descendant edit.
          tomb.restoredRevision = item.revision;
          out.records[id] = item;
        }
      }
      continue;
    }
    out.records[id] = item;
  }
  repairParents(out);
  return out;
}
