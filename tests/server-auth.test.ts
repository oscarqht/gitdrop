import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appOrigin,
  cookie,
  HttpError,
  oauthCallback,
  oauthStart,
  requireAccess,
  sessionCookie,
  sessionScope,
  sign,
  verify,
} from '../src/server/auth';
import { handler, readBody, readJson } from '../src/server/http';
const request = (url = 'http://127.0.0.1:3000', headers: Record<string, string> = {}) =>
  new Request(url, { headers });
beforeEach(() => {
  vi.stubEnv('GITDROP_MODE', 'local');
  vi.stubEnv('GITDROP_SESSION_SECRET', 'a'.repeat(40));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('local request boundary', () => {
  it('rejects non-loopback hosts and foreign origins', () => {
    expect(() => requireAccess(request('http://attacker.test'))).toThrow('loopback');
    expect(() => requireAccess(request(undefined, { origin: 'https://evil.test' }), true)).toThrow(
      'Same-origin',
    );
    expect(() =>
      requireAccess(
        request(undefined, { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'cross-site' }),
        true,
      ),
    ).toThrow();
    expect(() =>
      requireAccess(request(undefined, { origin: 'http://127.0.0.1:3000' }), true),
    ).not.toThrow();
  });
  it('uses validated incoming loopback Host when Next normalizes request URL', () => {
    expect(() =>
      requireAccess(
        request('http://localhost:3000', {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
        }),
        true,
      ),
    ).not.toThrow();
    expect(() =>
      requireAccess(
        request('http://localhost:3000', { host: 'evil.example', origin: 'http://evil.example' }),
        true,
      ),
    ).toThrow('loopback');
  });
  it('bounds JSON input and handles malformed JSON', async () => {
    await expect(
      readJson(new Request('http://localhost', { method: 'POST', body: '{' })),
    ).rejects.toThrow('Invalid JSON');
    await expect(
      readBody(new Request('http://localhost', { method: 'POST', body: '12345' }), 4),
    ).rejects.toThrow('too large');
    await expect(
      readBody(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'content-length': '20' },
          body: '1',
        }),
        4,
      ),
    ).rejects.toThrow('too large');
    expect(
      await readJson(new Request('http://localhost', { method: 'POST', body: '{"ok":true}' })),
    ).toEqual({ ok: true });
  });
  it('does not disclose internal exceptions', async () => {
    const response = await handler(async () => {
      throw new Error('token=secret-value');
    })(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret-value');
    expect(
      (
        await handler(async () => {
          throw new HttpError(409, 'Conflict');
        })(request())
      ).status,
    ).toBe(409);
  });
});
it('rejects malformed signed payload and authority-shaped Host headers', () => {
  const payload = Buffer.from('{').toString('base64url');
  const signature = createHmac('sha256', 'a'.repeat(40)).update(payload).digest('base64url');
  expect(verify(`${payload}.${signature}`)).toBeNull();
  for (const host of ['user@localhost:3000', 'localhost:3000/path'])
    expect(() => appOrigin(request('http://localhost:3000', { host }))).toThrow('loopback');
});
describe('hosted session authentication', () => {
  beforeEach(() => {
    vi.stubEnv('GITDROP_MODE', 'github');
    vi.stubEnv('GITDROP_APP_URL', 'https://gitdrop.example');
    vi.stubEnv('GITDROP_GITHUB_USER', 'owner');
    vi.stubEnv('GITHUB_CLIENT_ID', 'client');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');
  });
  it('requires configured HTTPS origin and strong secret', () => {
    vi.stubEnv('GITDROP_APP_URL', 'http://gitdrop.example');
    expect(() => appOrigin(request())).toThrow('HTTPS');
    vi.stubEnv('GITDROP_APP_URL', '');
    expect(() => appOrigin(request())).toThrow('Configure');
    vi.stubEnv('GITDROP_SESSION_SECRET', 'short');
    expect(() => sign({})).toThrow('32');
  });
  it('rejects expiry, signature tampering, wrong owners and purpose', () => {
    expect(verify(sign({ exp: 0 }))).toBeNull();
    expect(verify('invalid')).toBeNull();
    const good = sign({ exp: Date.now() + 10000, user: 'owner', purpose: 'session' });
    expect(verify(good + 'x')).toBeNull();
    expect(() =>
      requireAccess(request('https://gitdrop.example', { cookie: `gitdrop-session=${good}` })),
    ).not.toThrow();
    for (const value of [
      { user: 'other', purpose: 'session' },
      { user: 'owner', purpose: 'oauth' },
    ])
      expect(() =>
        requireAccess(
          request('https://gitdrop.example', {
            cookie: `gitdrop-session=${sign({ ...value, exp: Date.now() + 10000 })}`,
          }),
        ),
      ).toThrow('Sign in');
    expect(cookie(request(undefined, { cookie: 'a=1; b=hello' }), 'b')).toBe('hello');
    expect(sessionCookie('test', 'value', 10)).toContain('Secure');
  });
  it('scopes cached libraries to account and repository', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'a/b');
    const first = sessionScope();
    vi.stubEnv('GITHUB_REPOSITORY', 'a/c');
    expect(sessionScope()).not.toBe(first);
  });
  it('validates OAuth state and owner before issuing a session', async () => {
    const start = oauthStart(request('https://gitdrop.example/api/auth/login'));
    const location = new URL(start.headers.get('location')!);
    expect(location.hostname).toBe('github.com');
    const state = location.searchParams.get('state')!;
    const pending = start.headers.get('set-cookie')!.split(';')[0];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'temporary' }))
      .mockResolvedValueOnce(Response.json({ login: 'Owner' }));
    vi.stubGlobal('fetch', fetchMock);
    const callback = await oauthCallback(
      request(`https://gitdrop.example/api/auth/callback?state=${state}&code=abc`, {
        cookie: pending,
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('set-cookie')).toContain('gitdrop-session=');
    await expect(
      oauthCallback(
        request('https://gitdrop.example/api/auth/callback?state=wrong&code=abc', {
          cookie: pending,
        }),
      ),
    ).rejects.toThrow('Invalid');
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'temporary' }))
      .mockResolvedValueOnce(Response.json({ login: 'stranger' }));
    await expect(
      oauthCallback(
        request(`https://gitdrop.example/api/auth/callback?state=${state}&code=abc`, {
          cookie: pending,
        }),
      ),
    ).rejects.toThrow('configured owner');
  });
  it('allows any signed-in GitHub user when GITDROP_GITHUB_USER is unset', async () => {
    vi.stubEnv('GITDROP_GITHUB_USER', '');
    const userSession = sign({ exp: Date.now() + 10000, user: 'any-user', purpose: 'session' });
    expect(() =>
      requireAccess(request('https://gitdrop.example', { cookie: `gitdrop-session=${userSession}` })),
    ).not.toThrow();

    const start = oauthStart(request('https://gitdrop.example/api/auth/login'));
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const pending = start.headers.get('set-cookie')!.split(';')[0];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'temporary' }))
      .mockResolvedValueOnce(Response.json({ login: 'any-new-user' }));
    vi.stubGlobal('fetch', fetchMock);
    const callback = await oauthCallback(
      request(`https://gitdrop.example/api/auth/callback?state=${state}&code=abc`, {
        cookie: pending,
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('set-cookie')).toContain('gitdrop-session=');
  });
  it('allows access without OAuth session when GITHUB_CLIENT_ID is not set', () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    vi.stubEnv('GITDROP_SESSION_SECRET', '');
    expect(() => requireAccess(request('https://gitdrop.example'))).not.toThrow();
    expect(() => oauthStart(request('https://gitdrop.example/api/auth/login'))).toThrow('Configure GitHub OAuth');
  });
});
