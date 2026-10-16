import os from 'node:os';
import path from 'node:path';
import { LocalStore } from './local';
import { GitHubStore } from './github';
import type { Store } from './types';
let store: Store | undefined;
export function getStore(): Store {
  if (store) return store;
  if (process.env.GITDROP_MODE === 'github') {
    const [configuredOwner, configuredRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    const owner = configuredOwner || process.env.GITHUB_OWNER,
      repo = configuredRepo || process.env.GITHUB_REPO,
      token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token)
      throw new Error('Configure GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN');
    store = new GitHubStore(owner, repo, token, process.env.GITDROP_BRANCH || 'main');
  } else
    store = new LocalStore(
      path.resolve(process.env.GITDROP_DATA_DIR || path.join(os.homedir(), '.gitdrop', 'library')),
      process.env.GITDROP_BRANCH || 'main',
    );
  return store;
}
export { LocalStore, GitHubStore };
export type { Store, Snapshot } from './types';
