import { load } from 'cheerio';
import sharp from 'sharp';
import { safeFetch } from './safe-fetch';
import { HttpError } from './auth';

export async function optimizeImage(buffer: Buffer) {
  if (buffer.length > 8_000_000) throw new HttpError(413, 'Choose an image smaller than 8 MB.');
  let output = Buffer.alloc(0);
  for (const width of [1200, 900, 600, 400]) {
    output = await sharp(buffer, { limitInputPixels: 40_000_000, animated: false })
      .rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
    if (output.length <= 200_000) return output;
  }
  throw new HttpError(413, 'Unable to optimize this image below 200 KB.');
}
export async function fetchCover(imageUrl: string): Promise<Buffer> {
  const result = await safeFetch(imageUrl, 8_000_000);
  if (!result.type.startsWith('image/')) throw new Error('Cover URL did not return an image.');
  return optimizeImage(result.body);
}

export async function fetchMetadata(url: string) {
  const page = await safeFetch(url);
  if (!/text\/html|application\/xhtml\+xml/i.test(page.type))
    throw new HttpError(422, 'This URL does not serve an HTML page.');
  const $ = load(page.body.toString('utf8'));
  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text())
    .trim()
    .slice(0, 1000);
  const description = (
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    ''
  )
    .trim()
    .slice(0, 10000);
  const image =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content');
  let cover: Buffer | undefined;
  let warning: string | undefined;
  if (image) {
    try {
      cover = await fetchCover(new URL(image, page.url).href);
    } catch {
      warning = 'Title and description fetched; cover could not be downloaded.';
    }
  }
  return { title, description, cover, warning };
}
