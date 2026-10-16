import { afterEach, it, expect, vi } from 'vitest';
import path from 'node:path';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it('uses one configured local data directory and reuses the store', async () => {
  vi.stubEnv('GITDROP_MODE', 'local');
  vi.stubEnv('GITDROP_DATA_DIR', './fixture-only-not-created');
  const { getStore, LocalStore } = await import('../src/storage');
  const store = getStore();
  expect(store).toBeInstanceOf(LocalStore);
  expect((store as InstanceType<typeof LocalStore>).directory).toBe(
    path.resolve('./fixture-only-not-created'),
  );
  expect(getStore()).toBe(store);
});
it('requires hosted credentials and accepts the repository setting', async () => {
  vi.stubEnv('GITDROP_MODE', 'github');
  vi.stubEnv('GITHUB_REPOSITORY', '');
  vi.stubEnv('GITHUB_OWNER', '');
  vi.stubEnv('GITHUB_REPO', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  const { getStore, GitHubStore } = await import('../src/storage');
  expect(() => getStore()).toThrow('Configure');
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  expect(getStore()).toBeInstanceOf(GitHubStore);
});
