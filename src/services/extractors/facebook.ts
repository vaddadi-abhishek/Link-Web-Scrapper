import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

/**
 * Determines whether a Facebook URL represents a specific Reel item (/reel/<id> or /reels/<id>).
 * e.g. https://www.facebook.com/reel/938790942598967 -> true
 * e.g. https://www.facebook.com/ProjectNightfall/reels/ -> false (profile reels tab)
 */
function isFacebookReelUrl(targetUrl: string): boolean {
  return /\/(?:reels?|share\/r)\/\d+/i.test(targetUrl);
}

export const facebookExtractor: PlatformExtractor = {
  async extract(targetUrl: string): Promise<ExtractionResult> {
    const isReel = isFacebookReelUrl(targetUrl);

    // 1. Standard Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Facebook';

    // 2. Mobile Facebook Fast-Path Attempt (mbasic.facebook.com)
    if (!image) {
      try {
        const mobileUrl = targetUrl
          .replace(/www\.facebook\.com/i, 'mbasic.facebook.com')
          .replace(/\/\/(?:web|m)\.facebook\.com/i, '//mbasic.facebook.com');

        const mRes = await axios.get(mobileUrl, {
          timeout: 4000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          validateStatus: (status) => status >= 200 && status < 400,
        });

        if (typeof mRes.data === 'string') {
          const $m = cheerio.load(mRes.data);
          const mOgImage =
            $m('meta[property="og:image"]').attr('content') ||
            $m('meta[property="og:image:secure_url"]').attr('content') ||
            $m('div#objects_container img').first().attr('src');

          if (mOgImage) {
            image = resolveUrl(mOgImage, targetUrl);
          }

          if (!title) {
            const mTitle = $m('meta[property="og:title"]').attr('content') || $m('title').text();
            if (mTitle) title = mTitle.trim();
          }
        }
      } catch {
        // Ignore mobile fallback errors
      }
    }

    // Only return early for Reel URLs if direct title & image metadata were found via fast-path
    if (isReel && title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
      };
    }

    // 3. Playwright Strategy for Facebook (Mandatory for non-Reel URLs, Fallback for Reel URLs)
    // PlaywrightEngine automatically dismisses Facebook login modal popups before screenshotting
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        waitSelector: '[role="article"], [data-pagelet="FeedUnit"], main, #objects_container',
        waitTimeout: 6000,
        containerSelectors: [
          '[role="article"]',
          '[data-pagelet="FeedUnit"]',
          '[data-pagelet="root"]',
          '#objects_container',
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
