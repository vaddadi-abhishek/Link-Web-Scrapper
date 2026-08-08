import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';

export const instagramExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Instagram';
    let publishedAt: string | null = null;

    // Target twitter:title for Instagram title (e.g. "Ceo of zoning out (@yashashree.rao) • Instagram photos and videos")
    // Desired output: "Ceo of zoning out (@yashashree.rao)"
    const twitterTitle = cheerioData?.twitterTitle;
    if (twitterTitle) {
      title = cleanTitle(twitterTitle);
    } else {
      const rawTitle = cheerioData?.rawTitle || '';
      const titleAuthorMatch = rawTitle.match(/^([^:]+)\s+on\s+Instagram:/i);
      if (titleAuthorMatch && titleAuthorMatch[1]) {
        title = titleAuthorMatch[1].trim();
      }
    }

    // Parse og:description (e.g. "141K likes, 515 comments - yashashree.rao on August 1, 2026: \"My music taste...\"")
    const rawDesc = cheerioData?.rawDescription || cheerioData?.description || '';
    const dateMatch = rawDesc.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i);
    if (dateMatch && dateMatch[1]) {
      publishedAt = dateMatch[1].trim();
    }

    // Return early if direct OpenGraph image is extracted
    if (title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
        publishedAt,
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

      if (!publishedAt && pwData.description) {
        const pwDateMatch = pwData.description.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i);
        if (pwDateMatch && pwDateMatch[1]) {
          publishedAt = pwDateMatch[1].trim();
        }
      }

      return {
        title: title || pwData.title || 'Instagram Post',
        description: description || pwData.description || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
        publishedAt,
      };
    } catch {
      return {
        title: title || 'Instagram Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
        publishedAt,
      };
    }
  },
};
