import { ExtractionResult, PlatformExtractor } from './types';
import { redditExtractor } from './reddit';
import { twitterExtractor } from './twitter';
import { instagramExtractor } from './instagram';
import { facebookExtractor } from './facebook';
import { linkedInExtractor } from './linkedin';
import { youtubeExtractor } from './youtube';
import { globalWebExtractor } from './globalWeb';
import { extractionCache } from '../../utils/cache';
import { canonicalizeUrl } from '../../utils/urlFormatter';
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
 * Determines the platform-specific extractor to execute based on the target URL domain.
 */
export function getExtractorForUrl(targetUrl: string): PlatformExtractor {
  const cleanUrl = targetUrl.trim().toLowerCase();

  try {
    const parsed = new URL(cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`);
    const hostname = parsed.hostname;

    const matched = PLATFORM_EXTRACTORS.find(({ pattern }) => pattern.test(hostname));
    if (matched) {
      return matched.extractor;
    }
  } catch {
    // If URL parsing fails, default to global web extractor
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
  const canonicalUrl = canonicalizeUrl(targetUrl) || targetUrl.trim();
  const cacheKey = canonicalUrl;
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
