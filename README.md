# Gitdrop

A local-first personal bookmark manager. Your collections are folders, bookmarks are JSON files, and a private GitHub repository keeps devices in sync.

Each bookmark has a shared title and one or more named URL variants. Variants have independent ordering and default selection. Covers can be images or emoji.

```sh
# Node.js 22+ and Git
npm ci --include=dev
npm run launch
```

The default data directory is `~/.gitdrop/library`, separate from this application repository.

See [setup and usage](docs/README.md), [implementation design](docs/design.md), and [verification](docs/verification.md). Hosted mode requires your own GitHub repository credentials and owner-only OAuth configuration.
