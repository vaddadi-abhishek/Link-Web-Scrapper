import axios from 'axios';
import { PlatformExtractor, ExtractionResult, InstagramCardData, MediaItem } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

export const instagramExtractor: PlatformExtractor<InstagramCardData> = {
  platformKey: 'instagram',
  async extract(targetUrl: string): Promise<ExtractionResult<InstagramCardData>> {
    // Fast-Path using Axios & Cheerio with Meta Crawler User-Agent (~200ms)
    const cheerioData = await scrapeWithCheerio(targetUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    const image = cheerioData?.image || null;
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

    // Extract reel video URL via embed fast-path if present
    const shortcodeMatch = targetUrl.match(/\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;
    let videoUrl: string | null = null;

    if (shortcode) {
      try {
        const embedRes = await axios.get(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          },
          timeout: 4000,
        });
        const embedHtml = String(embedRes.data || '');
        const videoMatch = embedHtml.match(/"video_url"\s*:\s*"([^"]+)"/) || embedHtml.match(/video_url\\":\s*\\?"([^"]+)\\?"/);
        if (videoMatch && videoMatch[1]) {
          videoUrl = videoMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
        }
      } catch {
        // Fallback to non-video metadata if embed fetch fails
      }
    }

    // Construct media list with direct video URL and/or image snapshot
    const mediaList: MediaItem[] = [];

    if (videoUrl) {
      mediaList.push({
        type: 'video',
        url: videoUrl,
      });
    }

    if (image) {
      mediaList.push({
        type: 'image',
        url: image,
      });
    } else if (!videoUrl && image) {
      const isReelOrVideo = targetUrl.toLowerCase().includes('/reel/') || targetUrl.toLowerCase().includes('/reels/');
      mediaList.push({
        type: isReelOrVideo ? 'video' : 'image',
        url: image,
      });
    }

    const card_data: InstagramCardData = {
      author: {
        username,
        name: displayName,
        avatar_url: cheerioData?.authorAvatar || null,
        verified: false,
      },
      metrics,
      media: mediaList,
      posted_at: publishedAt || new Date().toISOString(),
    };

    return {
      title: title || 'Instagram Post',
      description: description || '',
      snapshot: image,
      logo,
      ogSiteName,
      card_data,
    };
  },
};
