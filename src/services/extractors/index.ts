import { ExtractionResult, PlatformExtractor } from './types';
import { redditExtractor } from './reddit';
import { twitterExtractor } from './twitter';
import { instagramExtractor } from './instagram';
import { facebookExtractor } from './facebook';
import { linkedInExtractor } from './linkedin';
import { youtubeExtractor } from './youtube';
import { globalWebExtractor } from './globalWeb';
import { extractionCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

export * from './types';

export interface DispatchOptions {
  forceRefresh?: boolean;
}

const PLATFORM_EXTRACTORS: Array<{ pattern: RegExp; extractor: PlatformExtractor }> = [
  { pattern: /(?:^|\.)(?:reddit\.com|redd\.it)$/i, extractor: redditExtractor },
  { pattern: /(?:^|\.)(?:x\.com|twitter\.com|t\.co)$/i, extractor: twitterExtractor },
  { pattern: /(?:^|\.)(?:instagram\.com|instagr\.am)$/i, extractor: instagramExtractor },
  { pattern: /(?:^|\.)(?:facebook\.com|fb\.com|fb\.watch|fb\.me)$/i, extractor: facebookExtractor },
  { pattern: /(?:^|\.)(?:linkedin\.com|lnkd\.in)$/i, extractor: linkedInExtractor },
  { pattern: /(?:^|\.)(?:youtube\.com|youtu\.be)$/i, extractor: youtubeExtractor },
];

/**
 * Returns the appropriate platform extractor based on URL hostname.
 */
export function getExtractorForUrl(targetUrl: string): PlatformExtractor {
  try {
    const host = new URL(targetUrl).hostname;
    for (const item of PLATFORM_EXTRACTORS) {
      if (item.pattern.test(host)) {
        return item.extractor;
      }
    }
  } catch {
    // Default fallback
  }

  return globalWebExtractor;
}

/**
 * Dispatches extraction to the appropriate platform strategy and returns the result with platform identifier.
 * Incorporates high-performance in-memory LRU caching for instant responses (<1ms) on repeated URLs.
 */
export async function dispatchExtraction(
  targetUrl: string,
  html?: string,
  options?: DispatchOptions
): Promise<{ result: ExtractionResult; platform: string; cached?: boolean }> {
  const cacheKey = targetUrl.trim();
  const bypassCache = Boolean(options?.forceRefresh || html);

  if (!bypassCache) {
    const cached = extractionCache.get(cacheKey);
    if (cached) {
      logger.debug('Extractor', `Cache hit for ${cacheKey}`);
      return {
        ...cached,
        cached: true,
      };
    }
  }

  const extractor = getExtractorForUrl(targetUrl);
  const result = await extractor.extract(targetUrl, html);
  const response = {
    result,
    platform: extractor.platformKey,
  };

  // Cache successful extractions (30-minute default TTL)
  if (!bypassCache && (result.title || result.description || result.card_data)) {
    extractionCache.set(cacheKey, response);
  }

  return response;
}
