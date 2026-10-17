import { createHash } from 'node:crypto';

/** Only credential-free HTTPS and SSH transports are accepted by web setup. */
export function repositoryUrl(value: string): string {
  const url = value.trim();
  const invalid = () => {
    throw new Error(
      'Invalid repository URL. Use an HTTPS or SSH Git URL without a password or token.',
    );
  };
  if (!url || url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(url)) return invalid();
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./~-]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (
      !['https:', 'ssh:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname === '/' ||
      !parsed.pathname ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === 'https:' && parsed.username) ||
      (parsed.username && !/^[a-zA-Z0-9._-]+$/.test(parsed.username))
    )
      return invalid();
    return url;
  } catch {
    return invalid();
  }
}

export function repositoryToken(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const token = value.trim();
  if (!token) return undefined;
  if (token.length > 512 || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new Error('Invalid GitHub personal access token.');
  }
  return token;
}

export function repositoryAuthHeader(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${credentials}`;
}

/**
 * Derive an isolated synthetic credential host per repository URL so storing
 * multiple Gitdrop PATs never collides with each other or the user's github.com login.
 */
export function repositoryCredentialHost(value: string): string {
  const url = repositoryUrl(value);
  const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return `${id}.gitdrop.local`;
}

export function repositoryCredentialInput(value: string, token?: string): string {
  const lines = [
    'protocol=https',
    `host=${repositoryCredentialHost(value)}`,
    'username=gitdrop',
  ];
  if (token !== undefined) lines.push(`password=${repositoryToken(token)!}`);
  return `${lines.join('\n')}\n\n`;
}

export function parseCredentialPassword(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('password=')) {
      return repositoryToken(line.slice('password='.length));
    }
  }
  return undefined;
}

