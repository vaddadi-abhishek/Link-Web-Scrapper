import { ExtractionResult, PlatformExtractor, sanitizeMetrics } from './types';
import { redditExtractor } from './reddit';
import { twitterExtractor } from './twitter';
import { instagramExtractor } from './instagram';
import { facebookExtractor } from './facebook';
import { linkedInExtractor } from './linkedin';
import { youtubeExtractor } from './youtube';
import { pinterestExtractor } from './pinterest';
import { globalWebExtractor } from './globalWeb';
import { extractionCache } from '../../utils/cache';
import { canonicalizeUrl, isResolvableShortlink, resolveShortlink } from '../../utils/urlFormatter';
import { validateUrlAgainstSSRF } from '../../utils/ssrfValidator';
import { isAccessDeniedOrChallenge, isDegradedExtractionResult } from '../../utils/textCleaner';
import { logger } from '../../utils/logger';

export * from './types';

export interface DispatchOptions {
  forceRefresh?: boolean;
}

const PLATFORM_EXTRACTORS: Array<{ pattern: RegExp; extractor: PlatformExtractor }> = [
  { pattern: /(?:^|\.)(?:reddit\.com|redd\.it)$/i, extractor: redditExtractor },
  { pattern: /(?:^|\.)(?:x\.com|twitter\.com|t\.co)$/i, extractor: twitterExtractor },
  { pattern: /(?:^|\.)(?:instagram\.com|instagr\.am)$/i, extractor: instagramExtractor },
  { pattern: /(?:^|\.)(?:pinterest\.[a-z.]+|pin\.it)$/i, extractor: pinterestExtractor },
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
  let effectiveUrl = targetUrl.trim();
  if (isResolvableShortlink(effectiveUrl)) {
    effectiveUrl = await resolveShortlink(effectiveUrl);
  }

  const isSafe = await validateUrlAgainstSSRF(effectiveUrl);
  if (!isSafe) {
    throw new Error('Security Error: Invalid or internal URL provided (Possible SSRF attack blocked).');
  }

  const canonicalUrl = canonicalizeUrl(effectiveUrl) || effectiveUrl;
  const cacheKey = canonicalUrl;
  const bypassCache = Boolean(options?.forceRefresh || html);

  if (!bypassCache) {
    const cached = extractionCache.get(cacheKey);
    if (cached) {
      if (isDegradedExtractionResult(cached.platform, cached.result)) {
        logger.debug('Extractor', `Purging degraded cached entry for ${cacheKey}`);
        extractionCache.delete(cacheKey);
      } else {
        logger.debug('Extractor', `Cache hit for ${cacheKey}`);
        return {
          ...cached,
          cached: true,
        };
      }
    }
  }

  const extractor = getExtractorForUrl(effectiveUrl);
  const result = await extractor.extract(effectiveUrl, html);

  if (result.card_data && typeof result.card_data === 'object') {
    (result.card_data as any).metrics = sanitizeMetrics((result.card_data as any).metrics);
  }

  const response = {
    result,
    platform: result.type || (result.card_data as any)?.type || extractor.platformKey,
  };

  // Cache successful extractions (30-minute default TTL) strictly if NOT blocked and NOT degraded
  const isBlocked = isAccessDeniedOrChallenge(result.title, result.description);
  const isDegraded = isDegradedExtractionResult(response.platform, result);
  if (!bypassCache && !isBlocked && !isDegraded && (result.title || result.description || result.card_data)) {
    extractionCache.set(cacheKey, response);
  }

  return response;
}
