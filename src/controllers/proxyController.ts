import { Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { logger } from '../utils/logger';

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/x-icon',
]);

/**
 * Safely fetches an upstream image stream while intercepting and validating
 * every HTTP redirect hop against SSRF.
 */
async function fetchSafeImageStream(
  initialUrl: string,
  maxHops: number = 3
): Promise<AxiosResponse> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    const isSafe = await validateUrlAgainstSSRF(currentUrl);
    if (!isSafe) {
      throw new Error('SSRF Blocked: Target or redirect resolved to a restricted IP address.');
    }

    const response = await axios.get(currentUrl, {
      responseType: 'stream',
      maxRedirects: 0, // Disable automatic redirect following to inspect each hop
      validateStatus: (status) => (status >= 200 && status < 300) || (status >= 301 && status <= 308),
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
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

    // Validate Content-Type: strictly disallow HTML or executable SVGs to prevent XSS
    const headerVal = proxyRes.headers['content-type'];
    const rawContentType = (typeof headerVal === 'string' ? headerVal : String(headerVal || '')).toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMAGE_TYPES.has(rawContentType)) {
      proxyRes.data.destroy();
      res.status(415).json({ error: 'Unsupported media type: upstream content is not a supported image.' });
      return;
    }

    // Set hardened security headers
    res.setHeader('Content-Type', rawContentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    // Abort upstream stream if client disconnects early
    req.on('close', () => {
      if (!res.writableEnded) {
        proxyRes.data.destroy();
      }
    });

    proxyRes.data.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('ProxyController', `Upstream stream error for ${trimmedUrl.substring(0, 60)}:`, message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed during image streaming' });
      }
    });

    proxyRes.data.pipe(res);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('ProxyController', `Image proxy error for ${trimmedUrl.substring(0, 60)}:`, message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy image' });
    }
  }
};
