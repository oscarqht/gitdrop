import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { HttpError } from './auth';

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export function validatePublicUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, 'Enter a valid public HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new HttpError(400, 'Only public HTTP(S) URLs on standard ports are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  )
    throw new HttpError(400, 'Private-network addresses are not supported.');
  return url;
}
export async function safeFetch(
  input: string,
  maxBytes = 2_000_000,
  redirects = 0,
): Promise<{ body: Buffer; type: string; url: string }> {
  if (redirects > 4) throw new HttpError(400, 'Too many redirects.');
  const url = validatePublicUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new HttpError(504, 'DNS lookup timed out.')), 10000);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new HttpError(400, 'Private-network addresses are not supported.');
  // Pin the checked address into the socket lookup to prevent DNS rebinding.
  const result = await new Promise<{
    body: Buffer;
    type: string;
    location?: string;
    status: number;
  }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'GET',
        agent: false,
        headers: {
          'User-Agent': 'Gitdrop/0.1 (+bookmark metadata)',
          'Accept-Encoding': 'identity',
        },
        lookup: ((_hostname: unknown, options: { all?: boolean }, callback: Function) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }) as http.RequestOptions['lookup'],
      },
      (response) => {
        const status = response.statusCode || 500;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.destroy();
          resolve({ body: Buffer.alloc(0), type: '', status, location: response.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new HttpError(422, `Page returned HTTP ${status}.`));
          return;
        }
        if (Number(response.headers['content-length'] || 0) > maxBytes) {
          response.destroy();
          reject(new HttpError(413, 'Remote content is too large.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new HttpError(413, 'Remote content is too large.'));
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks),
            type: response.headers['content-type'] || '',
            status,
          }),
        );
      },
    );
    const timer = setTimeout(
      () => request.destroy(new HttpError(504, 'Remote request timed out.')),
      10000,
    );
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
  if (result.location)
    return safeFetch(new URL(result.location, url).href, maxBytes, redirects + 1);
  return { ...result, url: url.href };
}
