import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, YouTubeCardData } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

function extractYouTubeVideoId(targetUrl: string): string | null {
  const match = targetUrl.match(
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i
  );
  return match && match[1] ? match[1] : null;
}

const buildYouTubeCardData = (
  videoId: string | null,
  channelName: string | null,
  channelAvatar: string | null,
  publishedAt: string | null,
  views: number = 0,
  likes: number = 0
): YouTubeCardData => {
  return {
    channel: {
      name: channelName || 'YouTube Channel',
      avatar_url: channelAvatar,
    },
    metrics: {
      views,
      likes,
    },
    video_id: videoId,
    posted_at: publishedAt || new Date().toISOString(),
  };
};

async function fetchChannelAvatar(channelUrl: string): Promise<string | null> {
  if (!channelUrl) return null;
  try {
    const res = await axios.get(channelUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 3000,
    });
    const $ = cheerio.load(res.data);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      null
    );
  } catch {
    return null;
  }
}

export const youtubeExtractor: PlatformExtractor<YouTubeCardData> = {
  platformKey: 'youtube',
  async extract(targetUrl: string): Promise<ExtractionResult<YouTubeCardData>> {
    const videoId = extractYouTubeVideoId(targetUrl);

    let title: string | null = null;
    let description: string | null = null;
    let channelName: string | null = null;
    let channelUrl: string | null = null;
    let channelAvatar: string | null = null;
    let views = 0;
    let likes = 0;
    let publishedAt: string | null = null;

    if (videoId) {
      try {
        const res = await axios.post(
          'https://www.youtube.com/youtubei/v1/player',
          {
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: '2.20240101.00.00',
              },
            },
            videoId,
          },
          { timeout: 4000 }
        );

        const details = res.data?.videoDetails;
        const micro = res.data?.microformat?.playerMicroformatRenderer;

        title = details?.title || micro?.title?.simpleText || null;
        description = micro?.description?.simpleText || details?.shortDescription || null;
        channelName = details?.author || micro?.ownerChannelName || null;
        channelUrl = micro?.ownerProfileUrl || (details?.author ? `https://www.youtube.com/@${details.author}` : null);
        if (details?.viewCount || micro?.viewCount) {
          views = parseInt(details?.viewCount || micro?.viewCount || '0', 10);
        }
        if (micro?.likeCount) {
          likes = parseInt(micro.likeCount, 10);
        }
        publishedAt = micro?.publishDate || micro?.uploadDate || null;
      } catch (error) {
        console.error(`[youtubeExtractor] youtubei error for ${videoId}:`, error);
      }
    }

    if (!title || !channelName) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`;
        const res = await axios.get(oembedUrl, { timeout: 3000 });
        if (!title) title = res.data?.title || null;
        if (!channelName) channelName = res.data?.author_name || null;
        if (!channelUrl) channelUrl = res.data?.author_url || null;
      } catch (error) {
        console.error(`[youtubeExtractor] oEmbed error for ${targetUrl}:`, error);
      }
    }

    if (channelUrl) {
      channelAvatar = await fetchChannelAvatar(channelUrl);
    }

    const cheerioData = (!title || !description) ? await scrapeWithCheerio(targetUrl) : null;
    if (!title) title = cheerioData?.title || null;
    if (!description) description = cheerioData?.description || null;
    if (!publishedAt) publishedAt = cheerioData?.publishedAt || null;

    const logo = cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl);
    const ogSiteName = cheerioData?.ogSiteName || 'YouTube';
    const snapshot = videoId
      ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      : cheerioData?.image || null;

    if (title) {
      return {
        title,
        description: description || '',
        snapshot,
        logo,
        ogSiteName,
        card_data: buildYouTubeCardData(videoId, channelName, channelAvatar, publishedAt, views, likes),
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
        title: pwData.title || 'YouTube Video',
        description: pwData.description || '',
        snapshot: pwData.snapshot || snapshot,
        logo: pwData.logo || logo,
        ogSiteName,
        card_data: buildYouTubeCardData(
          videoId,
          channelName || pwData.author,
          channelAvatar || pwData.authorAvatar,
          publishedAt || pwData.publishedAt,
          views,
          likes
        ),
      };
    } catch {
      return {
        title: 'YouTube Video',
        description: '',
        snapshot,
        logo,
        ogSiteName,
        card_data: buildYouTubeCardData(videoId, channelName, channelAvatar, publishedAt, views, likes),
      };
    }
  },
};
