import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

const GENERIC_REDDIT_DESC_PATTERNS = [
  'explore this post and more from',
  'reddit gives you the best',
  'dive into anything',
  'the front page of the internet',
];

export const redditExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    // 1. Cheerio Fast-Path Strategy
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Reddit';

    // Clean up generic Reddit description
    if (description) {
      const lowerDesc = description.toLowerCase();
      if (GENERIC_REDDIT_DESC_PATTERNS.some((pattern) => lowerDesc.includes(pattern))) {
        description = null;
      }
    }

    // Filter out generic Reddit logo/banner images
    if (image) {
      const lowerImage = image.toLowerCase();
      const logoSignatures = ['redditstatic.com', 'snoo', 'icon', 'avatar', 'reddit_logo'];
      if (logoSignatures.some((sig) => lowerImage.includes(sig))) {
        image = null;
      }
    }

    // Fast return if we have clean metadata AND a direct post media image
    if (title && description && image) {
      return {
        title,
        description,
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    // 2. Playwright Strategy for Reddit Post Cards & Dynamic Hydration
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'shreddit-post, article',
        waitTimeout: 6000,
        containerSelectors: [
          'shreddit-post',
          'article[role="article"]',
          'article',
          '[data-testid="post-container"]',
          '[role="main"]',
          'main',
        ],
      });

      let pwDesc = pwData.description;
      if (pwDesc) {
        const lowerPwDesc = pwDesc.toLowerCase();
        if (GENERIC_REDDIT_DESC_PATTERNS.some((pattern) => lowerPwDesc.includes(pattern))) {
          pwDesc = null;
        }
      }

      return {
        title: title || pwData.title || 'Reddit Post',
        description: description || pwDesc || '',
        snapshot: pwData.snapshot || image,
        logo: pwData.logo || logo,
        ogSiteName,
      };
    } catch {
      return {
        title: title || 'Reddit Post',
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }
  },
};
