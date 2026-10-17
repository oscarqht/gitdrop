'use client';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, Palette, X } from 'lucide-react';
import type { useLibrary } from '../client/use-library';
import { useCoverFit } from './cover';

export type RepositoryInfo = {
  url: string | null;
  branch: string;
  hasToken?: boolean;
};

export type SettingsTab = 'repository' | 'appearance';

export function RepositorySetup({
  api,
  open: controlledOpen,
  setOpen: setControlledOpen,
  onRepositoryChange,
  defaultTab = 'repository',
}: {
  api: ReturnType<typeof useLibrary>;
  open?: boolean;
  setOpen?: (open: boolean) => void;
  onRepositoryChange?: (repository: RepositoryInfo) => void;
  defaultTab?: SettingsTab;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = setControlledOpen ?? setUncontrolledOpen;
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab);
  const [coverFit, setCoverFit] = useCoverFit();
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
    if (api.data?.mode === 'github') return;
    void load().catch(() => {});
  }, [api.data?.mode, load]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, open, setOpen]);
  function openModal(tab?: SettingsTab) {
    if (tab) setActiveTab(tab);
    setError('');
    api.setError('');
    setOpen(true);
    if (api.data?.mode !== 'github') {
      void load().catch((e) => setError((e as Error).message));
    }
  }
  const isGithubMode = api.data?.mode === 'github';
  return (
    <>
      <button
        type="button"
        className="repository repository-button"
        disabled={api.disabled}
        onClick={() => openModal()}
      >
        <GitBranch size={15} />
        <span className="ellipsis">
          {isGithubMode
            ? 'Private repository'
            : repository?.url
              ? 'Repository settings'
              : 'Connect repository'}
          <small className="ellipsis">
            {isGithubMode
              ? 'Connected through GitHub'
              : repository?.url || 'Set remote Git URL to sync'}
          </small>
        </span>
        {isGithubMode || repository?.url ? (
          <span className="green-dot" />
        ) : (
          <span className="repository-action">Set URL</span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            className="modal-backdrop"
            onClick={() => {
              if (!busy) setOpen(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              className="modal repository-dialog settings-dialog"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="modal-close icon-button"
                aria-label="Close settings"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                <X size={19} />
              </button>
              <div className="settings-sidebar">
                <h2 id="settings-title" className="settings-title">
                  Settings
                </h2>
                <div
                  role="tablist"
                  aria-orientation="vertical"
                  aria-label="Settings"
                  className="settings-tabs"
                >
                  <button
                    type="button"
                    role="tab"
                    id="settings-tab-repository"
                    aria-selected={activeTab === 'repository'}
                    aria-controls="settings-panel-repository"
                    className={`settings-tab ${activeTab === 'repository' ? 'active' : ''}`}
                    onClick={() => setActiveTab('repository')}
                  >
                    <GitBranch size={15} />
                    <span>Connect your repository</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="settings-tab-appearance"
                    aria-selected={activeTab === 'appearance'}
                    aria-controls="settings-panel-appearance"
                    className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
                    onClick={() => setActiveTab('appearance')}
                  >
                    <Palette size={15} />
                    <span>Appearance</span>
                  </button>
                </div>
              </div>
              {activeTab === 'repository' ? (
                <form
                  role="tabpanel"
                  id="settings-panel-repository"
                  aria-labelledby="settings-tab-repository"
                  className="settings-panel"
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
                  <h3>Connect your repository</h3>
                  <p>
                    Use an empty private repository or an existing Gitdrop library. Your local
                    bookmarks are kept.
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
                    GitHub personal access token{' '}
                    {repository?.hasToken ? '(saved on server)' : '(optional)'}
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
                    Enter a GitHub PAT with repository Contents read/write access to connect a
                    private repository, or leave blank to use existing server Git credentials.
                  </p>
                  <p className="repository-help">
                    The URL and token are remembered on this server
                    {repository ? ` for branch ${repository.branch}` : ''}. Sync runs automatically
                    while the server is running.
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
              ) : (
                <div
                  role="tabpanel"
                  id="settings-panel-appearance"
                  aria-labelledby="settings-tab-appearance"
                  className="settings-panel"
                >
                  <h3>Appearance</h3>
                  <p>Customize how bookmark and collection covers are rendered.</p>
                  <label className="settings-option">
                    <div className="settings-option-text">
                      <span className="settings-option-label">Cover image rendering mode</span>
                      <span className="settings-option-desc">
                        Switch bookmark and collection cover images between <code>cover</code>{' '}
                        (default) and <code>contain</code> (CSS <code>object-fit</code>).
                      </span>
                    </div>
                    <span className="settings-switch-control">
                      <span
                        className={`settings-switch-mode ${coverFit === 'cover' ? 'active' : ''}`}
                      >
                        cover
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        className="settings-switch-input"
                        aria-label="Cover image rendering mode"
                        aria-checked={coverFit === 'contain'}
                        checked={coverFit === 'contain'}
                        onChange={(event) =>
                          setCoverFit(event.target.checked ? 'contain' : 'cover')
                        }
                      />
                      <span className="settings-switch-track" aria-hidden="true">
                        <span className="settings-switch-thumb" />
                      </span>
                      <span
                        className={`settings-switch-mode ${coverFit === 'contain' ? 'active' : ''}`}
                      >
                        contain
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export const SettingsDialog = RepositorySetup;

