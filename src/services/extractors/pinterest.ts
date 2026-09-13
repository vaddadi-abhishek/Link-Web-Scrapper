import { PlatformExtractor, ExtractionResult, PinterestCardData } from './types';
import * as cheerio from 'cheerio';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

function cleanPinTitle(title: string | null | undefined): string {
  if (!title) return 'Pinterest Pin';
  return title.replace(/\s*\|\s*Pinterest$/i, '').trim();
}

export const pinterestExtractor: PlatformExtractor<PinterestCardData> = {
  platformKey: 'pinterest',
  async extract(targetUrl: string): Promise<ExtractionResult<PinterestCardData>> {
    // 1. Cheerio Fast-Path: Ultra-fast (~150-300ms) metadata extraction
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || '';
    let snapshot = cheerioData?.image || null;
    let authorName: string | null = cheerioData?.author || null;
    let authorUsername: string | null = null;
    let authorAvatar: string | null = null;
    let boardName: string | null = null;

    if (cheerioData && (title || description || snapshot)) {
      title = cleanPinTitle(title);
      return {
        title,
        description,
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: 'Pinterest',
        card_data: {
          author: {
            name: authorName || 'Pinterest Creator',
            username: authorUsername || undefined,
            avatar_url: authorAvatar,
          },
          board: boardName ? { name: boardName } : undefined,
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
          posted_at: cheerioData.publishedAt || null,
        },
      };
    }

    // 2. Playwright Fallback: Headless browser for JS-rendered pins
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitTimeout: 2500,
        includeHtml: true,
      });

      title = pwData.title || title;
      description = pwData.description || description;
      snapshot = pwData.snapshot || snapshot;
      authorName = pwData.author || authorName;

      if (pwData.html) {
        const $ = cheerio.load(pwData.html);
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage) snapshot = ogImage;

        const pinImg = $('img[srcset*="pinimg.com"], img[src*="pinimg.com"]').first().attr('src');
        if (pinImg) snapshot = pinImg;

        // Try extracting author username from user link
        const userLink = $('a[href^="/"][data-test-id*="creator"], a[href^="/"][data-test-id*="user"]').first();
        if (userLink.length > 0) {
          const href = userLink.attr('href') || '';
          const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
          if (match) authorUsername = match[1];
          const text = userLink.text().trim();
          if (text) authorName = text;
        }

        const avatarImg = $('img[src*="75x75"], img[src*="150x150"], img[alt*="profile"]').first().attr('src');
        if (avatarImg) authorAvatar = avatarImg;
      }

      title = cleanPinTitle(title);

      return {
        title: title || 'Pinterest Pin',
        description,
        logo: pwData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: 'Pinterest',
        card_data: {
          author: {
            name: authorName || 'Pinterest Creator',
            username: authorUsername || undefined,
            avatar_url: authorAvatar,
          },
          board: boardName ? { name: boardName } : undefined,
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
          posted_at: pwData.publishedAt || null,
        },
      };
    } catch {
      title = cleanPinTitle(title);
      return {
        title: title || 'Pinterest Pin',
        description,
        logo: resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: 'Pinterest',
        card_data: {
          author: {
            name: authorName || 'Pinterest Creator',
            username: authorUsername || undefined,
            avatar_url: authorAvatar,
          },
          board: boardName ? { name: boardName } : undefined,
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
          posted_at: null,
        },
      };
    }
  },
};
