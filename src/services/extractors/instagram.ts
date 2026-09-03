import axios from 'axios';
import { PlatformExtractor, ExtractionResult, InstagramCardData, MediaItem } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

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

export const instagramExtractor: PlatformExtractor<InstagramCardData> = {
  platformKey: 'instagram',
  async extract(targetUrl: string): Promise<ExtractionResult<InstagramCardData>> {
    // Fast-Path using Axios & Cheerio with Meta Crawler User-Agent (~200ms)
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
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
    const dateMatch = rawDesc.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i) || combinedText.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i);
    if (dateMatch && dateMatch[1]) {
      const parsedDate = new Date(dateMatch[1].trim());
      if (!isNaN(parsedDate.getTime())) {
        publishedAt = parsedDate.toISOString();
      }
    }

    // Extract Reel/Post video & image URLs via Instagram embed fast-path
    const shortcodeMatch = targetUrl.match(/\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;
    let videoUrl: string | null = null;
    let embedImage: string | null = null;
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
        
        // Direct Video URL
        const videoMatch = embedHtml.match(/"video_url"\s*:\s*"([^"]+)"/) || embedHtml.match(/video_url\\":\s*\\?"([^"]+)\\?"/);
        if (videoMatch && videoMatch[1]) {
          videoUrl = cleanInstagramText(videoMatch[1]);
        }

        // Thumbnail Cover Image URL
        const displayMatch = embedHtml.match(/"display_url"\s*:\s*"([^"]+)"/) || 
                             embedHtml.match(/display_url\\":\s*\\?"([^"]+)\\?"/) ||
                             embedHtml.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/) ||
                             embedHtml.match(/thumbnail_src\\":\s*\\?"([^"]+)\\?"/) ||
                             embedHtml.match(/<img[^>]+src="([^"]+)"/);
        if (displayMatch && displayMatch[1]) {
          embedImage = cleanInstagramText(displayMatch[1]);
        }

        // Username
        const usernameMatch = embedHtml.match(/"username"\s*:\s*"([^"]+)"/) || embedHtml.match(/class="UsernameText"[^>]*>([^<]+)/);
        if (usernameMatch && usernameMatch[1] && username === 'unknown') {
          username = cleanInstagramText(usernameMatch[1]);
          if (displayName === 'Instagram User' || displayName === 'Instagram Post') {
            displayName = username;
          }
        }

        // Avatar
        const avatarMatch = embedHtml.match(/"profile_pic_url"\s*:\s*"([^"]+)"/) || embedHtml.match(/class="Avatar[^"]*"[^>]+src="([^"]+)"/);
        if (avatarMatch && avatarMatch[1]) {
          embedAvatar = cleanInstagramText(avatarMatch[1]);
        }

        // Caption Text
        const captionMatch = embedHtml.match(/class="CaptionText"[^>]*>([\s\S]*?)<\/div>/) || 
                             embedHtml.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/) ||
                             embedHtml.match(/"caption"\s*:\s*\{"text"\s*:\s*"([^"]+)"\}/);
        if (captionMatch && captionMatch[1] && (!description || description.trim() === '')) {
          description = cleanInstagramText(captionMatch[1]);
        }
      } catch {
        // Fallback if embed fetch times out
      }
    }

    const finalSnapshot = image || embedImage || null;

    // Construct media list with direct video URL and/or image snapshot
    const mediaList: MediaItem[] = [];

    if (videoUrl) {
      mediaList.push({
        type: 'video',
        url: videoUrl,
      });
    }

    if (finalSnapshot) {
      mediaList.push({
        type: 'image',
        url: finalSnapshot,
      });
    }

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

    return {
      title: title && title !== 'Instagram Post' ? title : (username !== 'unknown' ? `Post by @${username} on Instagram` : 'Instagram Post'),
      description: description || '',
      snapshot: finalSnapshot,
      logo,
      ogSiteName,
      card_data,
    };
  },
};
