'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, X } from 'lucide-react';
import type { useLibrary } from '../client/use-library';

export function RepositorySetup({ api }: { api: ReturnType<typeof useLibrary> }) {
  const [repository, setRepository] = useState<{
    url: string | null;
    branch: string;
  }>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  async function load(updateInput = true) {
    const response = await fetch('/api/repository');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load repository settings.');
    setRepository(data);
    if (updateInput) setUrl(data.url || '');
  }
  useEffect(() => {
    void load().catch(() => {});
  }, []);
  return (
    <>
      <button
        className="repository repository-button"
        disabled={api.disabled}
        onClick={() => {
          setError('');
          api.setError('');
          dialog.current?.showModal();
          void load().catch((e) => setError(e.message));
        }}
      >
        <GitBranch size={15} />
        <span>
          {repository?.url ? 'Repository settings' : 'Connect repository'}
          <small>
            {repository?.url ? 'URL saved on this server' : 'Sync your library across devices'}
          </small>
        </span>
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="modal repository-dialog"
          aria-labelledby="repository-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              api.setError('');
              const saved = await api.action('/api/repository', JSON.stringify({ url }));
              // Refresh even on sync failure: the saved origin is reusable for retries.
              try {
                await load(!!saved);
              } catch (e) {
                setError((e as Error).message);
              }
              setBusy(false);
              if (saved) dialog.current?.close();
            }}
          >
            <button
              type="button"
              className="modal-close icon-button"
              aria-label="Close repository settings"
              disabled={busy}
              onClick={() => dialog.current?.close()}
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
                placeholder="git@github.com:you/your-library.git"
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="repository-help">
              SSH and HTTPS use Git credentials configured on the server. Enter a URL without a
              token or password.
            </p>
            <p className="repository-help">
              The URL is remembered on this server
              {repository ? ` for branch ${repository.branch}` : ''}. Sync runs automatically while
              the server is running.
            </p>
            {(error || api.error) && (
              <p role="alert" className="repository-error">
                {error || api.error}
              </p>
            )}
            <div className="modal-footer">
              <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
                Cancel
              </button>
              <button className="primary" disabled={busy || api.disabled || !url.trim()}>
                {busy ? 'Connecting & syncing…' : 'Save & sync'}
              </button>
            </div>
          </form>
        </dialog>,
        document.body,
      )}
    </>
  );
}
