# Gitdrop

A personal bookmark library stored as readable JSON files and collection folders in a private Git repository. Desktop clients work offline; a hosted Next.js client accesses the same repository through GitHub APIs.

## Run locally

Requires Node.js 22+ (Node 24 recommended) and Git. Dependencies are locked in package-lock.json.

```sh
npm ci --include=dev
npm run launch
```

The launcher opens http://127.0.0.1:3000. Alternatively use `npm run dev` and open that address yourself. The first library request initializes an Inbox in `~/.gitdrop/library`. Set `GITDROP_DATA_DIR` to an absolute path to use another directory. Keep this data directory separate from the application's source checkout.

For a production local server, run `npm run build` followed by `npm start`. Keep the terminal process running for background synchronization. Closing the browser tab is fine; exiting the server or sleeping the device pauses sync.

Do not set a custom `NODE_ENV`: Next's dev/build/start commands select the correct environment themselves.

## Connect your private repository

Create an empty private GitHub repository. Initialize and publish your local data:

```sh
npm run library -- init
npm run library -- sync
```

The second command initializes the local Git repository and makes a local commit. Configure `origin` in the printed data directory using your normal Git SSH or credential-helper setup, then run sync again:

```sh
git -C "$HOME/.gitdrop/library" remote add origin git@github.com:YOUR_ACCOUNT/YOUR_DATA_REPO.git
npm run library -- sync
```

On another device:

```sh
npm run library -- clone git@github.com:YOUR_ACCOUNT/YOUR_DATA_REPO.git /absolute/path/to/library
```

Set `GITDROP_DATA_DIR` to that destination when launching. PowerShell users set environment variables with `$env:GITDROP_DATA_DIR = 'C:\Users\you\Gitdrop'`. The configured branch defaults to `main`; use `GITDROP_BRANCH` consistently on all clients.

The server starts an automatic sync worker after the first library request, then syncs every 60 seconds. Local saves are immediate; commits and publication are batched at sync time. `Sync now` also runs the same serialized pipeline. Without an origin, the library stays usable and the status remains local. External valid file edits are detected on reads and sync; browser views refresh periodically and on focus.

## Hosted deployment

Deploy this Next.js application to Vercel, with a Node.js 22+ runtime. Initialize and push the data repository from a desktop first. Configure these server environment variables:

| Variable | Value |
| --- | --- |
| `GITDROP_MODE` | `github` |
| `GITHUB_REPOSITORY` | `owner/private-data-repository` |
| `GITHUB_TOKEN` | Fine-grained PAT limited to this repository, Contents read/write |
| `GITDROP_BRANCH` | `main`, or the shared data branch |
| `GITDROP_APP_URL` | Exact HTTPS deployment origin |
| `GITDROP_GITHUB_USER` | Your allowed GitHub login |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GITDROP_SESSION_SECRET` | Random secret of at least 32 characters |

Create a GitHub OAuth application with callback URL `https://YOUR_DOMAIN/api/auth/callback`. Sign-in authorizes only the configured owner. OAuth login identifies the user; the separately configured repository token performs data access. Neither token belongs in the data repo or browser code.

The hosted client publishes commits without force-updating the branch. Races trigger semantic reconciliation and bounded retries. Rate-limit errors remain visible and pending for retry. There is no durable Vercel filesystem dependency.

Unchanged hosted refreshes check the remote revision without reloading the full library; cover requests use their immutable image hashes. The browser keeps an IndexedDB snapshot and pending operations, renders optimistically, and revalidates against GitHub. Cached data and the application shell support offline browsing after a successful online load. Hosted edits are disabled when offline is detected; already pending changes remain queued. Browser storage is a cache, not a backup. Sign-out clears private browser state; pending edits must sync or be exported first.

## Bookmark and collection behavior

- A bookmark has one shared title, description, Markdown note, tags, and cover.
- Each URL variant has a stable ID, **name**, URL, and manual order. The initial name is `Default`.
- The selected default URL is independent of variant ordering and names. It controls opening the bookmark and fetching metadata.
- Variants can be added, renamed, edited, reordered, removed, and selected as default. At least one must remain.
- Metadata never changes variant names. Automatically fetched title/description can refresh until manually edited.
- Covers support automatic image, custom image, emoji, or none. Switching to emoji keeps the image available.
- Collections and bookmarks support manual ordering, moves, tags, and human-readable paths.
- Search includes all variant names/URLs, shared title, description, and note. Tags support all/any matching.
- Deletions go to Trash. Conflict alternatives appear in Recovery. Clearing them does not rewrite Git history.
- Export includes streamed ZIP containing the data files, and bookmarks HTML containing all URL variants.

## Files and synchronization

Collection metadata lives in `_collection.json`; covers in `_collection.webp`. Bookmark JSON and cover share a basename. IDs inside JSON survive renames/moves. `.gitdrop` contains manifests, derived index shards, tombstones, recovery data, and retained media.

Valid external edits are adopted. Ordinary folders become collections when adopted by the scanner. Malformed records and duplicate IDs remain untouched with diagnostics; publishing pauses until repaired. Do not place symlinks or arbitrary unrelated data in the library.

Gitdrop merges by immutable IDs and logical field revisions, not Git text-conflict markers. Different field and variant changes combine. Conflicting values have deterministic winners with recovery copies. Deletions retain tombstones; stale clients cannot resurrect purged items. Collection deletions carry the subtree observed by the author so concurrent new/edited content can be rescued.

See [domain details](domain.md), [storage details](storage.md), and [UI details](ui/README.md).

## Validation

```sh
npm test
npm run test:coverage
npm run typecheck
npm run build
```

Tests use temporary data repositories and a local bare remote; they never push to your GitHub account. Hosted transport tests use a simulated GitHub API. See [verification](verification.md) for measured evidence and remaining platform checks.

V1 intentionally excludes imports, browser extensions, bookmarklets, native sharing, page archives, attachments, multi-user sharing, installers, and an OS background service.
