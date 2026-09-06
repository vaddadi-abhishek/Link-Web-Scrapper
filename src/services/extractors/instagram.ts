import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, InstagramCardData, MediaItem } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

const INSTAGRAM_LOGO_URL = 'https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png';

function cleanInstagramText(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\u0027/g, "'")
    .replace(/\\u0022/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\/g, '')
    .replace(/&#064;/g, '@')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function isAvatarUrl(url: string): boolean {
  const l = url.toLowerCase();
  return (
    l.includes('150x150') ||
    l.includes('s150x150') ||
    l.includes('profile_pic') ||
    l.includes('avatar') ||
    l.includes('rsrc.php')
  );
}

export const instagramExtractor: PlatformExtractor<InstagramCardData> = {
  platformKey: 'instagram',
  async extract(targetUrl: string): Promise<ExtractionResult<InstagramCardData>> {
    // Fast-Path using Axios & Cheerio with Meta Crawler User-Agent (~200ms)
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const ogSiteName = cheerioData?.ogSiteName || 'Instagram';
    let publishedAt: string | null = cheerioData?.publishedAt || null;

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

    const rawDesc = cheerioData?.rawDescription || cheerioData?.description || '';
    const combinedText = `${cheerioData?.rawTitle || ''} ${rawDesc} ${title || ''}`;

    // Parse Username & Display Name
    let username = 'unknown';
    let displayName = title || 'Instagram User';

    const handleMatch = title?.match(/@([a-zA-Z0-9._]+)/) || combinedText.match(/@([a-zA-Z0-9._]+)/);
    if (handleMatch && handleMatch[1]) {
      username = handleMatch[1].trim();
    } else {
      const userMatch = combinedText.match(/(?:-\s*|^\s*)([a-zA-Z0-9._]+)\s+on\s+/i);
      if (userMatch && userMatch[1]) {
        username = userMatch[1].trim();
      }
    }

    const nameMatch = title?.match(/^(.*?)\s*\(@/);
    if (nameMatch && nameMatch[1]) {
      displayName = nameMatch[1].trim();
    }

    // Parse Likes & Comments from metadata text strings
    const likesMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s+likes?/i);
    const commentsMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s+comments?/i);

    const metrics: InstagramCardData['metrics'] = {};
    if (likesMatch && likesMatch[1]) {
      metrics.likes = parseFormattedNumber(likesMatch[1]);
    }
    if (commentsMatch && commentsMatch[1]) {
      metrics.comments = parseFormattedNumber(commentsMatch[1]);
    }

    // Parse Date Posted from text string (e.g. "on August 1, 2026")
    const dateMatch =
      rawDesc.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i) ||
      combinedText.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i);
    if (dateMatch && dateMatch[1]) {
      const parsedDate = new Date(dateMatch[1].trim());
      if (!isNaN(parsedDate.getTime())) {
        publishedAt = parsedDate.toISOString();
      }
    }

    // Extract Reel/Post video & carousel image URLs via Instagram embed fast-path
    const shortcodeMatch = targetUrl.match(/\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;
    const mediaList: MediaItem[] = [];
    const discoveredImageUrls: string[] = [];
    let embedAvatar: string | null = null;

    if (shortcode) {
      try {
        const embedRes = await axios.get(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          },
          timeout: 4500,
        });
        const embedHtml = String(embedRes.data || '');

        // 1. Direct Video URLs (collect all videos)
        const videoRegex = /"video_url"\s*:\s*"([^"]+)"/g;
        let vMatch: RegExpExecArray | null;
        while ((vMatch = videoRegex.exec(embedHtml)) !== null) {
          const vUrl = cleanInstagramText(vMatch[1]);
          if (vUrl && !mediaList.some((m) => m.url === vUrl)) {
            mediaList.push({ type: 'video', url: vUrl });
          }
        }

        // 2. Carousel / Display Images: extract ALL display_url occurrences
        const displayRegex = /"display_url"\s*:\s*"([^"]+)"/g;
        let dMatch: RegExpExecArray | null;
        while ((dMatch = displayRegex.exec(embedHtml)) !== null) {
          const dUrl = cleanInstagramText(dMatch[1]);
          if (dUrl && !isAvatarUrl(dUrl)) {
            discoveredImageUrls.push(dUrl);
          }
        }

        // 3. Fallback to EmbeddedMediaImage class or thumbnail_src
        const $embed = cheerio.load(embedHtml);
        $embed('img.EmbeddedMediaImage, img[src*="cdninstagram"], img[src*="fbcdn"]').each((_, el) => {
          const src = $embed(el).attr('src');
          if (src && !isAvatarUrl(src)) {
            discoveredImageUrls.push(cleanInstagramText(src));
          }
        });

        // 4. Extract display_resources candidates if present
        const resRegex = /"src"\s*:\s*"([^"]+(?:cdninstagram\.com|fbcdn\.net)[^"]+)"/g;
        let rMatch: RegExpExecArray | null;
        while ((rMatch = resRegex.exec(embedHtml)) !== null) {
          const rUrl = cleanInstagramText(rMatch[1]);
          if (rUrl && !isAvatarUrl(rUrl)) {
            discoveredImageUrls.push(rUrl);
          }
        }

        // 5. Username
        const usernameMatch =
          embedHtml.match(/"username"\s*:\s*"([^"]+)"/) ||
          embedHtml.match(/class="UsernameText"[^>]*>([^<]+)/);
        if (usernameMatch && usernameMatch[1] && username === 'unknown') {
          username = cleanInstagramText(usernameMatch[1]);
          if (displayName === 'Instagram User' || displayName === 'Instagram Post') {
            displayName = username;
          }
        }

        // 6. Avatar
        const avatarMatch =
          embedHtml.match(/"profile_pic_url"\s*:\s*"([^"]+)"/) ||
          embedHtml.match(/class="Avatar[^"]*"[^>]+src="([^"]+)"/);
        if (avatarMatch && avatarMatch[1]) {
          embedAvatar = cleanInstagramText(avatarMatch[1]);
        }

        // 7. Caption Text
        const captionMatch =
          embedHtml.match(/class="CaptionText"[^>]*>([\s\S]*?)<\/div>/) ||
          embedHtml.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/) ||
          embedHtml.match(/"caption"\s*:\s*\{"text"\s*:\s*"([^"]+)"\}/);
        if (captionMatch && captionMatch[1] && (!description || description.trim() === '')) {
          description = cleanInstagramText(captionMatch[1]);
        }
      } catch {
        // Fallback if embed fetch times out
      }
    }

    // Also include image from Cheerio if not already included
    if (image && !isAvatarUrl(image)) {
      discoveredImageUrls.unshift(image);
    }

    // Deduplicate all discovered carousel images
    const uniqueImages = Array.from(new Set(discoveredImageUrls));
    uniqueImages.forEach((url) => {
      if (!mediaList.some((m) => m.url === url)) {
        mediaList.push({ type: 'image', url });
      }
    });

    const finalSnapshot =
      mediaList.find((m) => m.type === 'image')?.url || mediaList[0]?.url || image || null;

    const card_data: InstagramCardData = {
      author: {
        username,
        name: displayName,
        avatar_url: cheerioData?.authorAvatar || embedAvatar || null,
        verified: false,
      },
      metrics,
      media: mediaList,
      posted_at: publishedAt || new Date().toISOString(),
    };

    // If Cheerio and embed returned nothing useful (e.g. login wall / blocked), fallback to optimized Playwright
    if (!finalSnapshot && (!description || description.trim() === '') && (title === 'Instagram Post' || !title)) {
      try {
        const pwData = await playwrightEngine.scrape(targetUrl, {
          waitSelector: 'article, main',
          waitTimeout: 2500,
        });

        if (pwData.title || pwData.description || pwData.snapshot) {
          const pwMedia: MediaItem[] = pwData.snapshot ? [{ type: 'image', url: pwData.snapshot }] : mediaList;
          return {
            title: pwData.title || 'Instagram Post',
            description: pwData.description || '',
            snapshot: pwData.snapshot || finalSnapshot,
            logo: INSTAGRAM_LOGO_URL,
            ogSiteName,
            card_data: {
              author: {
                username,
                name: pwData.author || displayName,
                avatar_url: cheerioData?.authorAvatar || embedAvatar || null,
                verified: false,
              },
              metrics,
              media: pwMedia,
              posted_at: pwData.publishedAt || publishedAt || new Date().toISOString(),
            },
          };
        }
      } catch {
        // Fallback to default return
      }
    }

    return {
      title:
        title && title !== 'Instagram Post'
          ? title
          : username !== 'unknown'
          ? `Post by @${username} on Instagram`
          : 'Instagram Post',
      description: description || '',
      snapshot: finalSnapshot,
      logo: INSTAGRAM_LOGO_URL,
      ogSiteName,
      card_data,
    };
  },
};
