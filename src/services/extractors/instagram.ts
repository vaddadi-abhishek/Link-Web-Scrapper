import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const instagramExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const title = cheerioData?.title || null;
    const description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Instagram';

    // Return early if direct OpenGraph image is extracted
    if (title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    // 2. Playwright Container Strategy for Full Post Media Card
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'article, main',
        waitTimeout: 6000,
        containerSelectors: [
          'article',
          'main[role="main"] article',
          'main[role="main"]',
          '[role="main"]',
          '#content',
        ],
      });

      return {
        title: title || pwData.title || 'Instagram Post',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'Instagram Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
