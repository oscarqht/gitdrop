import os from 'node:os';
import path from 'node:path';
import { LocalStore } from './local';
import { GitHubStore } from './github';
import type { Store } from './types';

export type GitHubCredentials = {
  repository?: string;
  token?: string;
  branch?: string;
};

export function parseGitHubRepo(raw?: string | null): { owner: string; repo: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const slugMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (slugMatch) return { owner: slugMatch[1], repo: slugMatch[2] };
  const urlMatch = trimmed.match(/github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
  return null;
}

const stores = new Map<string, Store>();

export function getStore(credentials?: GitHubCredentials): Store {
  if (process.env.GITDROP_MODE === 'github') {
    const rawRepo = credentials?.repository || process.env.GITHUB_REPOSITORY;
    const token = credentials?.token || process.env.GITHUB_TOKEN;
    const branch = credentials?.branch || process.env.GITDROP_BRANCH || 'main';

    let owner = process.env.GITHUB_OWNER;
    let repo = process.env.GITHUB_REPO;

    const parsed = parseGitHubRepo(rawRepo);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    } else if (rawRepo && rawRepo.includes('/')) {
      const parts = rawRepo.split('/');
      owner = parts[0];
      repo = parts[1];
    }

    if (!owner || !repo || !token) {
      throw new Error('Configure GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN or connect your repository in Settings.');
    }

    const key = `github:${owner}/${repo}:${token}:${branch}`;
    let store = stores.get(key);
    if (!store) {
      store = new GitHubStore(owner, repo, token, branch);
      stores.set(key, store);
    }
    return store;
  }

  const key = `local:${process.env.GITDROP_DATA_DIR || 'default'}:${process.env.GITDROP_BRANCH || 'main'}`;
  let store = stores.get(key);
  if (!store) {
    store = new LocalStore(
      path.resolve(process.env.GITDROP_DATA_DIR || path.join(os.homedir(), '.gitdrop', 'library')),
      process.env.GITDROP_BRANCH || 'main',
    );
    stores.set(key, store);
  }
  return store;
}

export { LocalStore, GitHubStore };
export type { Store, Snapshot } from './types';
