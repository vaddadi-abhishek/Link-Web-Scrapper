import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const facebookExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const title = cheerioData?.title || null;
    const description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Facebook';

    if (title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    // 2. Playwright Strategy for Facebook Post / Reel Container
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: '[role="article"], [data-pagelet="FeedUnit"], main',
        waitTimeout: 6000,
        containerSelectors: [
          '[role="article"]',
          '[data-pagelet="FeedUnit"]',
          '[data-pagelet="root"]',
          'article',
          '[role="main"]',
          'main',
        ],
      });

      return {
        title: title || pwData.title || 'Facebook Post',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'Facebook Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
