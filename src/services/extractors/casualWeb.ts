import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl, isHomepage } from '../../utils/urlFormatter';

export const casualWebExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const hasTitle = !!(cheerioData && cheerioData.title);
    const hasDirectImage = !!(cheerioData && cheerioData.image);
    const homepage = isHomepage(targetUrl);

    if (cheerioData && hasTitle && hasDirectImage && !homepage) {
      return {
        title: cheerioData.title!,
        description: cheerioData.description || '',
        snapshot: cheerioData.image,
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData.ogSiteName,
      };
    }

    // 2. Playwright Fallback
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        containerSelectors: [
          'article[role="article"]',
          'article',
          '[role="main"]',
          'main',
          '#content',
        ],
      });

      return {
        title: pwData.title || cheerioData?.title || fallbackTitle(targetUrl),
        description: pwData.description || cheerioData?.description || '',
        snapshot: pwData.snapshot || cheerioData?.image || null,
        logo: pwData.logo || cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: pwData.ogSiteName || cheerioData?.ogSiteName || null,
      };
    } catch {
      return {
        title: cheerioData?.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || '',
        snapshot: cheerioData?.image || null,
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
