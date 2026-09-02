import { PlatformExtractor, ExtractionResult, XCardData } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import axios from 'axios';

const BEARER_TOKEN = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let cachedGuestToken: string | null = null;
let guestTokenExpiry: number = 0;

const getGuestToken = async (): Promise<string | null> => {
  if (cachedGuestToken && Date.now() < guestTokenExpiry) {
    return cachedGuestToken;
  }
  try {
    const res = await axios.post('https://api.twitter.com/1.1/guest/activate.json', {}, {
      headers: {
        'authorization': BEARER_TOKEN,
      },
      timeout: 3000,
    });
    if (res.data && res.data.guest_token) {
      cachedGuestToken = res.data.guest_token;
      guestTokenExpiry = Date.now() + 20 * 60 * 1000; // cache for 20 minutes
      return cachedGuestToken;
    }
  } catch {
    // Return null if guest token activation fails
  }
  return null;
};

const extractVideoUrl = (item: any): string | null => {
  if (!item) return null;
  const variants = item.video_info?.variants || item.variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const mp4Variants = variants
    .filter((v: any) => (v.content_type === 'video/mp4' || v.type === 'video/mp4') && (v.url || v.src))
    .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

  if (mp4Variants.length > 0) {
    return mp4Variants[0].url || mp4Variants[0].src || null;
  }

  const anyVariant = variants.find((v: any) => v.url || v.src);
  return anyVariant?.url || anyVariant?.src || null;
};

export const twitterExtractor: PlatformExtractor<XCardData> = {
  platformKey: 'x',
  async extract(targetUrl: string): Promise<ExtractionResult<XCardData>> {
    const tweetMatch = targetUrl.match(/\/status\/(\d+)/i);
    if (!tweetMatch || !tweetMatch[1]) {
      throw new Error('Invalid X/Twitter status URL');
    }

    const tweetId = tweetMatch[1];
    const guestToken = await getGuestToken();
    if (!guestToken) {
      throw new Error('Failed to retrieve Twitter guest token');
    }

    const synRes = await axios.get(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${guestToken}`, {
      timeout: 4000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    const data = synRes.data;
    if (!data || !data.user) {
      throw new Error('Tweet data not found or returned empty payload');
    }

    const authorName = data.user.name || 'User Display Name';
    const handle = data.user.screen_name ? `@${data.user.screen_name}` : '@username';
    const title = `${authorName} (${handle}) on X`;
    const description = data.text || '';

    // Map all attached images/videos from mediaDetails or photos
    const mediaList: Array<{ type: 'image' | 'video'; url: string }> = [];

    if (Array.isArray(data.mediaDetails) && data.mediaDetails.length > 0) {
      data.mediaDetails.forEach((item: any) => {
        if (!item) return;
        const isVideo = item.type === 'video' || item.type === 'animated_gif';
        if (isVideo) {
          const videoUrl = extractVideoUrl(item);
          if (videoUrl) {
            mediaList.push({ type: 'video', url: videoUrl });
          } else if (item.media_url_https) {
            mediaList.push({ type: 'video', url: item.media_url_https });
          }
        } else if (item.media_url_https) {
          mediaList.push({ type: 'image', url: item.media_url_https });
        }
      });
    } else if (Array.isArray(data.photos) && data.photos.length > 0) {
      data.photos.forEach((photo: any) => {
        if (photo && photo.url) {
          mediaList.push({ type: 'image', url: photo.url });
        }
      });
    }

    if (mediaList.length === 0 && data.video) {
      const videoUrl = extractVideoUrl(data.video);
      if (videoUrl) {
        mediaList.push({ type: 'video', url: videoUrl });
      }
    }

    const snapshot = data.photos?.[0]?.url || data.mediaDetails?.[0]?.media_url_https || data.video?.poster || mediaList[0]?.url || null;

    // Dynamically construct metrics object containing ONLY available non-null/non-undefined fields
    const metrics: XCardData['metrics'] = {};

    if (data.conversation_count !== undefined && data.conversation_count !== null) {
      metrics.replies = data.conversation_count;
    }
    if (data.retweet_count !== undefined && data.retweet_count !== null) {
      metrics.reposts = data.retweet_count;
    }
    if (data.favorite_count !== undefined && data.favorite_count !== null) {
      metrics.likes = data.favorite_count;
    }
    const viewCount = data.views_count ?? data.views?.count;
    if (viewCount !== undefined && viewCount !== null) {
      metrics.views = viewCount;
    }
    if (data.bookmark_count !== undefined && data.bookmark_count !== null) {
      metrics.bookmarks = data.bookmark_count;
    }

    return {
      title,
      description,
      snapshot,
      logo: data.user.profile_image_url_https || resolveUrl('/favicon.ico', targetUrl),
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: data.user.profile_image_url_https || null,
          verified: Boolean(data.user.verified || data.user.is_blue_verified)
        },
        metrics,
        media: mediaList,
        posted_at: data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString()
      }
    };
  },
};
