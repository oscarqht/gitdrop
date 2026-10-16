import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { homedir } from 'node:os';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const hosted = () => process.env.GITDROP_MODE === 'github';
function secret() {
  const value = process.env.GITDROP_SESSION_SECRET;
  if (!value || value.length < 32)
    throw new HttpError(
      503,
      'Configure GITDROP_SESSION_SECRET with at least 32 random characters.',
    );
  return value;
}
export function sign(value: object): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('base64url')}`;
}
export function verify(token: string): Record<string, unknown> | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data && typeof data.exp === 'number' && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
export function cookie(request: Request, name: string) {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}
export function appOrigin(request: Request) {
  if (hosted()) {
    const configured = process.env.GITDROP_APP_URL;
    if (!configured) throw new HttpError(503, 'Configure GITDROP_APP_URL.');
    const url = new URL(configured);
    if (url.protocol !== 'https:')
      throw new HttpError(503, 'Hosted GITDROP_APP_URL must use HTTPS.');
    return url.origin;
  }
  const requestUrl = new URL(request.url);
  const incomingHost = request.headers.get('host');
  const url = incomingHost ? new URL(`${requestUrl.protocol}//${incomingHost}`) : requestUrl;
  if (incomingHost && (url.username || url.password || url.pathname !== '/'))
    throw new HttpError(403, 'Local server only accepts loopback requests.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new HttpError(403, 'Local server only accepts loopback requests.');
  return url.origin;
}
export function requireAccess(request: Request, mutate = false) {
  const origin = appOrigin(request);
  if (
    mutate &&
    (request.headers.get('origin') !== origin ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  ) {
    throw new HttpError(403, 'Same-origin request required.');
  }
  if (hosted()) {
    const data = verify(cookie(request, 'gitdrop-session'));
    const owner = process.env.GITDROP_GITHUB_USER?.toLowerCase();
    if (!owner || data?.user !== owner || data?.purpose !== 'session')
      throw new HttpError(401, 'Sign in with the configured GitHub account.');
  }
}
export function sessionScope() {
  return createHash('sha256')
    .update(
      hosted()
        ? `github:${process.env.GITDROP_GITHUB_USER}:${process.env.GITHUB_REPOSITORY}:${process.env.GITDROP_BRANCH || 'main'}`
        : `local:${process.env.GITDROP_DATA_DIR || `${homedir()}/.gitdrop/library`}`,
    )
    .digest('hex');
}
export function oauthStart(request: Request) {
  const origin = appOrigin(request);
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!hosted() || !clientId) throw new HttpError(503, 'Configure GitHub OAuth for hosted mode.');
  const state = randomBytes(32).toString('hex');
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', clientId);
  target.searchParams.set('redirect_uri', `${origin}/api/auth/callback`);
  target.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.href,
      'Set-Cookie': sessionCookie(
        'gitdrop-oauth',
        sign({ state, purpose: 'oauth', exp: Date.now() + 600_000 }),
        600,
      ),
    },
  });
}
export function sessionCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${hosted() ? '; Secure' : ''}`;
}
export async function oauthCallback(request: Request) {
  const origin = appOrigin(request);
  const url = new URL(request.url);
  const pending = verify(cookie(request, 'gitdrop-oauth'));
  if (
    !pending ||
    pending.purpose !== 'oauth' ||
    pending.state !== url.searchParams.get('state') ||
    !url.searchParams.get('code')
  )
    throw new HttpError(403, 'Invalid or expired sign-in attempt.');
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get('code'),
      redirect_uri: `${origin}/api/auth/callback`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) throw new HttpError(401, 'GitHub sign-in failed.');
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15000),
  });
  const user = await userResponse.json();
  const login = typeof user.login === 'string' ? user.login.toLowerCase() : '';
  if (!userResponse.ok || !login || login !== process.env.GITDROP_GITHUB_USER?.toLowerCase())
    throw new HttpError(403, 'This GitHub account is not the configured owner.');
  const headers = new Headers({ Location: origin });
  headers.append(
    'Set-Cookie',
    sessionCookie(
      'gitdrop-session',
      sign({ user: login, purpose: 'session', exp: Date.now() + 7 * 86400_000 }),
      7 * 86400,
    ),
  );
  headers.append('Set-Cookie', sessionCookie('gitdrop-oauth', '', 0));
  return new Response(null, { status: 302, headers });
}
