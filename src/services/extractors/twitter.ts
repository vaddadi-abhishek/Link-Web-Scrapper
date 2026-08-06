import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const twitterExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path with Twitterbot User-Agent
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const title = cheerioData?.title || null;
    const description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'X';

    // If fast path captured title & direct tweet image/media, return early
    if (title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    // 2. Playwright Strategy for Tweet Container Screenshotting
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        waitSelector: 'article[data-testid="tweet"], article',
        waitTimeout: 6000,
        containerSelectors: [
          'article[data-testid="tweet"]',
          'article[role="article"]',
          'article',
          '[role="main"]',
          'main',
        ],
      });

      return {
        title: title || pwData.title || 'X Post',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'X Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
