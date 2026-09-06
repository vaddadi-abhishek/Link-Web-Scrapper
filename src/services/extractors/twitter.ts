import axios from 'axios';
import { PlatformExtractor, ExtractionResult, XCardData, MediaItem } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { cleanTitle, cleanDescription } from '../../utils/textCleaner';

function extractTweetId(url: string): string | null {
  const match = url.match(/(?:status|statuses)\/(\d+)/i);
  return match && match[1] ? match[1] : null;
}

const X_LOGO_URL = 'https://abs.twimg.com/favicons/twitter.3.ico';

// -------------------------------------------------------------
// Tier 1: Open APIs for X (Twitter)
// -------------------------------------------------------------
async function tryFxTwitterApi(tweetId: string, targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(`https://api.fxtwitter.com/status/${tweetId}`, {
      timeout: 2000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TaggerApp/1.0',
      },
      validateStatus: (status) => status === 200,
    });

    const tweet = res.data?.tweet;
    if (!tweet || !tweet.author) {
      return null;
    }

    const authorName = tweet.author.name || 'User';
    const handle = tweet.author.screen_name ? `@${tweet.author.screen_name}` : '@user';
    const title = `${authorName} (${handle}) on X`;
    const description = tweet.text || '';

    const mediaList: MediaItem[] = [];
    if (Array.isArray(tweet.media?.photos)) {
      tweet.media.photos.forEach((photo: any) => {
        if (photo?.url) {
          mediaList.push({ type: 'image', url: photo.url });
        }
      });
    }
    if (Array.isArray(tweet.media?.videos)) {
      tweet.media.videos.forEach((video: any) => {
        if (video?.url || video?.thumbnail_url) {
          mediaList.push({
            type: 'video',
            url: video.url || video.thumbnail_url,
          });
        }
      });
    }

    const snapshot =
      mediaList[0]?.url ||
      tweet.media?.photos?.[0]?.url ||
      tweet.media?.videos?.[0]?.thumbnail_url ||
      null;

    const metrics: XCardData['metrics'] = {};
    if (tweet.replies !== undefined && tweet.replies !== null) metrics.replies = tweet.replies;
    if (tweet.retweets !== undefined && tweet.retweets !== null) metrics.reposts = tweet.retweets;
    if (tweet.likes !== undefined && tweet.likes !== null) metrics.likes = tweet.likes;
    if (tweet.views !== undefined && tweet.views !== null) metrics.views = tweet.views;
    if (tweet.bookmarks !== undefined && tweet.bookmarks !== null) metrics.bookmarks = tweet.bookmarks;

    const postedAt = tweet.created_at
      ? new Date(tweet.created_at).toISOString()
      : new Date().toISOString();

    return {
      title,
      description,
      snapshot,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: tweet.author.avatar_url || null,
          verified: Boolean(tweet.author.verification?.verified),
        },
        metrics,
        media: mediaList,
        posted_at: postedAt,
      },
    };
  } catch {
    return null;
  }
}

async function tryVxTwitterApi(tweetId: string, targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, {
      timeout: 2000,
      headers: {
        'Accept': 'application/json',
      },
      validateStatus: (status) => status === 200,
    });

    const data = res.data;
    if (!data || !data.user_name) {
      return null;
    }

    const authorName = data.user_name;
    const handle = data.user_screen_name ? `@${data.user_screen_name}` : '@user';
    const title = `${authorName} (${handle}) on X`;
    const description = data.text || '';

    const mediaList: MediaItem[] = [];
    if (Array.isArray(data.media_extended)) {
      data.media_extended.forEach((item: any) => {
        if (item?.url) {
          mediaList.push({
            type: item.type === 'video' || item.type === 'gif' ? 'video' : 'image',
            url: item.url,
          });
        }
      });
    } else if (Array.isArray(data.mediaURLs)) {
      data.mediaURLs.forEach((u: string) => {
        mediaList.push({ type: 'image', url: u });
      });
    }

    const snapshot = mediaList[0]?.url || null;

    const metrics: XCardData['metrics'] = {};
    if (data.replies !== undefined && data.replies !== null) metrics.replies = data.replies;
    if (data.retweets !== undefined && data.retweets !== null) metrics.reposts = data.retweets;
    if (data.likes !== undefined && data.likes !== null) metrics.likes = data.likes;

    return {
      title,
      description,
      snapshot,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: data.user_profile_image_url || null,
          verified: false,
        },
        metrics,
        media: mediaList,
        posted_at: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}

