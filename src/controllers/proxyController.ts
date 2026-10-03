import { Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { logger } from '../utils/logger';

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB ceiling

/**
 * Validates magic numbers (file signature) in the first bytes of the buffer
 * to confirm valid image types (image/jpeg, image/png, image/webp, image/gif, image/avif).
 * Explicitly excludes SVG, HTML, scripts, and non-image payloads.
 */
function detectImageMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF: GIF87a or GIF89a (47 49 46 38 37/39 61)
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: RIFF .... WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  // AVIF: ....ftypavif / ftypavis / ftypmif1
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
      return 'image/avif';
    }
  }

  return null;
}

/**
 * Safely fetches an upstream image stream while intercepting and validating
 * every HTTP redirect hop against SSRF.
 */
async function fetchSafeImageStream(
  initialUrl: string,
  maxHops: number = 3
): Promise<AxiosResponse<Readable>> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    const isSafe = await validateUrlAgainstSSRF(currentUrl);
    if (!isSafe) {
      throw new Error('SSRF Blocked: Target or redirect resolved to a restricted IP address.');
    }

    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Invalid protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
    }

    const response = await axios.get<Readable>(currentUrl, {
      responseType: 'stream',
      maxRedirects: 0, // Disable automatic redirect following to inspect each hop
      maxContentLength: MAX_IMAGE_SIZE_BYTES,
      maxBodyLength: MAX_IMAGE_SIZE_BYTES,
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 301 && status <= 308),
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*;q=0.8',
      },
      timeout: 7000,
    });

    // Check if redirect
    if (response.status >= 301 && response.status <= 308) {
      const redirectLocation = response.headers.location;
      if (!redirectLocation) {
        throw new Error('Redirect response missing Location header.');
      }
      // Clean up previous stream
      response.data.destroy();
      // Resolve relative redirects against current URL
      currentUrl = new URL(redirectLocation, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error('Too many redirects encountered while fetching image.');
}

export const imageProxyController = async (req: Request, res: Response): Promise<void> => {
  const imageUrl = req.query.url as string;

  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
    res.status(400).json({ error: "Missing 'url' query parameter" });
    return;
  }

  const trimmedUrl = imageUrl.trim();

  try {
    const proxyRes = await fetchSafeImageStream(trimmedUrl);
    const stream = proxyRes.data;

    // Check upstream content-type header first: strictly disallow SVG or scriptable types
    const rawHeader = proxyRes.headers['content-type'];
    const declaredContentType = (typeof rawHeader === 'string' ? rawHeader : String(rawHeader || ''))
      .toLowerCase()
      .split(';')[0]
      .trim();

    if (
      declaredContentType.includes('svg') ||
      declaredContentType.includes('html') ||
      declaredContentType.includes('javascript')
    ) {
      stream.destroy();
      res.status(415).json({ error: 'Unsupported media type: SVG and scriptable types are strictly prohibited.' });
      return;
    }

    // Read the first chunk to inspect magic number file signature
    const firstChunk = await new Promise<Buffer | null>((resolve, reject) => {
      let resolved = false;

      stream.once('data', (chunk: Buffer) => {
        resolved = true;
        resolve(chunk);
      });

      stream.once('end', () => {
        if (!resolved) resolve(null);
      });

      stream.once('error', (err) => {
        if (!resolved) reject(err);
      });
    });

    if (!firstChunk || firstChunk.length === 0) {
      stream.destroy();
      res.status(415).json({ error: 'Unsupported media type: empty upstream image payload.' });
      return;
    }

    // Verify magic bytes (file signature)
    const detectedMime = detectImageMimeFromBuffer(firstChunk);
    if (!detectedMime) {
      stream.destroy();
      res.status(415).json({ error: 'Unsupported media type: upstream payload lacks a valid image signature.' });
      return;
    }

    // Set hardened security headers
    res.setHeader('Content-Type', detectedMime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    // Abort upstream stream if client disconnects early
    req.on('close', () => {
      if (!res.writableEnded) {
        stream.destroy();
      }
    });

    let totalBytes = firstChunk.length;
    stream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_IMAGE_SIZE_BYTES) {
        logger.warn('ProxyController', `Image exceeded ${MAX_IMAGE_SIZE_BYTES} bytes limit for ${trimmedUrl.substring(0, 60)}`);
        stream.destroy();
        if (!res.headersSent) {
          res.status(413).json({ error: 'Image payload exceeded maximum allowed size.' });
        } else {
          res.destroy();
        }
      }
    });

    stream.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('ProxyController', `Upstream stream error for ${trimmedUrl.substring(0, 60)}:`, message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed during image streaming' });
      }
    });

    // Write verified first chunk and pipe remaining stream
    res.write(firstChunk);
    stream.pipe(res);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('ProxyController', `Image proxy error for ${trimmedUrl.substring(0, 60)}:`, message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy image' });
    }
  }
};
