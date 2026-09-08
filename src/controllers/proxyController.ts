import { Request, Response } from 'express';
import axios from 'axios';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { logger } from '../utils/logger';

export const imageProxyController = async (req: Request, res: Response): Promise<void> => {
  const imageUrl = req.query.url as string;

  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
    res.status(400).json({ error: "Missing 'url' query parameter" });
    return;
  }

  const trimmedUrl = imageUrl.trim();

  // SSRF Protection
  const isSafe = await validateUrlAgainstSSRF(trimmedUrl);
  if (!isSafe) {
    res.status(403).json({ error: 'Blocked: Target URL resolved to an invalid or private address.' });
    return;
  }

  try {
    const proxyRes = await axios.get(trimmedUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      },
      maxRedirects: 5,
      timeout: 7000,
    });

    // Forward the content type (e.g., image/jpeg)
    const contentType = proxyRes.headers['content-type'];
    if (contentType) {
      res.setHeader('Content-Type', contentType as string);
    }

    // Set aggressive browser & CDN caching (24 hours cache, 7 days stale-while-revalidate)
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    // Abort upstream stream if client disconnects early
    req.on('close', () => {
      if (!res.writableEnded) {
        proxyRes.data.destroy();
      }
    });

    proxyRes.data.on('error', (err: any) => {
      logger.warn('ProxyController', `Upstream stream error for ${trimmedUrl.substring(0, 60)}:`, err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed during image streaming' });
      }
    });

    // Pipe the image stream directly to the client
    proxyRes.data.pipe(res);
  } catch (error: any) {
    logger.warn('ProxyController', `Image proxy error for ${trimmedUrl.substring(0, 60)}:`, error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy image' });
    }
  }
};
