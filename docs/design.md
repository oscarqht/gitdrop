# Implementation map

The approved design is implemented in these boundaries:

- `src/domain`: validated schema, named URL variants, fractional ordering, operations, search and semantic three-way merge. Logical revisions and deterministic recovery IDs avoid relying on device wall clocks for conflict winners.
- `src/storage`: readable repository codec, lazy media references, atomic/journaled local storage, real Git reconciliation, GitHub tree/blob/commit adapter, immutable exported snapshots and setup CLI.
- `src/server`: owner-only GitHub authentication, same-origin write validation, bounded public-URL fetch with DNS address pinning, cover optimization, metadata provenance, streaming exports, shared route handlers and local sync worker.
- `src/client`: IndexedDB snapshots, authored-operation queue, optimistic replay, scoped caching and offline-mode gating.
- `src/components`: responsive collections, bookmark grid/list, details, named URL variants, emoji/image cover editing, trash and recovery.
- `public/sw.js`: application-shell and static-asset caching, without caching private API responses.

## Data rules

Files and folders are authoritative. Local paths infer collection membership. Derived index shards are used only when source Git blob hashes and index hashes validate. External edits invalidate those hashes and use the source-file read path.

URL variants are `{id,name,url,order}` records. `defaultVariantId` is explicit. The main bookmark title never becomes a variant name. Metadata comes from the selected default URL and updates only eligible shared fields. Per-field provenance prevents refresh from overwriting manual edits, including same-text edits.

Large media is represented by Git blob hashes and lazy local/Git references during normal reads and merges. Concurrent cover winners use the selected record hash; displaced images are retained only when referenced by trash/recovery.

## Delivery limits

The implementation has automated local multi-checkout and simulated GitHub coverage. Real account OAuth, a deployed Vercel runtime, and native Windows filesystem/process behavior require an environment-specific smoke test. The repository has not been deployed or pushed as part of implementation.
