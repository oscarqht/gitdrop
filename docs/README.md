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

The dev and launch scripts explicitly use `NODE_ENV=development` and discard inherited `__NEXT_PRIVATE_STANDALONE_CONFIG`, so desktop hosts such as Trident cannot supply their own Next.js configuration. For build/start, let Next.js select its environment; do not set a custom `NODE_ENV`.

## Connect your private repository

Create an empty private GitHub repository, then open **Connect repository** at the bottom of the webapp sidebar. Paste its SSH or HTTPS Git URL, optionally enter a GitHub personal access token (PAT) with Contents read/write access, and choose **Save & sync**. Gitdrop initializes the local Git repository, commits your library, and publishes it. You can reopen **Repository settings** to view or update the URL or replace the saved token.

The URL and optional PAT are saved on the server in the data directory's `.git/config` and never committed to the library or returned to the browser. Restarting the server or reopening the browser reuses them automatically. No repository initialization commands are needed. You can either enter a GitHub PAT in the dialog or rely on SSH keys / a Git credential helper already configured on the server; always enter a URL without an embedded token or password. Connection errors leave local bookmarks safe and the configured URL and token available for retry.

On another device, launch Gitdrop and enter the same URL. An existing Gitdrop library is fetched and merged with local bookmarks before publishing. Use an empty repository or one containing a Gitdrop library; an unrelated repository is rejected without overwriting it.

The configured branch defaults to `main`; use `GITDROP_BRANCH` consistently on all clients. `GITDROP_DATA_DIR` chooses the local data directory. PowerShell users set environment variables with `$env:GITDROP_DATA_DIR = 'C:\Users\you\Gitdrop'`.

The CLI remains available for manual setup:

```sh
npm run library -- init
npm run library -- sync
git -C "$HOME/.gitdrop/library" remote add origin git@github.com:YOUR_ACCOUNT/YOUR_DATA_REPO.git
npm run library -- sync
# Alternatively clone on another device and launch with GITDROP_DATA_DIR set to the destination:
npm run library -- clone git@github.com:YOUR_ACCOUNT/YOUR_DATA_REPO.git /absolute/path/to/library
```

The server starts an automatic sync worker after the first library request, then syncs every 60 seconds. Local saves are immediate; commits and publication are batched at sync time. `Sync now` also runs the same serialized pipeline. Without an origin, the library stays usable and the status remains local. External valid file edits are detected on reads and sync; browser views refresh periodically and on focus.

## Hosted deployment

Deploy this Next.js application to Vercel with a Node.js 22+ runtime.

### Minimal setup (Personal Access Token)

Since the webapp allows users to configure their GitHub repository and Personal Access Token (PAT) directly in the Settings dialog (stored in the browser's `localStorage`), you do **not** need to set up a GitHub OAuth application unless you want an OAuth sign-in gate.

On Vercel, set these environment variables:

| Variable | Value | Description |
| --- | --- | --- |
| `GITDROP_MODE` | `github` | Enables hosted GitHub storage mode |
| `GITDROP_APP_URL` | `https://your-project.vercel.app` | (Optional) Your production HTTPS URL |

When opening the app, users will see the "Connect repository" button / prompt, where they enter their GitHub repository (`owner/repo`) and GitHub PAT (with `repo` Contents read/write permissions).

### Optional: GitHub OAuth Sign-In Gate

If you prefer to gate access behind GitHub OAuth, configure these additional environment variables:

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GITDROP_SESSION_SECRET` | Random secret of at least 32 characters |
| `GITDROP_GITHUB_USER` | (Optional) Restrict sign-in to a specific GitHub username. Leave unset to allow any GitHub user. |
| `GITDROP_BRANCH` | (Optional) `main`, or the shared data branch |

Create a GitHub OAuth application with authorization callback URL `https://YOUR_DOMAIN/api/auth/callback`.

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
