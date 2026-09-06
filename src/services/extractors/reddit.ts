import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, RedditCardData, MediaItem } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';
import { playwrightEngine } from '../playwrightEngine';

const REDDIT_LOGO_URL = 'https://www.redditstatic.com/shreddit/assets/favicon/192x192.png';

const GENERIC_REDDIT_DESC_PATTERNS = [
  'explore this post and more from',
  'reddit gives you the best',
  'dive into anything',
  'the front page of the internet',
];

function extractSubreddit(targetUrl: string, rawTitle?: string | null): string {
  const match = targetUrl.match(/\/r\/([a-zA-Z0-9_]+)/i);
  if (match && match[1]) {
    return `r/${match[1]}`;
  }

  if (rawTitle) {
    const titleMatch = rawTitle.match(/From the ([a-zA-Z0-9_]+) community on Reddit/i);
    if (titleMatch && titleMatch[1]) {
      return `r/${titleMatch[1]}`;
    }
  }

  return 'r/reddit';
}

function extractPostId(url: string): string | null {
  const match = url.match(/\/comments\/([a-zA-Z0-9]+)/i);
  return match && match[1] ? match[1] : null;
}

function getSubredditIcon(subredditName: string, customIcon?: string | null): string {
  if (customIcon && customIcon.startsWith('http') && !customIcon.includes('default')) {
    return customIcon;
  }
  const clean = subredditName.replace(/^r\//i, '').trim();
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(clean || 'Reddit')}&background=ff4500&color=fff&size=128&bold=true`;
}

// -------------------------------------------------------------
// Tier 1: PullPush Open API for Reddit (<500ms, Full Untruncated Data)
// -------------------------------------------------------------
async function tryPullPushReddit(postId: string): Promise<ExtractionResult<RedditCardData> | null> {
  try {
    const res = await axios.get(`https://api.pullpush.io/reddit/search/submission/?ids=${postId}`, {
      timeout: 2500,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TaggerApp/1.0',
      },
      validateStatus: (status) => status === 200,
    });

    const post = res.data?.data?.[0];
    if (!post || !post.title) {
      return null;
    }

    const title = cleanTitle(post.title) || 'Reddit Post';
    const description = post.selftext && post.selftext.trim() ? cleanDescription(post.selftext) || '' : '';

    let author = 'u/reddit_user';
    if (post.author && post.author !== '[deleted]' && post.author !== '[removed]') {
      author = post.author.startsWith('u/') ? post.author : `u/${post.author}`;
    }

    const subredditName = post.subreddit
      ? post.subreddit.startsWith('r/')
        ? post.subreddit
        : `r/${post.subreddit}`
      : 'r/reddit';

    const upvotes = post.score ?? post.ups ?? 0;
    const comments = post.num_comments ?? 0;

    const mediaList: MediaItem[] = [];
    const postUrl = post.url || post.url_overridden_by_dest || '';

    // Check direct image url
    if (postUrl && (/\.(jpg|jpeg|png|gif|webp)$/i.test(postUrl) || postUrl.includes('i.redd.it'))) {
      mediaList.push({ type: 'image', url: postUrl });
    } else if (post.is_video || postUrl.includes('v.redd.it')) {
      const vidUrl = post.media?.reddit_video?.fallback_url || postUrl;
      mediaList.push({ type: 'video', url: vidUrl });
    }

    // Check gallery data (e.g. multi-image posts)
    if (Array.isArray(post.gallery_data?.items)) {
      post.gallery_data.items.forEach((gItem: any) => {
        if (gItem?.media_id) {
          const galleryUrl = `https://i.redd.it/${gItem.media_id}.jpg`;
          if (!mediaList.some((m) => m.url === galleryUrl)) {
            mediaList.push({ type: 'image', url: galleryUrl });
          }
        }
      });
    }

    // Check preview image if no direct media link found
    if (mediaList.length === 0 && post.preview?.images?.[0]?.source?.url) {
      const previewUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
      mediaList.push({ type: 'image', url: previewUrl });
    }

    const snapshot =
      mediaList[0]?.url ||
      (post.thumbnail && post.thumbnail.startsWith('http') && !post.thumbnail.includes('default') && !post.thumbnail.includes('nsfw')
        ? post.thumbnail
        : null);

    const iconUrl = getSubredditIcon(subredditName, post.sr_detail?.community_icon || post.sr_detail?.icon_img);

    return {
      title,
      description,
      snapshot,
      logo: REDDIT_LOGO_URL,
      ogSiteName: 'Reddit',
      card_data: {
        subreddit: {
          name: subredditName,
          icon_url: iconUrl,
        },
        author,
        metrics: {
          upvotes,
          comments,
        },
        posted_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : new Date().toISOString(),
        media: mediaList,
      },
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// Reddit Extractor with Multi-Tier Architecture
// -------------------------------------------------------------
export const redditExtractor: PlatformExtractor<RedditCardData> = {
  platformKey: 'reddit',
  async extract(targetUrl: string): Promise<ExtractionResult<RedditCardData>> {
    const postId = extractPostId(targetUrl);

    // -----------------------------------------------------------
    // Tier 1: PullPush Open API (<500ms)
    // -----------------------------------------------------------
    if (postId) {
      const pullPushResult = await tryPullPushReddit(postId);
      if (pullPushResult) {
        return pullPushResult;
      }
    }

    // -----------------------------------------------------------
    // Tier 2: Fast Cheerio Metadata Fallback (timeout: 1500ms)
    // -----------------------------------------------------------
    let resolvedPermalink = targetUrl;
    let ogTitle: string | null = null;
    let metaTitle: string | null = null;
    let nameDesc: string | null = null;
    let ogDesc: string | null = null;
    let ogImage: string | null = null;
    let twitterImage: string | null = null;
    let authorName: string | null = null;
    let upvotes = 0;
    let comments = 0;

    try {
      const metaRes = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 1500,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      if (metaRes && metaRes.data) {
        const respUrl = metaRes.request?.res?.responseUrl || metaRes.config.url || targetUrl;
        const metaHtml = String(metaRes.data || '');
        const $meta = cheerio.load(metaHtml);

        const canonical =
          $meta('link[rel="canonical"]').attr('href') || $meta('meta[property="og:url"]').attr('content');
        if (canonical && canonical.includes('/comments/')) {
          resolvedPermalink = canonical;
        } else {
          resolvedPermalink = respUrl;
        }

        ogTitle = $meta('meta[property="og:title"]').attr('content') || null;
        metaTitle = $meta('meta[name="title"]').attr('content') || $meta('title').text() || null;
        nameDesc = $meta('meta[name="description"]').attr('content') || null;
        ogDesc = $meta('meta[property="og:description"]').attr('content') || null;
        ogImage = $meta('meta[property="og:image"]').attr('content') || null;
        twitterImage = $meta('meta[name="twitter:image"]').attr('content') || null;

        // Extract author from shreddit or meta
        authorName =
          $meta('shreddit-post').attr('author') ||
          $meta('meta[name="author"]').attr('content') ||
          $meta('meta[name="twitter:creator"]').attr('content') ||
          null;

        const shredditScore = $meta('shreddit-post').attr('score');
        const shredditComments = $meta('shreddit-post').attr('comment-count');
        if (shredditScore) upvotes = parseInt(shredditScore, 10) || 0;
        if (shredditComments) comments = parseInt(shredditComments, 10) || 0;

        const rawDescString = nameDesc || ogDesc || '';
        if (rawDescString && (!upvotes || !comments)) {
          const metricsMatch = rawDescString.match(
            /([\d,.]+[KMBkmb]?)\s*votes?,\s*([\d,.]+[KMBkmb]?)\s*comments?/i
          );
          if (metricsMatch) {
            if (!upvotes) upvotes = parseFormattedNumber(metricsMatch[1]);
            if (!comments) comments = parseFormattedNumber(metricsMatch[2]);
          }
        }
      }
    } catch {
      // Ignore network timeout
    }

    const cleanPermalink = resolvedPermalink.split('?')[0].replace(/\/$/, '');
    const subredditName = extractSubreddit(cleanPermalink, ogTitle || metaTitle);
    const subredditIcon = getSubredditIcon(subredditName);

    let finalTitle = ogTitle || metaTitle || null;
    if (finalTitle) {
      finalTitle = finalTitle.replace(/^From the [^:]+ community on Reddit:\s*/i, '').trim();
      finalTitle = cleanTitle(finalTitle);
    }

    // Filter out generic Reddit descriptions
    let cleanDescriptionText = '';
    const candidateDesc = nameDesc || ogDesc || '';
    if (candidateDesc) {
      const sanitized = candidateDesc
        .replace(/^[\d,.]+[KMBkmb]?\s*votes?,\s*[\d,.]+[KMBkmb]?\s*comments?\.\s*/i, '')
        .trim();
      const lower = sanitized.toLowerCase();
      if (!GENERIC_REDDIT_DESC_PATTERNS.some((pattern) => lower.includes(pattern))) {
        cleanDescriptionText = cleanDescription(sanitized) || '';
      }
    }

    let snapshotCandidate = ogImage || twitterImage || null;
    if (snapshotCandidate) {
      const lower = snapshotCandidate.toLowerCase();
      if (['redditstatic.com', 'snoo', 'icon', 'avatar', 'reddit_logo'].some((sig) => lower.includes(sig))) {
        snapshotCandidate = null;
      }
    }
    const snapshot = resolveUrl(snapshotCandidate, targetUrl);
    const finalAuthor = authorName ? (authorName.startsWith('u/') ? authorName : `u/${authorName}`) : `u/${subredditName.replace(/^r\//, '')}_user`;

    if (finalTitle && finalTitle !== 'Reddit Post' && finalTitle !== 'Reddit') {
      return {
        title: finalTitle,
        description: cleanDescriptionText,
        snapshot,
        logo: REDDIT_LOGO_URL,
        ogSiteName: 'Reddit',
        card_data: {
          subreddit: {
            name: subredditName,
            icon_url: subredditIcon,
          },
          author: finalAuthor,
          metrics: {
            upvotes,
            comments,
          },
          posted_at: new Date().toISOString(),
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
        },
      };
    }

    // -----------------------------------------------------------
    // Tier 3: Playwright Fallback (<2s)
    // -----------------------------------------------------------
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'shreddit-post, article, main',
        waitTimeout: 2000,
      });

      const pwAuthor = pwData.author ? (pwData.author.startsWith('u/') ? pwData.author : `u/${pwData.author}`) : finalAuthor;

      return {
        title: pwData.title || finalTitle || 'Reddit Post',
        description: pwData.description || cleanDescriptionText,
        snapshot: pwData.snapshot || snapshot,
        logo: REDDIT_LOGO_URL,
        ogSiteName: pwData.ogSiteName || 'Reddit',
        card_data: {
          subreddit: {
            name: subredditName,
            icon_url: subredditIcon,
          },
          author: pwAuthor,
          metrics: {
            upvotes,
            comments,
          },
          posted_at: pwData.publishedAt || new Date().toISOString(),
          media: pwData.snapshot ? [{ type: 'image', url: pwData.snapshot }] : snapshot ? [{ type: 'image', url: snapshot }] : [],
        },
      };
    } catch {
      return {
        title: finalTitle || 'Reddit Post',
        description: cleanDescriptionText,
        snapshot,
        logo: REDDIT_LOGO_URL,
        ogSiteName: 'Reddit',
        card_data: {
          subreddit: {
            name: subredditName,
            icon_url: subredditIcon,
          },
          author: finalAuthor,
          metrics: {
            upvotes,
            comments,
          },
          posted_at: new Date().toISOString(),
          media: snapshot ? [{ type: 'image', url: snapshot }] : [],
        },
      };
    }
  },
};