async function tryTwitterOEmbed(targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(`https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}`, {
      timeout: 2000,
    });
    const data = res.data;
    if (!data || !data.author_name) return null;

    const rawText = (data.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    return {
      title: `${data.author_name} on X`,
      description: rawText,
      snapshot: null,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: data.author_name,
          handle: data.author_url ? `@${data.author_url.split('/').pop()}` : '@user',
          avatar_url: null,
          verified: false,
        },
        metrics: {},
        media: [],
        posted_at: new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// Twitter / X Extractor with 3-Tier Fallback
// -------------------------------------------------------------
export const twitterExtractor: PlatformExtractor<XCardData> = {
  platformKey: 'x',
  async extract(targetUrl: string): Promise<ExtractionResult<XCardData>> {
    const tweetId = extractTweetId(targetUrl);

    // -----------------------------------------------------------
    // Tier 1: Open APIs (FxTwitter -> VxTwitter -> Twitter oEmbed)
    // -----------------------------------------------------------
    if (tweetId) {
      const fxResult = await tryFxTwitterApi(tweetId, targetUrl);
      if (fxResult) return fxResult;

      const vxResult = await tryVxTwitterApi(tweetId, targetUrl);
      if (vxResult) return vxResult;
    }

    const oembedResult = await tryTwitterOEmbed(targetUrl);
    if (oembedResult) return oembedResult;

    // -----------------------------------------------------------
    // Tier 2: Cheerio + Axios Fallback
    // -----------------------------------------------------------
    const cheerioData = await scrapeWithCheerio(targetUrl);
    if (cheerioData && (cheerioData.title || cheerioData.description)) {
      const title = cleanTitle(cheerioData.title) || 'Post on X';
      const description = cleanDescription(cheerioData.description) || '';
      const snapshot = cheerioData.image; // og:image or twitter:image
      const logo = cheerioData.logo || resolveUrl('/favicon.ico', targetUrl);

      return {
        title,
        description,
        snapshot,
        logo: X_LOGO_URL,
        ogSiteName: cheerioData.ogSiteName || 'X (formerly Twitter)',
        card_data: {
          author: {
            name: cheerioData.author || 'User',
            handle: '@user',
            avatar_url: cheerioData.authorAvatar || null,
            verified: false,
          },
          metrics: {},
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
          posted_at: cheerioData.publishedAt || new Date().toISOString(),
        },
      };
    }

    // -----------------------------------------------------------
    // Tier 3: Playwright Fallback (<2s, styles/images blocked)
    // -----------------------------------------------------------
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'article[data-testid="tweet"], article',
        waitTimeout: 2500,
      });

      const title = pwData.title || 'Post on X';
      const description = pwData.description || '';
      const snapshot = pwData.snapshot; // og:image or twitter:image

      return {
        title,
        description,
        snapshot,
        logo: X_LOGO_URL,
        ogSiteName: pwData.ogSiteName || 'X (formerly Twitter)',
        card_data: {
          author: {
            name: pwData.author || 'User',
            handle: '@user',
            avatar_url: null,
            verified: false,
          },
          metrics: {},
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
          posted_at: pwData.publishedAt || new Date().toISOString(),
        },
      };
    } catch {
      return {
        title: 'Post on X',
        description: '',
        snapshot: null,
        logo: X_LOGO_URL,
        ogSiteName: 'X (formerly Twitter)',
        card_data: {
          author: {
            name: 'User',
            handle: '@user',
            avatar_url: null,
            verified: false,
          },
          metrics: {},
          media: [],
          posted_at: new Date().toISOString(),
        },
      };
    }
  },
};
