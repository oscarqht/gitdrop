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
  const isGithubMode = (api.data?.mode ?? api.mode) === 'github';

  const load = useCallback(
    async (updateInput = true) => {
      if (typeof window !== 'undefined') {
        const localRepo = localStorage.getItem('gitdrop:github_repository');
        const localToken = localStorage.getItem('gitdrop:github_token');
        if (localRepo) {
          const repoData: RepositoryInfo = {
            url: localRepo,
            branch: 'main',
            hasToken: !!localToken,
          };
          setRepository(repoData);
          onRepositoryChange?.(repoData);
          if (updateInput) setUrl(localRepo);
        }
      }
      try {
        const response = await fetch('/api/repository');
        const data = await response.json();
        if (response.ok) {
          setRepository(data);
          onRepositoryChange?.(data);
          if (updateInput) setUrl(data.url || '');
        }
      } catch {
        /* ignore */
      }
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

  function openModal(tab?: SettingsTab) {
    if (tab) setActiveTab(tab);
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
        onClick={() => openModal()}
      >
        <GitBranch size={15} />
        <span className="ellipsis">
          {repository?.url
            ? 'Repository settings'
            : 'Connect repository'}
          <small className="ellipsis">
            {repository?.url || (isGithubMode ? 'Set GitHub repository to sync' : 'Set remote Git URL to sync')}
          </small>
        </span>
        {repository?.url ? (
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
                    const trimmedUrl = url.trim();
                    const trimmedToken = token.trim();

                    if (isGithubMode) {
                      if (!trimmedUrl) {
                        setError('Please enter a GitHub repository (e.g. owner/repo).');
                        setBusy(false);
                        return;
                      }
                      const storedToken =
                        typeof window !== 'undefined'
                          ? localStorage.getItem('gitdrop:github_token') || ''
                          : '';
                      const effectiveToken = trimmedToken || storedToken;
                      if (!effectiveToken) {
                        setError('Please enter your GitHub personal access token.');
                        setBusy(false);
                        return;
                      }
                      if (typeof window !== 'undefined') {
                        localStorage.setItem('gitdrop:github_repository', trimmedUrl);
                        if (trimmedToken) localStorage.setItem('gitdrop:github_token', trimmedToken);
                      }
                    }

                    const payload = trimmedToken
                      ? { url: trimmedUrl, token: trimmedToken }
                      : { url: trimmedUrl };
                    const saved = await api.action('/api/repository', JSON.stringify(payload));
                    try {
                      await load(!!saved);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                    setBusy(false);
                    if (saved) {
                      setToken('');
                      setOpen(false);
                      if (isGithubMode) {
                        await api.refresh();
                      }
                    }
                  }}
                >
                  <h3>Connect your repository</h3>
                  <p>
                    {isGithubMode
                      ? 'Use a private GitHub repository to store your bookmark library in readable JSON files.'
                      : 'Use an empty private repository or an existing Gitdrop library. Your local bookmarks are kept.'}
                  </p>
                  <label>
                    {isGithubMode ? 'GitHub repository' : 'Git repository URL'}
                    <input
                      autoFocus
                      required
                      maxLength={2048}
                      disabled={busy}
                      value={url}
                      placeholder={
                        isGithubMode
                          ? 'owner/repo or https://github.com/owner/repo.git'
                          : 'https://github.com/you/your-library.git'
                      }
                      onChange={(event) => setUrl(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    GitHub personal access token{' '}
                    {repository?.hasToken
                      ? isGithubMode
                        ? '(saved in browser)'
                        : '(saved on server)'
                      : isGithubMode
                        ? '(required)'
                        : '(optional)'}
                    <input
                      type="password"
                      maxLength={512}
                      disabled={busy}
                      value={token}
                      placeholder={
                        repository?.hasToken
                          ? isGithubMode
                            ? 'Saved in browser — enter a new token to replace'
                            : 'Saved on server — enter a new token to replace'
                          : 'github_pat_... or ghp_...'
                      }
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <p className="repository-help">
                    {isGithubMode
                      ? 'Enter a fine-grained GitHub PAT with Contents read/write access. Saved securely in your browser local storage.'
                      : 'Enter a GitHub PAT with repository Contents read/write access to connect a private repository, or leave blank to use existing server Git credentials.'}
                  </p>
                  <p className="repository-help">
                    {isGithubMode
                      ? 'Changes are committed directly to your repository branch.'
                      : `The URL and token are remembered on this server${repository ? ` for branch ${repository.branch}` : ''}. Sync runs automatically while the server is running.`}
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
                    <button className="primary" disabled={busy || !url.trim()}>
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
