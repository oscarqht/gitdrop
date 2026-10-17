import { applyOperation, deletionBaseRecords } from '../domain/operations';
import { mergeLibraries } from '../domain/merge';
import { itemSchema, type Library, type Operation } from '../domain/types';
/** Rebase a stale browser intent, never overwrite an entire current record. */
export function applyIntent(current: Library, operation: Operation): Library {
  if (current.appliedOperations.includes(operation.id)) return current;
  if (!operation.base || !['update', 'delete'].includes(operation.type))
    return applyOperation(current, operation);
  const item = itemSchema.parse(operation.base);
  if (item.id !== operation.recordId) throw new Error('Operation base ID mismatch');
  const base = structuredClone(current);
  if (operation.type === 'delete' && item.kind === 'collection') {
    if (!operation.baseRecords)
      throw new Error(
        'Collection deletion requires the original subtree snapshot; reload and retry',
      );
    for (const record of deletionBaseRecords(current, item.id)) delete base.records[record.id];
    for (const record of operation.baseRecords) {
      const parsed = itemSchema.parse(record);
      base.records[parsed.id] = parsed;
      delete base.tombstones[parsed.id];
    }
  }
  base.records[item.id] = item;
  delete base.tombstones[item.id];
  const local = applyOperation(base, operation);
  return mergeLibraries(base, local, current);
}
