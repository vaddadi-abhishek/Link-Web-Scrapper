import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const globalWebExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path: ALWAYS target og:image or twitter:image first
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const hasDirectImage = !!(cheerioData && cheerioData.image);

    // If og:image or twitter:image is found in HTML metadata, return immediately
    if (cheerioData && hasDirectImage) {
      return {
        title: cheerioData.title || fallbackTitle(targetUrl),
        description: cheerioData.description || '',
        snapshot: cheerioData.image,
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData.ogSiteName,
      };
    }

    // 2. Playwright Fallback: Only take a screenshot if NO og:image or twitter:image was found in HTML
    // Screenshot is fixed at 1920x1080 viewport size (no fullPage scrolling)
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        viewport: { width: 1920, height: 1080 },
        viewportOnly: true,
      });

      return {
        title: cheerioData?.title || pwData.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || pwData.description || '',
        snapshot: pwData.snapshot || null,
        logo: cheerioData?.logo || pwData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData?.ogSiteName || pwData.ogSiteName || null,
      };
    } catch {
      return {
        title: cheerioData?.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || '',
        snapshot: null,
        logo: cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData?.ogSiteName || null,
      };
    }
  },
};

function fallbackTitle(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return 'Untitled Bookmark';
  }
}
