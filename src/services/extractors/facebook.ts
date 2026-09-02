import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, FacebookCardData, MediaItem } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { resolveUrl } from '../../utils/urlFormatter';

function isFacebookReelUrl(targetUrl: string): boolean {
  return /\/(?:reels?|share\/r)\/\d+/i.test(targetUrl);
}

const buildFacebookCardData = (
  authorName: string | null,
  avatarUrl: string | null,
  mediaUrl: string | null,
  isReel: boolean,
  postedAt: string | null
): FacebookCardData => {
  const media: MediaItem[] = mediaUrl
    ? [{ type: isReel ? 'video' : 'image', url: mediaUrl }]
    : [];

  return {
    author: {
      name: authorName || 'Facebook User',
      avatar_url: avatarUrl,
    },
    metrics: {
      likes: 0,
      comments: 0,
      shares: 0,
    },
    media,
    posted_at: postedAt || new Date().toISOString(),
  };
};

export const facebookExtractor: PlatformExtractor<FacebookCardData> = {
  platformKey: 'facebook',
  async extract(targetUrl: string): Promise<ExtractionResult<FacebookCardData>> {
    const isReel = isFacebookReelUrl(targetUrl);

    // 1. Standard Cheerio Fast-Path
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'Facebook';
    const authorName = cheerioData?.author || cheerioData?.title || null;
    const authorAvatar = cheerioData?.authorAvatar || null;
    const publishedAt = cheerioData?.publishedAt || null;

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

    // Early return for Reel URLs if direct title & image metadata were found
    if (isReel && title && image) {
      return {
        title,
        description: description || '',
        snapshot: image,
        logo,
        ogSiteName,
        card_data: buildFacebookCardData(authorName, authorAvatar, image, true, publishedAt),
      };
    }

    return {
      title: title || 'Facebook Post',
      description: description || '',
      snapshot: image,
      logo,
      ogSiteName,
      card_data: buildFacebookCardData(authorName, authorAvatar, image, isReel, publishedAt),
    };
  },
};
