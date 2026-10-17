# Browser behavior

The interface shares one bookmark title across named URL variants. Creating a bookmark names its initial variant `Default`. Variant order and `defaultVariantId` are independent; promoting another default does not rename anything. The details panel edits names and URLs, changes the default, and moves variants up/down. The last variant cannot be removed. Search matches every variant name and URL. Duplicate detection searches all saved URLs when capturing a bookmark.

Manual bookmark order uses dragging onto another bookmark. Drop onto a collection in the sidebar to move into it. Collections drop into another collection by default; hold Shift while dropping to place before that sibling. The collection detail parent selector also supports moving collections back to top level.

The browser persists a confirmed snapshot and pending operations in IndexedDB under the server-provided account/repository scope. UI updates replay pending operations over confirmed data. Every update carries its base record for semantic reconciliation; retries retain their operation IDs. Hosted edits are disabled when offline, but existing queued operations remain. Desktop responses display `Saved locally` until the server reports completed remote synchronization.

A service worker caches the app shell and static assets, but never API responses. Offline browsing needs a prior successful online load. Signing out clears scoped IndexedDB and shell caches, and refuses while edits remain pending. Image covers are fetched on demand and are not guaranteed available offline.

Validation: `npm test -- tests/client.test.ts` checks scoped IndexedDB persistence, non-destructive pending replay, shared titles with Default variants, and accurate local-versus-remote status. Native browser and touch interaction verification should additionally exercise the rendered app.
