import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
vi.mock('../src/server/safe-fetch', () => ({ safeFetch: vi.fn() }));
import { safeFetch } from '../src/server/safe-fetch';
import { fetchMetadata } from '../src/server/metadata';
beforeEach(() => vi.mocked(safeFetch).mockReset());
describe('metadata extraction', () => {
  it('extracts OpenGraph fields and resolves a relative image safely', async () => {
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({
        body: Buffer.from(
          '<title>Fallback</title><meta property="og:title" content="Named page"><meta property="og:description" content="Description"><meta property="og:image" content="/image.png">',
        ),
        type: 'text/html',
        url: 'https://example.com/page',
      })
      .mockResolvedValueOnce({
        body: image,
        type: 'image/png',
        url: 'https://example.com/image.png',
      });
    const result = await fetchMetadata('https://example.com/page');
    expect(result.title).toBe('Named page');
    expect(result.description).toBe('Description');
    expect(result.cover?.length).toBeGreaterThan(0);
    expect(safeFetch).toHaveBeenLastCalledWith('https://example.com/image.png', 8000000);
  });
  it('uses title/description fallback and keeps text if an image fails', async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({
        body: Buffer.from(
          '<title>Fallback</title><meta name="description" content="Body"><meta name="twitter:image" content="/bad">',
        ),
        type: 'text/html',
        url: 'https://example.com',
      })
      .mockResolvedValueOnce({
        body: Buffer.from('html'),
        type: 'text/html',
        url: 'https://example.com/bad',
      });
    const result = await fetchMetadata('https://example.com');
    expect(result.title).toBe('Fallback');
    expect(result.warning).toContain('cover');
    expect(result.cover).toBeUndefined();
  });
  it('rejects non-HTML pages and supports pages with no metadata', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce({
      body: Buffer.alloc(0),
      type: 'application/pdf',
      url: 'https://example.com',
    });
    await expect(fetchMetadata('https://example.com')).rejects.toThrow('HTML');
    vi.mocked(safeFetch).mockResolvedValueOnce({
      body: Buffer.from('<html/>'),
      type: 'text/html',
      url: 'https://example.com',
    });
    expect((await fetchMetadata('https://example.com')).title).toBe('');
  });
});
