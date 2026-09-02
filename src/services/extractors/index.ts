import { ExtractionResult, PlatformExtractor } from './types';
import { redditExtractor } from './reddit';
import { twitterExtractor } from './twitter';
import { instagramExtractor } from './instagram';
import { facebookExtractor } from './facebook';
import { linkedInExtractor } from './linkedin';
import { youtubeExtractor } from './youtube';
import { globalWebExtractor } from './globalWeb';

export * from './types';

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
 */
export async function dispatchExtraction(
  targetUrl: string,
  html?: string
): Promise<{ result: ExtractionResult; platform: string }> {
  const extractor = getExtractorForUrl(targetUrl);
  const result = await extractor.extract(targetUrl, html);
  return {
    result,
    platform: extractor.platformKey,
  };
}
