import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ default: { request: mocks.request } }));
vi.mock('node:https', () => ({ default: { request: mocks.request } }));
import { safeFetch } from '../src/server/safe-fetch';
type Reply = { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean };
function replies(...items: Reply[]) {
  mocks.request.mockImplementation((_url: URL, options: any, callback: Function) => {
    const reply = items.shift() || {};
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => {
      req.emit('error', error);
      req.emit('close');
      return req;
    };
    req.end = () => {
      if (reply.hang) return;
      queueMicrotask(() => {
        const response = new PassThrough() as any;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers || { 'content-type': 'text/html' };
        callback(response);
        if (!response.destroyed) response.end(reply.body || 'hello');
        req.emit('close');
      });
    };
    options.lookup('example.com', {}, (err: unknown, address: string) => {
      expect(err).toBeNull();
      expect(address).toBe('1.1.1.1');
    });
    options.lookup('example.com', { all: true }, (err: unknown, addresses: any[]) => {
      expect(err).toBeNull();
      expect(addresses[0].address).toBe('1.1.1.1');
    });
    return req;
  });
}
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  mocks.request.mockReset();
});
afterEach(() => vi.useRealTimers());
describe('bounded pinned public fetch', () => {
  it('pins validated DNS addresses and reads successful content', async () => {
    replies({ body: '<title>Good</title>' });
    const r = await safeFetch('https://example.com');
    expect(r.body.toString()).toContain('Good');
    expect(mocks.request.mock.calls[0][1].agent).toBe(false);
  });
  it('validates every redirect target before opening another connection', async () => {
    replies({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private-network');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('follows relative redirects', async () => {
    replies({ status: 302, headers: { location: '/next' } }, { body: 'arrived' });
    expect((await safeFetch('http://example.com')).url).toBe('http://example.com/next');
  });
  it('fetches metadata through a long redirect chain such as google.com/ai', async () => {
    const targets = [
      'https://www.google.com/ai',
      '/aimode',
      '/search?udm=50&aep=11',
      '/search?aep=11',
      '/webhp?aep=11',
      '/sorry/index?continue=webhp',
      '/webhp?aep=11&google_abuse=exemption',
    ];
    replies(
      ...targets.map((location) => ({ status: 302, headers: { location } })),
      { body: '<title>Google</title>' },
    );
    const { fetchMetadata } = await import('../src/server/metadata');
    expect((await fetchMetadata('https://google.com/ai')).title).toBe('Google');
    expect(mocks.request).toHaveBeenCalledTimes(8);
    expect(mocks.lookup).toHaveBeenCalledTimes(8);
    expect(mocks.request.mock.calls[7][0].href).toBe(new URL(targets[6], targets[0]).href);
  });
  it('bounds redirect loops', async () => {
    replies(...Array.from({ length: 12 }, () => ({ status: 302, headers: { location: '/loop' } })));
    await expect(safeFetch('https://example.com')).rejects.toThrow('Too many');
    expect(mocks.request).toHaveBeenCalledTimes(11);
  });
  it('rejects private targets even after a long public redirect chain', async () => {
    replies(
      ...Array.from({ length: 6 }, (_, index) => ({
        status: 302,
        headers: { location: `/step-${index}` },
      })),
      { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } },
    );
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private-network');
    expect(mocks.request).toHaveBeenCalledTimes(7);
  });
  it('rejects error statuses and declared or streamed oversized content', async () => {
    replies({ status: 404 });
    await expect(safeFetch('https://example.com')).rejects.toThrow('HTTP 404');
    replies({ headers: { 'content-length': '100' } });
    await expect(safeFetch('https://example.com', 10)).rejects.toThrow('too large');
    replies({ body: 'this is too much' });
    await expect(safeFetch('https://example.com', 4)).rejects.toThrow('too large');
  });
  it('bounds DNS and socket timeouts', async () => {
    vi.useFakeTimers();
    mocks.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const dns = safeFetch('https://example.com');
    const checkDns = expect(dns).rejects.toThrow('DNS');
    await vi.advanceTimersByTimeAsync(10001);
    await checkDns;
    replies({ hang: true });
    const socket = safeFetch('https://example.com');
    const checkSocket = expect(socket).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10001);
    await checkSocket;
  });
  it('refuses empty DNS responses', async () => {
    mocks.lookup.mockResolvedValue([]);
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private-network');
  });
});
