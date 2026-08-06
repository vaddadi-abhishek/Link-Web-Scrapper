import { ExtractionResult, PlatformExtractor } from './types';
import { redditExtractor } from './reddit';
import { twitterExtractor } from './twitter';
import { instagramExtractor } from './instagram';
import { facebookExtractor } from './facebook';
import { linkedInExtractor } from './linkedin';
import { youtubeExtractor } from './youtube';
import { casualWebExtractor } from './casualWeb';

export * from './types';

/**
 * Returns the appropriate platform extractor based on URL hostname.
 */
export function getExtractorForUrl(targetUrl: string): PlatformExtractor {
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();

    if (host.includes('reddit.com')) {
      return redditExtractor;
    }
    if (host.includes('x.com') || host.includes('twitter.com')) {
      return twitterExtractor;
    }
    if (host.includes('instagram.com')) {
      return instagramExtractor;
    }
    if (host.includes('facebook.com')) {
      return facebookExtractor;
    }
    if (host.includes('linkedin.com')) {
      return linkedInExtractor;
    }
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return youtubeExtractor;
    }
  } catch {
    // Default fallback
  }

  return casualWebExtractor;
}

/**
 * Dispatches extraction to the appropriate platform strategy.
 */
export async function dispatchExtraction(targetUrl: string): Promise<ExtractionResult> {
  const extractor = getExtractorForUrl(targetUrl);
  return extractor.extract(targetUrl);
}
