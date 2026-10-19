// Keep publication batches larger than download concurrency to reduce GitHub commits.
export const IMPORT_COVER_BATCH_SIZE = 20;
export const IMPORT_COVER_CONCURRENCY = 4;
// Slow sites leave later entries pending for the next request rather than growing the batch indefinitely.
export const IMPORT_COVER_SCHEDULING_MS = 20_000;
