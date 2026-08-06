import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const youtubeExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const title = cheerioData?.title || null;
    const description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'YouTube';

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
        waitSelector: '#ytd-player, ytd-watch-flexy, #movie_player, main',
        waitTimeout: 6000,
        containerSelectors: [
          '#ytd-player',
          'ytd-watch-flexy',
          '#movie_player',
          'article',
          '[role="main"]',
          'main',
        ],
      });

      return {
        title: title || pwData.title || 'YouTube Video',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'YouTube Video',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
