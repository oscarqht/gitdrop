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

it('accepts SSH and HTTPS repository URLs and rejects embedded credentials or Git transports', async () => {
  const { repositoryUrl } = await import('../src/storage/repository');
  for (const url of [
    'git@github.com:owner/library.git',
    'ssh://git@github.com/owner/library.git',
    'ssh://git@example.test:2222/library.git',
    'https://github.com/owner/library.git',
  ])
    expect(repositoryUrl(` ${url} `)).toBe(url);
  for (const url of [
    '',
    '-repo',
    'ext::command',
    '/tmp/repo',
    'file:///tmp/repo',
    'https://token@github.com/owner/repo',
    'ssh://git:token@example.test/repo',
    'https://example.test',
    'https://example.test/repo?token=secret',
  ])
    expect(() => repositoryUrl(url)).toThrow('Invalid repository URL');
});

it('validates optional GitHub personal access tokens, encodes auth headers, and namespaces git credentials', async () => {
  const {
    parseCredentialPassword,
    repositoryAuthHeader,
    repositoryCredentialHost,
    repositoryCredentialInput,
    repositoryToken,
  } = await import('../src/storage/repository');
  expect(repositoryToken()).toBeUndefined();
  expect(repositoryToken('   ')).toBeUndefined();
  expect(repositoryToken(' github_pat_12345_abc ')).toBe('github_pat_12345_abc');
  expect(repositoryAuthHeader('ghp_test123')).toBe(
    `Authorization: Basic ${Buffer.from('x-access-token:ghp_test123').toString('base64')}`,
  );
  const hostA = repositoryCredentialHost('https://github.com/owner/repo-a.git');
  const hostB = repositoryCredentialHost('https://github.com/owner/repo-b.git');
  expect(hostA).toMatch(/^[0-9a-f]{16}\.gitdrop\.local$/);
  expect(hostB).toMatch(/^[0-9a-f]{16}\.gitdrop\.local$/);
  expect(hostA).not.toBe(hostB);
  expect(
    repositoryCredentialInput('https://github.com/owner/repo-a.git', 'ghp_test123'),
  ).toBe(`protocol=https\nhost=${hostA}\nusername=gitdrop\npassword=ghp_test123\n\n`);
  expect(
    parseCredentialPassword(`protocol=https\nhost=${hostA}\nusername=gitdrop\npassword=ghp_test123\n`),
  ).toBe('ghp_test123');
  expect(parseCredentialPassword('protocol=https\nhost=github.com\n')).toBeUndefined();
  for (const bad of ['ghp_with space', 'ghp_with\nnewline', 'x'.repeat(513)]) {
    expect(() => repositoryToken(bad)).toThrow('Invalid GitHub personal access token');
  }
});

