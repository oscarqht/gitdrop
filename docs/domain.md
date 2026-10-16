# Domain contract

`Library` is a normalized working snapshot. Filesystem paths are an adapter concern; `parentId` represents physical folder membership after loading. Every record has immutable identity, a Lamport revision, and field revisions. User operations update only editable fields and deduplicate using operation IDs.

`applyOperation` returns a cloned snapshot. Create/update validate records and parent relationships. Delete recursively tombstones a collection's currently known descendants. Purge removes trash payload but retains the tombstone. Restore explicitly annotates the tombstone, preventing ordinary higher-counter edits from accidentally overriding deletion. Recovery is independently clearable.

`mergeLibraries(base, local, remote)` merges fields relative to a common ancestor. Concurrent scalars use field revision and actor ordering; the displaced record goes to recovery. Tags use three-way set membership. Notes use line-diff hunks to merge any disjoint edits, including multiple separated hunks from either client; true overlaps retain both versions through recovery. Deletion wins concurrent ordinary edits. Missing parents are rescued to a stable Recovered collection. Concurrent hierarchy cycles are broken deterministically and recorded.

Ordering uses fractional-indexing keys and immutable IDs as equal-key tie breakers. `orderBetween(before, after)` supports insertion without rewriting siblings. Equal concurrent keys render deterministically; moving between equal keys requires the adapter/UI to choose a neighboring distinct boundary or explicitly rebalance that sibling group.

Adapters must assign revisions to validated external edits before publishing, preserve base snapshots for three-way merging, and serialize mutations. Invalid external JSON must not be silently rewritten. Derived indexes never replace record files as source of truth.

Limits: note merging deliberately treats overlapping changes conservatively. Applied-operation identifiers and tombstones are retained indefinitely; future compaction requires a protocol acknowledging every client. Recovery clearing and purge carry durable revision markers, so old offline branches cannot reintroduce cleared conflict versions or purged trash payloads. These markers must be retained until a future client-acknowledged compaction protocol is introduced.


## URL variants

The bookmark owns one shared `title`. Its nonempty `variants` array contains `{id,name,url,order}` objects. `makeItem('bookmark', {title,url})` initializes a single variant named `Default`. Additional variant names must be nonempty. `defaultVariantId` references an existing variant and is independent of order and names: neither choosing a default nor moving a variant renames anything. `primaryVariant(item)` resolves the selected URL; `sortedVariants(item)` uses fractional order and ID ties.

Variant IDs survive reorder and edit. Reconciliation merges name, URL, and position independently by variant ID, combines independent additions, and honors removal while recovering conflicting edits. Concurrent removals that would empty a bookmark retain one deterministic variant and a recovery entry. Search includes every variant's name and URL. The legacy `url` input is only a factory convenience; persisted items never contain a top-level URL.


## Verification

Domain suite covers three-client delivery permutations, same-field displaced-value recovery, tags, notes, URL additions/removals/names/order/defaults, collection cycles, collection deletion versus concurrent descendant changes, recursive restoration, stale clients after purge, and stale recovery replay after clearing. A synthetic Node 24 run measured 10k / 50k minimal bookmark snapshots: JSON parse plus schema validation 68 / 296 ms; search 8 / 36 ms; one edit 20 / 103 ms; two-client merge 161 / 717 ms. These are local domain timings, not filesystem, image, browser, or network throughput guarantees.


Hosted stale collection deletion includes `Operation.baseRecords`, a full snapshot of the subtree known when the user authored deletion. `deletionBaseRecords(library,id)` creates that snapshot. Storage reconstructs the operation base from these records before applying deletion, so concurrently added or edited descendants survive through recovery. A single collection `base` item cannot safely express this intent.

Optional `cover.imageHash` is the lowercase 40-character Git blob SHA1 of the stored WebP. Cover arbitration selects this hash with the rest of the cover object; storage keeps conflicting binary payloads by hash so displaced images remain recoverable.

Automatic title and description enrichment persists `metadata[field] = {value, revision}`. The domain assigns the marker the actual field revision of a metadata operation. A manual edit retains the marker but advances the field revision, including an explicit same-value edit; refresh must require both value and revision to match the marker before replacing an automatically generated field. Semantic merge follows the chosen field's marker rather than treating metadata as an independently writable user field.
