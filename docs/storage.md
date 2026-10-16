# Storage and synchronization

Initialize a dedicated data directory with `npm run library -- init /absolute/path`.
Set `GITDROP_DATA_DIR` to that path before launching Next.js. The default is
`~/.gitdrop/library` (resolved through the operating system home directory).
`npm run library -- clone <remote> <directory>` clones an existing initialized
repository. `npm run library -- sync <directory>` commits, fetches, semantically
merges, and pushes. A missing origin gives local-only operation; adding an empty
remote is supported. Git credentials are managed by your normal Git credential
helper, never stored in the bookmark repository.

Hosted configuration uses `GITDROP_MODE=github`, `GITHUB_REPOSITORY=owner/repo`,
`GITHUB_TOKEN`, and optional `GITDROP_BRANCH` (default `main`). Owner/repository
can alternatively be provided as `GITHUB_OWNER` and `GITHUB_REPO`. Initialize
and publish the data branch before using hosted mode.

Writes are serialized through an exclusive local lock and a replayable write
journal. External modifications detected before publication abort that write.
Malformed source files block writes and retain diagnostic messages. Ordinary folders, including empty local folders, are adopted on the next save
or sync by writing collection metadata.
External record removals are converted to persistent tombstones using the durable source manifest record, independently of disposable indexes. Do not edit `.gitdrop` derived state or synchronization metadata.

Git checkout synchronization never force pushes. Diverged heads become semantic
merge commits. Git object reads are batched. Hosted writes build trees and
commits, then update the branch without force; retries rebase the original
intent. Cover blobs are reused by Git object SHA for hosted moves, avoiding
image downloads and reuploads on ordinary edits.

Hosted reads use source-hash-validated, sharded snapshots. Stale or missing
snapshots fall back to canonical JSON reads with bounded concurrency. This cold
fallback is expensive for a large repository and can hit GitHub API quotas;
manual bulk changes should be followed by desktop sync to regenerate indexes.
The data branch must be exclusively for Gitdrop data. Unknown files are
preserved but are not part of the searchable library.

Tests use independent temporary checkouts and a local bare Git remote. A real
GitHub authenticated publication and Windows filesystem behavior require live
integration verification. Automatic Git history pruning is not implemented.

Local media scans use streaming Git blob hashes and cache them by file stat;
cover bytes are represented internally by lightweight file/Git references.
Only changed cover files are staged or materialized, one at a time. The write
journal references staged files so a crash can replay without buffering the
whole image library. Concurrent cover choices merge by cover revision and hash;
displaced image bytes stay addressable by hash while recovery or trash retains
them. The `exportEntries()` async generator yields one file at a time for streaming
ZIP delivery. Local export holds the library lock until completion or generator
cancellation; hosted export pins an immutable Git tree. The compatibility
`exportFiles()` helper buffers the full archive and should only be used for
small fixtures or callers that explicitly accept that memory cost.

## Physical filesystem benchmark

Run `node --import tsx tests/benchmark-storage.ts 10000` with Node 24. The script
creates a temporary library with 10,000 bookmarks and one 20 KiB cover file per
bookmark (195 MiB total cover bytes), measures operations, and removes it.
The files use a reusable cover-sized buffer; this measures storage I/O rather
than image decoding or metadata fetching.

Observed locally after content-reference equality and bounded scanner caching improvements:

| Operation | Time |
| --- | --- |
| Encode and write 20,260 files | 2.43 s |
| Cold read, including streaming image hashes | 2.41 s |
| Warm read | 0.91 s |
| Single bookmark note mutation | 2.81 s |

Sampled process peak RSS was 622 MiB (530 MiB above baseline), peak JS heap
150 MiB, and peak array buffers 93 MiB. These include the fixture-construction
objects retained by the benchmark, not just the storage adapter. A note edit
preserves unchanged image file timestamps. Local metadata operations still scan
the repository for external edits; this remains the primary performance cost.

The scanner caps concurrent file operations at 32 and caches unchanged buffers
using modification time, change time, and size. Newly read files are checked
again after reading; concurrent external changes abort the scan rather than
publishing a mixed snapshot.
