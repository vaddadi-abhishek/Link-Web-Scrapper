import { Request, Response } from 'express';
import { dispatchExtraction } from '../services/extractors';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { canonicalizeUrl, isResolvableShortlink, resolveShortlink } from '../utils/urlFormatter';
import { extractionCache } from '../utils/cache';
import { logger } from '../utils/logger';

const getUrlFromRequest = async (req: Request): Promise<string | null> => {
  const url = req.body?.url || req.query?.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return null;
  }
  
  const trimmedUrl = url.trim();
  const isSafe = await validateUrlAgainstSSRF(trimmedUrl);
  if (!isSafe) {
    throw new Error('Security Error: Invalid or internal URL provided (Possible SSRF attack blocked).');
  }
  
  return trimmedUrl;
};

export const extractMetadataController = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawUrl = await getUrlFromRequest(req);
    if (!rawUrl) {
      res.status(400).json({ error: "Missing or invalid 'url' parameter." });
      return;
    }

    let effectiveUrl = rawUrl.trim();
    if (isResolvableShortlink(effectiveUrl)) {
      effectiveUrl = await resolveShortlink(effectiveUrl);
    }

    // Canonicalize the URL (strips tracking query params, unifies /reels/ to /reel/, normalizes hostnames)
    const canonicalUrl = canonicalizeUrl(effectiveUrl) || effectiveUrl;
    
    const html = req.body?.html;
    const forceRefresh = Boolean(
      req.body?.forceRefresh ||
      req.body?.noCache ||
      req.query?.forceRefresh === 'true' ||
      req.query?.noCache === 'true'
    );

    // 1. Controller-Level Instant Cache Check
    // Returns full extracted metadata in <1ms on identical or tracking-parameterized URLs
    const metaCacheKey = `meta_${canonicalUrl}`;
    if (!forceRefresh && !html) {
      const cachedResponse = extractionCache.get(metaCacheKey);
      if (cachedResponse) {
        logger.info('ExtractController', `Instant Cache Hit (<1ms) for "${canonicalUrl}" (origin: "${rawUrl}")`);
        res.status(200).json({
          ...cachedResponse,
          url: rawUrl, // Preserve original requested URL
          canonical_url: canonicalUrl,
          cached: true,
        });
        return;
      }
    }

    // 2. Dispatch platform extraction with canonical URL
    const { result, platform, cached } = await dispatchExtraction(canonicalUrl, html, { forceRefresh });
    const siteName = deriveSiteName(canonicalUrl, result.ogSiteName);

    const fullResponse = {
      type: platform,
      url: rawUrl,
      canonical_url: canonicalUrl,
      title: result.title !== undefined ? result.title : null,
      description: result.description || '',
      logo: result.logo || null,
      site_name: siteName,
      card_data: result.card_data,
    };

    // Cache pure metadata response (30-minute TTL)
    if (!forceRefresh && !html && (result.title || result.description || result.card_data)) {
      extractionCache.set(metaCacheKey, fullResponse);
    }

    res.status(200).json({
      ...fullResponse,
      ...(cached ? { cached: true } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('ExtractController', 'Extraction error:', message);
    res.status(500).json({ error: 'Failed to extract metadata. Please try again later.' });
  }
};
