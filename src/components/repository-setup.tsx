'use client';
import { useCallback, useEffect, useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import type { useLibrary } from '../client/use-library';

export type RepositoryInfo = {
  url: string | null;
  branch: string;
  hasToken?: boolean;
};

export function RepositorySetup({
  api,
  open: controlledOpen,
  setOpen: setControlledOpen,
  onRepositoryChange,
}: {
  api: ReturnType<typeof useLibrary>;
  open?: boolean;
  setOpen?: (open: boolean) => void;
  onRepositoryChange?: (repository: RepositoryInfo) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = setControlledOpen ?? setUncontrolledOpen;
  const [repository, setRepository] = useState<RepositoryInfo>();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(
    async (updateInput = true) => {
      const response = await fetch('/api/repository');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load repository settings.');
      setRepository(data);
      onRepositoryChange?.(data);
      if (updateInput) setUrl(data.url || '');
    },
    [onRepositoryChange],
  );
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, open, setOpen]);
  function openModal() {
    setError('');
    api.setError('');
    setOpen(true);
    void load().catch((e) => setError((e as Error).message));
  }
  return (
    <>
      <button
        type="button"
        className="repository repository-button"
        disabled={api.disabled}
        onClick={openModal}
      >
        <GitBranch size={15} />
        <span className="ellipsis">
          {repository?.url ? 'Repository settings' : 'Connect repository'}
          <small className="ellipsis">
            {repository?.url || 'Set remote Git URL to sync'}
          </small>
        </span>
        {repository?.url ? (
          <span className="green-dot" />
        ) : (
          <span className="repository-action">Set URL</span>
        )}
      </button>
      {open && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="repository-title"
            className="modal repository-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              api.setError('');
              const payload = token.trim() ? { url, token: token.trim() } : { url };
              const saved = await api.action('/api/repository', JSON.stringify(payload));
              // Refresh even on sync failure: the saved origin is reusable for retries.
              try {
                await load(!!saved);
              } catch (e) {
                setError((e as Error).message);
              }
              setBusy(false);
              if (saved) {
                setToken('');
                setOpen(false);
              }
            }}
          >
            <button
              type="button"
              className="modal-close icon-button"
              aria-label="Close repository settings"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={19} />
            </button>
            <h2 id="repository-title">Connect your repository</h2>
            <p>
              Use an empty private repository or an existing Gitdrop library. Your local bookmarks
              are kept.
            </p>
            <label>
              Git repository URL
              <input
                autoFocus
                required
                maxLength={2048}
                disabled={busy}
                value={url}
                placeholder="https://github.com/you/your-library.git"
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              GitHub personal access token {repository?.hasToken ? '(saved on server)' : '(optional)'}
              <input
                type="password"
                maxLength={512}
                disabled={busy}
                value={token}
                placeholder={
                  repository?.hasToken
                    ? 'Saved on server — enter a new token to replace'
                    : 'github_pat_... or ghp_...'
                }
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="repository-help">
              Enter a GitHub PAT with repository Contents read/write access to connect a private
              repository, or leave blank to use existing server Git credentials.
            </p>
            <p className="repository-help">
              The URL and token are remembered on this server
              {repository ? ` for branch ${repository.branch}` : ''}. Sync runs automatically while
              the server is running.
            </p>
            {(error || api.error) && (
              <p role="alert" className="repository-error">
                {error || api.error}
              </p>
            )}
            <div className="modal-footer">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy || api.disabled || !url.trim()}>
                {busy ? 'Connecting & syncing…' : 'Save & sync'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
