import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

export const youtubeExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'YouTube';

    // Prefer high-res official YouTube video thumbnail if video ID exists in URL
    try {
      const match = targetUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (match && match[1]) {
        const videoId = match[1];
        image = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      }
    } catch {
      // Ignore
    }

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
