import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const linkedInExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const title = cheerioData?.title || null;
    const description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'LinkedIn';

    if (title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'div.feed-shared-update-v2, article, main',
        waitTimeout: 6000,
        containerSelectors: [
          'div.feed-shared-update-v2',
          'article',
          '[data-urn]',
          '[role="main"]',
          'main',
        ],
      });

      return {
        title: title || pwData.title || 'LinkedIn Post',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'LinkedIn Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
