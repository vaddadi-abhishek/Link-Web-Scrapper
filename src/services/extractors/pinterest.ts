import { PlatformExtractor, ExtractionResult, PinterestCardData } from './types';
import * as cheerio from 'cheerio';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

function cleanPinTitle(title: string | null | undefined): string {
  if (!title) return 'Pinterest Pin';
  return title.replace(/\s*\|\s*Pinterest$/i, '').trim();
}

interface ParsedPinData {
  title: string;
  description: string;
  authorName: string;
  authorUsername?: string;
  authorAvatar: string | null;
  media: Array<{ type: string; url: string }>;
  videoThumbnail: string | null;
  publishedAt: string | null;
  snapshot: string | null;
}

function parsePinterestHtml(html: string, targetUrl: string): ParsedPinData {
  const $ = cheerio.load(html);

  let title = $('meta[property="og:title"]').attr('content') || $('title').text() || null;
  let description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
  let snapshot = $('meta[property="og:image"]').attr('content') || null;
  let authorName: string | null = null;
  let authorUsername: string | null = null;
  let authorAvatar: string | null = null;
  let videoUrl: string | null = null;
  let videoThumbnail: string | null = null;
  let publishedAt: string | null = null;

  // 1. Embedded JSON-LD scripts (<script type="application/ld+json">)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).html();
      if (!text) return;
      const json = JSON.parse(text);
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const itemType = item['@type'];
        if (itemType === 'VideoObject') {
          if (item.contentUrl) videoUrl = item.contentUrl;
          else if (item.embedUrl) videoUrl = item.embedUrl;
          if (item.thumbnailUrl) videoThumbnail = item.thumbnailUrl;
          if (item.name && !title) title = item.name;
          if (item.description && !description) description = item.description;
          if (item.uploadDate && !publishedAt) publishedAt = item.uploadDate;
          if (item.creator && typeof item.creator === 'object') {
            authorName = item.creator.name || item.creator.alternateName || authorName;
            if (item.creator.url) {
              const uMatch = item.creator.url.match(/pinterest\.[a-z.]+\/([^\/\?]+)/i);
              if (uMatch) authorUsername = uMatch[1];
            }
          }
        } else if (itemType === 'SocialMediaPosting') {
          if (item.image && !snapshot) snapshot = item.image;
          if (item.headline && !title) title = item.headline;
          if (item.datePublished && !publishedAt) publishedAt = item.datePublished;
          if (item.author && typeof item.author === 'object') {
            authorName = item.author.name || item.author.alternateName || authorName;
            if (item.author.url) {
              const uMatch = item.author.url.match(/pinterest\.[a-z.]+\/([^\/\?]+)/i);
              if (uMatch) authorUsername = uMatch[1];
            }
          }
        }
      }
    } catch { }
  });

  // 2. Fallbacks for video & snapshot
  if (!videoUrl) {
    const ogVideo =
      $('meta[property="og:video"]').attr('content') ||
      $('meta[property="og:video:secure_url"]').attr('content') ||
      $('meta[name="og:video"]').attr('content');
    if (ogVideo) {
      videoUrl = ogVideo;
      videoThumbnail = snapshot;
    }
  }

  if (!snapshot) {
    const pinImg = $('img[srcset*="pinimg.com"], img[src*="pinimg.com"]').first().attr('src');
    if (pinImg) snapshot = pinImg;
  }

  // 3. Author resolution from page links if missing
  if (!authorUsername || !authorName) {
    const userLink = $('a[href^="/"][data-test-id*="creator"], a[href^="/"][data-test-id*="user"]').first();
    if (userLink.length > 0) {
      const href = userLink.attr('href') || '';
      const match = href.match(/^\/([a-zA-Z0-9_]+)\/?$/);
      if (match && !authorUsername) authorUsername = match[1];
      const text = userLink.text().trim();
      if (text && !authorName) authorName = text;
    }
  }

  // 4. Author avatar resolution (relay user payload, avatar CDN, or profile img)
  const userAvatarMatch =
    html.match(/"__typename"\s*:\s*"User"[^}]+?"image(?:Large|Medium|Small)Url"\s*:\s*"([^"]+)"/) ||
    html.match(/"image(?:Large|Medium|Small)Url"\s*:\s*"([^"]+)"[^}]+?"__typename"\s*:\s*"User"/) ||
    html.match(/https:\/\/[^"'\\]+pinimg\.com\/(?:75x75_RS|150x150|140x140_RS|280x280)[^"'\\]+\.jpg/i);
  if (userAvatarMatch) {
    authorAvatar = userAvatarMatch[1] || userAvatarMatch[0];
  } else {
    const avatarImg = $('img[src*="75x75"], img[src*="150x150"], img[src*="140x140"], img[alt*="profile"]').first().attr('src');
    if (avatarImg) authorAvatar = avatarImg;
  }

  if (authorAvatar && authorAvatar.includes('/30x30_RS/')) {
    authorAvatar = authorAvatar.replace('/30x30_RS/', '/75x75_RS/');
  }

  const hasVideo = Boolean(videoUrl);
  const media: Array<{ type: string; url: string }> = [];
  if (hasVideo && videoUrl) {
    media.push({ type: 'video', url: videoUrl });
  } else if (snapshot) {
    media.push({ type: 'image', url: snapshot });
  }

  title = cleanPinTitle(title);

  return {
    title,
    description,
    authorName: authorName || 'Pinterest Creator',
    authorUsername: authorUsername || undefined,
    authorAvatar,
    media,
    videoThumbnail: hasVideo ? (videoThumbnail || snapshot) : null,
    publishedAt,
    snapshot,
  };
}

export const pinterestExtractor: PlatformExtractor<PinterestCardData> = {
  platformKey: 'pinterest',
  async extract(targetUrl: string): Promise<ExtractionResult<PinterestCardData>> {
    // 1. Cheerio Fast-Path: Ultra-fast (~150-300ms) metadata extraction
    const cheerioData = await scrapeWithCheerio(targetUrl);

    if (cheerioData?.rawHtml) {
      const parsed = parsePinterestHtml(cheerioData.rawHtml, targetUrl);
      if (parsed.title || parsed.media.length > 0) {
        return {
          title: parsed.title,
          description: parsed.description || cheerioData.description || '',
          logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
          ogSiteName: 'Pinterest',
          card_data: {
            author: {
              name: parsed.authorName,
              username: parsed.authorUsername,
              avatar_url: parsed.authorAvatar,
            },
            media: parsed.media,
            posted_at: parsed.publishedAt || cheerioData.publishedAt || null,
            video_thumbnail: parsed.videoThumbnail,
          },
        };
      }
    }

    // 2. Playwright Fallback: Headless browser for JS-rendered pins
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitTimeout: 2500,
        includeHtml: true,
      });

      if (pwData.html) {
        const parsed = parsePinterestHtml(pwData.html, targetUrl);
        return {
          title: parsed.title || pwData.title || 'Pinterest Pin',
          description: parsed.description || pwData.description || '',
          logo: pwData.logo || resolveUrl('/favicon.ico', targetUrl),
          ogSiteName: 'Pinterest',
          card_data: {
            author: {
              name: parsed.authorName || pwData.author || 'Pinterest Creator',
              username: parsed.authorUsername,
              avatar_url: parsed.authorAvatar,
            },
            media: parsed.media.length > 0 ? parsed.media : (pwData.snapshot ? [{ type: 'image', url: pwData.snapshot }] : []),
            posted_at: parsed.publishedAt || pwData.publishedAt || null,
            video_thumbnail: parsed.videoThumbnail,
          },
        };
      }

      const fallbackTitle = cleanPinTitle(pwData.title);
      return {
        title: fallbackTitle || 'Pinterest Pin',
        description: pwData.description || '',
        logo: pwData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: 'Pinterest',
        card_data: {
          author: {
            name: pwData.author || 'Pinterest Creator',
            avatar_url: null,
          },
          media: pwData.snapshot ? [{ type: 'image', url: pwData.snapshot }] : [],
          posted_at: pwData.publishedAt || null,
          video_thumbnail: null,
        },
      };
    } catch {
      return {
        title: 'Pinterest Pin',
        description: '',
        logo: resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: 'Pinterest',
        card_data: {
          author: {
            name: 'Pinterest Creator',
            avatar_url: null,
          },
          media: [],
          posted_at: null,
          video_thumbnail: null,
        },
      };
    }
  },
};
