# Verification

Verified on this Mac using Node.js 24.21.0. Tests use temporary repositories and do not publish to a real GitHub account.

## Automated checks

- `npm run build`: production build passes, including Next.js TypeScript validation.
- `npm run test:coverage`: **106 tests pass across 12 files**.
- Instrumented domain/storage/server/client logic: **86.63% line coverage**, 83.01% statement coverage. React components are verified through browser smoke checks rather than included in these coverage figures.
- Authentication and public-network fetch guards each have **100% line coverage**. This measures executed lines, not a guarantee of complete security.
- Coverage enforces at least 80% overall lines and 100% lines for those two guard modules.
- `npm audit --omit=dev`: zero reported vulnerabilities.
- `git diff --check`: passes.

Regression coverage includes independent real Git checkouts against a temporary bare remote, concurrent field and image changes, stale subtree deletion, manual filesystem edits/deletion, missing control files, symlink rejection, durable purge/recovery markers, named variant merges, metadata provenance, archive cancellation, GitHub publication races, lost responses, rate limits, cache scope, and persisted browser queue replay.

Hosted transport uses a simulated GitHub API. Tests verify unchanged-head requests avoid full loads, cached objects remain isolated, direct image hashes are checked, and all branch updates are non-forced.

## Browser smoke checks

The running application was inspected in Chrome through browser-harness:

- Initialized an empty local library and created a bookmark by pasting a URL.
- Added a `Documentation` URL variant beside the initial `Default` item.
- Reordered variants and selected `Documentation` as default without changing either name.
- Changed the shared bookmark title and confirmed all values persisted through reload and API reads.
- Inspected desktop layout and a 390-pixel mobile viewport; mobile had no horizontal overflow.
- Loaded the production application, disabled network access, and fully reloaded it. The app shell and IndexedDB snapshot rendered the saved bookmark and both URL variants with a Cached state.
- Restored network access after the offline check.
- Confirmed a real metadata fetch of `https://example.com` returns `Example Domain`.

The smoke checks caught and fixed a Next.js localhost/127.0.0.1 origin normalization mismatch and development service-worker cache interference. Service workers are now enabled only in production.

## Scale evidence

`npm run benchmark:storage` creates a disposable physical library, measures it, and removes it afterward.

Measured 10,000 bookmarks with 10,000 20-KiB cover fixtures (195 MiB of covers; 20,260 files):

| Operation | Measured time |
| --- | ---: |
| Encode and fixture write | 2.43 s |
| Cold read | 2.41 s |
| Warm read | 0.91 s |
| Persist one note change | 2.81 s |

The UI applies changes optimistically. Filesystem persistence is still measured in seconds at this scale; no sub-100-ms persistence claim is made. Sampled peak RSS was 622 MiB, including the synthetic fixture objects and caches. This does not represent 10,000 maximum-size images or real WAN GitHub latency.

Separate synthetic domain benchmarks at 10k/50k records measured merge at 161/717 ms and search at 8/36 ms.

## Remaining environment checks

- Live owner-only GitHub OAuth and a real private GitHub repository require your credentials and configuration.
- A real Vercel deployment has not been performed or smoke-tested.
- Native Windows process/filesystem behavior, including long paths, has not been tested on Windows hardware.
- External programs do not honor Gitdrop's lock. File signatures, atomic replacements and a recovery journal detect/preserve many external changes, but do not provide transaction isolation against an arbitrary writer modifying files at precisely the same instant.
- Git history retains deleted/replaced content until separate history maintenance. The app does not rewrite history automatically.
