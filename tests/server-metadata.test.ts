import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPublicAddress, validatePublicUrl, safeFetch } from '../src/server/safe-fetch';
import { optimizeImage } from '../src/server/metadata';
import sharp from 'sharp';
import { lookup } from 'node:dns/promises';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
describe('public URL boundary', () => {
  it('rejects private, reserved, link-local and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'invalid',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects URL credentials, unsupported schemes and ports', () => {
    for (const url of [
      'file:///etc/passwd',
      'http://localhost',
      'http://device.local',
      'http://user:pass@example.com',
      'https://example.com:444',
      'http://2130706433',
      'http://[::1]',
      'bad',
    ])
      expect(() => validatePublicUrl(url), url).toThrow();
    expect(validatePublicUrl('https://example.com/a').hostname).toBe('example.com');
  });
  it('checks all resolved addresses before making a request', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(safeFetch('https://example.com')).rejects.toThrow('Private-network');
    await expect(safeFetch('https://example.com', 10, 5)).rejects.toThrow('redirects');
  });
  it('optimizes covers within size and dimension constraints', async () => {
    const input = await sharp({
      create: { width: 1800, height: 1400, channels: 3, background: '#77aa66' },
    })
      .png()
      .toBuffer();
    const output = await optimizeImage(input);
    const info = await sharp(output).metadata();
    expect(info.format).toBe('webp');
    expect(info.width).toBeLessThanOrEqual(1200);
    expect(output.length).toBeLessThanOrEqual(200000);
    await expect(optimizeImage(Buffer.alloc(8_000_001))).rejects.toThrow('8 MB');
    await expect(optimizeImage(Buffer.from('not an image'))).rejects.toThrow();
  });
});
