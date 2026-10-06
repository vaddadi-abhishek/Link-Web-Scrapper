import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, XCardData, MediaItem } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { cleanTitle, cleanDescription, unescapeHtml } from '../../utils/textCleaner';
import { avatarCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

const X_LOGO_URL = 'https://abs.twimg.com/favicons/twitter.3.ico';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function extractTweetId(url: string): string | null {
  const match = url.match(/(?:status|statuses)\/(\d+)/i);
  return match && match[1] ? match[1] : null;
}

/**
 * Safely parses integer or metric shorthand (e.g. "34252", "1.7K", "15.8M", "1B").
 */
function parseMetricValue(val: string | number | undefined | null): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return Math.max(0, Math.floor(val));
  const clean = val.replace(/,/g, '').trim().toUpperCase();
  if (!clean) return 0;

  if (clean.endsWith('K')) {
    const n = parseFloat(clean.slice(0, -1));
    return isNaN(n) ? 0 : Math.round(n * 1000);
  }
  if (clean.endsWith('M')) {
    const n = parseFloat(clean.slice(0, -1));
    return isNaN(n) ? 0 : Math.round(n * 1000000);
  }
  if (clean.endsWith('B')) {
    const n = parseFloat(clean.slice(0, -1));
    return isNaN(n) ? 0 : Math.round(n * 1000000000);
  }
  const num = parseInt(clean, 10);
  return isNaN(num) ? 0 : Math.max(0, num);
}

/**
 * Upgrades profile avatars from small thumbnails (_x96, _normal) to high-resolution (_200x200).
 */
function upgradeAvatarUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.includes('pbs.twimg.com/profile_images/')) {
    return trimmed.replace(/_(?:x96|normal)\.([a-zA-Z0-9]+)$/, '_200x200.$1');
  }
  return trimmed;
}

/**
 * Cleans tweet text by stripping trailing t.co shortlinks, pic.twitter.com links, oEmbed footers, and HTML entities.
 */
export function cleanTweetText(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return '';
  let str = unescapeHtml(rawText);

  // Convert HTML line breaks to real newlines
  str = str.replace(/<br\s*\/?>/gi, '\n');

  // Strip trailing oEmbed author attribution footer like: &mdash; Vladimir Bayandin (@vovudebosh) September 10, 2026
  str = str.replace(/(?:&mdash;|—)\s*[^@]+?\(@[a-zA-Z0-9_]+\)\s*(?:<[^>]+>|[a-zA-Z0-9\s,.:]+)*$/i, '');

  // Strip pic.twitter.com and pic.x.com links and anchor tags
  str = str.replace(/<a[^>]*href="[^"]*pic\.(?:twitter|x)\.com[^"]*"[^>]*>.*?<\/a>/gi, '');
  str = str.replace(/https?:\/\/pic\.(?:twitter|x)\.com\/[^\s<>"]+/gi, '');
  str = str.replace(/pic\.(?:twitter|x)\.com\/[^\s<>"]+/gi, '');

  // Strip t.co attachment links and anchors (Twitter automatically appends these for media, quotes, and cards)
  str = str.replace(/<a[^>]*href="[^"]*t\.co[^"]*"[^>]*>.*?<\/a>/gi, '');
  str = str.replace(/https?:\/\/t\.co\/[^\s<>"]+/gi, '');
  str = str.replace(/(?:^|\s)t\.co\/[^\s<>"]+/gi, '');

  // Strip twitter status links (e.g. quote tweet / web status links appended by Twitter)
  str = str.replace(/https?:\/\/(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/\d+[^\s<>"]*/gi, '');

  // Strip remaining HTML tags
  str = str.replace(/<[^>]+>/g, ' ');

  const cleaned = cleanDescription(str);
  return cleaned || '';
}

/**
 * Resolves author profile avatar and verified status with LRU caching.
 */
async function resolveAuthorProfile(handle: string): Promise<{ avatar_url: string | null; verified: boolean }> {
  const cleanHandle = handle.replace(/^@/, '').trim();
  if (!cleanHandle || cleanHandle.toLowerCase() === 'user') {
    return { avatar_url: null, verified: false };
  }

  const cached = avatarCache.get(cleanHandle);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return parsed;
    } catch {
      return { avatar_url: cached, verified: false };
    }
  }

  try {
    const res = await axios.get(`https://x.com/${cleanHandle}`, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 3500,
      validateStatus: (s) => s === 200,
    });

    const html = res.data;
    if (typeof html === 'string') {
      const $ = cheerio.load(html);
      const ogImage = $('meta[property="og:image"]').attr('content') || null;
      const avatarUrl = upgradeAvatarUrl(ogImage && ogImage.includes('profile_images') ? ogImage : null);
      const verified =
        html.includes('legacy_verified":true') ||
        html.includes('is_blue_verified":true') ||
        html.includes('verified_organization') ||
        html.includes('blue_business') ||
        html.includes('"verification":');

      const result = { avatar_url: avatarUrl, verified };
      avatarCache.set(cleanHandle, JSON.stringify(result));
      return result;
    }
  } catch {
    // Graceful fallback
  }

  return { avatar_url: null, verified: false };
}

/**
 * Direct scraper targeting x.com with Twitterbot headers.
 * Extracts rich metadata directly from X's SSR payload and OpenGraph tags without Cloudflare challenges.
 */
async function tryDirectTwitterScrape(targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 5000,
      validateStatus: (status) => status === 200,
    });

    const html = res.data;
    if (!html || typeof html !== 'string') return null;

    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    const creator = $('meta[name="twitter:creator"]').attr('content') || '';

    let avatar: string | null = null;
    let verified = false;
    let replies: number | undefined;
    let postedAt: string | null = null;

    const avMatch = html.match(/authorAvatarUrl:\"([^\"]+)\"/);
    if (avMatch) avatar = avMatch[1];

    if (
      html.includes('legacy_verified":true') ||
      html.includes('is_blue_verified":true') ||
      html.includes('verified_organization') ||
      html.includes('blue_business') ||
      html.includes('"verification":')
    ) {
      verified = true;
    }

    const repMatch = html.match(/replyCount:(\d+)/);
    if (repMatch) replies = parseInt(repMatch[1], 10);

    const timeMatch = html.match(/publishedTime:\"([^\"]+)\"/);
    if (timeMatch) postedAt = timeMatch[1];

    let authorName = ogTitle.split(' on X')[0].trim();
    let handle = creator || '@user';
    const handleM = ogTitle.match(/\((@[a-zA-Z0-9_]+)\)/);
    if (handleM) {
      handle = handleM[1];
      authorName = ogTitle.split(' (')[0].trim();
    }

    if (!authorName) {
      const urlMatch = targetUrl.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/status/i);
      authorName = urlMatch ? urlMatch[1] : 'User';
    }

    const media: MediaItem[] = [];
    const seenMedia = new Set<string>();

    // 1. Post image from meta tags (strictly real pbs.twimg.com/media/ - reject jf.x.com dynamic routes)
    if (ogImage && !ogImage.includes('profile_images') && ogImage.includes('pbs.twimg.com/media/')) {
      media.push({ type: 'image', url: ogImage });
      seenMedia.add(ogImage);
    }

    // 2. Scan entire HTML for all unique pbs.twimg.com/media/ items (captures multi-image sets in SSR payload)
    const mediaMatches = Array.from(html.matchAll(/https:\/\/pbs\.twimg\.com\/media\/([a-zA-Z0-9_-]+)/g));
    for (const match of mediaMatches) {
      const mediaId = match[1];
      const fullUrl = `https://pbs.twimg.com/media/${mediaId}?format=jpg&name=orig`;
      if (!seenMedia.has(mediaId)) {
        seenMedia.add(mediaId);
        media.push({ type: 'image', url: fullUrl });
      }
    }

    const cleanDesc = cleanTweetText(ogDesc);
    const title = `${authorName} (${handle}) on X`;

    // Ensure we have resolved an avatar URL and verified status (fall back to author profile resolution)
    let finalAvatar = upgradeAvatarUrl(avatar || (ogImage && ogImage.includes('profile_images') ? ogImage : null));
    if ((!finalAvatar || !verified) && handle && handle !== '@user') {
      const profile = await resolveAuthorProfile(handle);
      if (!finalAvatar && profile.avatar_url) finalAvatar = profile.avatar_url;
      if (!verified) verified = profile.verified;
    }

    return {
      title,
      description: cleanDesc,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: finalAvatar,
          verified,
        },
        metrics: replies !== undefined ? { replies } : {},
        media: media.length > 0 ? media : null,
        posted_at: postedAt || new Date().toISOString(),
        video_thumbnail: null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Parses Twitter/X DOM HTML structure (from client inspector, Chrome extension, Cheerio, or Playwright).
 * Accurately extracts author, avatar, verified badge, full text, media gallery, exact metrics, and timestamps.
 */
export function parseTwitterHtml(rawHtml: string, targetUrl: string): ExtractionResult<XCardData> | null {
  if (!rawHtml || typeof rawHtml !== 'string' || !rawHtml.trim()) {
    return null;
  }

  try {
    const $ = cheerio.load(rawHtml);
    const article = $('article[data-testid="tweet"]').first();
    const scope = article.length > 0 ? article : undefined;
    const findIn = (selector: string) => (scope ? scope.find(selector) : $(selector));

    // 1. Author Name & Handle
    let authorName = '';
    let handle = '';

    const userNameEl = findIn('[data-testid="User-Name"]').first();
    if (userNameEl.length > 0) {
      const firstLink = userNameEl.find('a[role="link"]').first();
      authorName = firstLink.find('span').first().text().trim() || firstLink.text().trim();

      const textAll = userNameEl.text();
      const handleMatch = textAll.match(/@([a-zA-Z0-9_]+)/);
      if (handleMatch) {
        handle = `@${handleMatch[1]}`;
      }
    }

    // Fallbacks for handle and name
    if (!handle) {
      const urlMatch = targetUrl.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/status/i);
      if (urlMatch && !['status', 'i', 'home', 'explore'].includes(urlMatch[1].toLowerCase())) {
        handle = `@${urlMatch[1]}`;
      }
    }
    if (!authorName) {
      authorName = handle ? handle.replace(/^@/, '') : 'User';
    }
    if (!handle) {
      handle = '@user';
    }

    // 2. Author Avatar
    let avatarUrl: string | null = null;
    const avatarImg = findIn('[data-testid="Tweet-User-Avatar"] img, [data-testid^="UserAvatar-Container"] img').first();
    if (avatarImg.length > 0) {
      avatarUrl = avatarImg.attr('src') || null;
    }
    if (!avatarUrl) {
      const bgDiv = findIn('[data-testid="Tweet-User-Avatar"] [style*="background-image"]').first();
      if (bgDiv.length > 0) {
        const style = bgDiv.attr('style') || '';
        const match = style.match(/url\(['"]?(https?:\/\/[^'"]+)['"]?\)/i);
        if (match) avatarUrl = match[1];
      }
    }
    avatarUrl = upgradeAvatarUrl(avatarUrl);

    // 3. Verified Badge
    const verified =
      findIn('[data-testid="icon-verified"]').length > 0 ||
      findIn('svg[aria-label*="Verified"], svg[aria-label*="verified"]').length > 0;

    // 4. Tweet Text / Description
    let description = '';
    const tweetTextEl = findIn('[data-testid="tweetText"]').first();
    if (tweetTextEl.length > 0) {
      const cloned = tweetTextEl.clone();
      // Replace emoji images with their alt text
      cloned.find('img[alt]').each((_, el) => {
        const alt = $(el).attr('alt') || '';
        $(el).replaceWith(alt);
      });
      // Remove trailing media links
      cloned.find('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text() || '';
        if (/pic\.(?:twitter|x)\.com/i.test(href) || /pic\.(?:twitter|x)\.com/i.test(text)) {
          $(el).remove();
        }
      });
      description = cleanTweetText(cloned.text());
    }

    if (!description) {
      description = cleanTweetText(
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        ''
      );
    }

    // 5. Media (Images and Videos)
    const mediaList: MediaItem[] = [];
    const seenUrls = new Set<string>();

    findIn('[data-testid="tweetPhoto"]').each((_, el) => {
      const imgEl = $(el).find('img').first();
      let imgUrl = imgEl.attr('src') || '';
      if (!imgUrl) {
        const bgDiv = $(el).find('[style*="background-image"]').first();
        const match = (bgDiv.attr('style') || '').match(/url\(['"]?(https?:\/\/[^'"]+)['"]?\)/i);
        if (match) imgUrl = match[1];
      }
      if (imgUrl) {
        // Upgrade medium or small format to high-res orig
        imgUrl = imgUrl.replace(/name=(?:medium|small|thumb)/, 'name=orig');
        if (!seenUrls.has(imgUrl)) {
          seenUrls.add(imgUrl);
          mediaList.push({ type: 'image', url: imgUrl });
        }
      }
    });

    findIn('video').each((_, el) => {
      const vSrc = $(el).attr('src') || $(el).find('source').attr('src') || '';
      const poster = $(el).attr('poster') || '';
      const effectiveVideoUrl = vSrc || poster;
      if (effectiveVideoUrl && !seenUrls.has(effectiveVideoUrl)) {
        seenUrls.add(effectiveVideoUrl);
        mediaList.push({ type: 'video', url: effectiveVideoUrl });
      }
    });

    // 6. Metrics Extraction
    const metrics: XCardData['metrics'] = {};

    // Group aria-label check: e.g. "727 replies, 1727 reposts, 34252 likes, 15781 bookmarks, 15897425 views"
    const groupAria = findIn('[role="group"][aria-label]').attr('aria-label') || '';
    if (groupAria) {
      const repM = groupAria.match(/(\d[\d,.]*)\s*(?:replies|reply)/i);
      if (repM) metrics.replies = parseMetricValue(repM[1]);

      const retM = groupAria.match(/(\d[\d,.]*)\s*(?:reposts|repost|retweets|retweet)/i);
      if (retM) metrics.reposts = parseMetricValue(retM[1]);

      const likM = groupAria.match(/(\d[\d,.]*)\s*(?:likes|like)/i);
      if (likM) metrics.likes = parseMetricValue(likM[1]);

      const bkmM = groupAria.match(/(\d[\d,.]*)\s*(?:bookmarks|bookmark)/i);
      if (bkmM) metrics.bookmarks = parseMetricValue(bkmM[1]);

      const viwM = groupAria.match(/(\d[\d,.]*)\s*(?:views|view)/i);
      if (viwM) metrics.views = parseMetricValue(viwM[1]);
    }

    // Button fallbacks if not resolved from group aria-label
    if (metrics.replies === undefined) {
      const replyBtn = findIn('button[data-testid="reply"]');
      const aria = replyBtn.attr('aria-label') || '';
      const m = aria.match(/(\d[\d,.]*)\s*(?:replies|reply)/i);
      if (m) metrics.replies = parseMetricValue(m[1]);
      else if (replyBtn.text()) metrics.replies = parseMetricValue(replyBtn.text());
    }

    if (metrics.reposts === undefined) {
      const retweetBtn = findIn('button[data-testid="retweet"]');
      const aria = retweetBtn.attr('aria-label') || '';
      const m = aria.match(/(\d[\d,.]*)\s*(?:reposts|repost|retweets|retweet)/i);
      if (m) metrics.reposts = parseMetricValue(m[1]);
      else if (retweetBtn.text()) metrics.reposts = parseMetricValue(retweetBtn.text());
    }

    if (metrics.likes === undefined) {
      const likeBtn = findIn('button[data-testid="like"]');
      const aria = likeBtn.attr('aria-label') || '';
      const m = aria.match(/(\d[\d,.]*)\s*(?:likes|like)/i);
      if (m) metrics.likes = parseMetricValue(m[1]);
      else if (likeBtn.text()) metrics.likes = parseMetricValue(likeBtn.text());
    }

    if (metrics.bookmarks === undefined) {
      const bkmBtn = findIn('button[data-testid="bookmark"], button[data-testid="removeBookmark"]');
      const aria = bkmBtn.attr('aria-label') || '';
      const m = aria.match(/(\d[\d,.]*)\s*(?:bookmarks|bookmark)/i);
      if (m) metrics.bookmarks = parseMetricValue(m[1]);
      else if (bkmBtn.text()) metrics.bookmarks = parseMetricValue(bkmBtn.text());
    }

    if (metrics.views === undefined) {
      const viewsLink = findIn('a[href*="/analytics"]');
      const text = viewsLink.text();
      const m = text.match(/([\d.]+[KMBkmb]?)\s*Views/i);
      if (m) metrics.views = parseMetricValue(m[1]);
    }

    // 7. Posted At
    const timeEl = findIn('time[datetime]').first();
    const postedAt = timeEl.attr('datetime') || new Date().toISOString();

    const title = `${authorName} (${handle}) on X`;
    const hasVideo = mediaList.some((m) => m.type === 'video');
    const videoThumbnail = hasVideo ? mediaList[0]?.url || null : null;

    // Validate that we found meaningful tweet structure
    if (!authorName && !description && mediaList.length === 0) {
      return null;
    }

    return {
      title,
      description,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: avatarUrl,
          verified,
        },
        metrics,
        media: mediaList.length > 0 ? mediaList : null,
        posted_at: postedAt,
        video_thumbnail: videoThumbnail,
      },
    };
  } catch (error) {
    logger.warn('TwitterExtractor', 'Failed parsing Twitter HTML DOM:', error);
    return null;
  }
}

// -------------------------------------------------------------
// Tier 1: Open APIs for X (Twitter)
// -------------------------------------------------------------
async function tryFxTwitterApi(tweetId: string, targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    let res: any;
    try {
      res = await axios.get(`https://api.fxtwitter.com/status/${tweetId}`, {
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': DEFAULT_USER_AGENT,
        },
        validateStatus: (status) => status === 200,
      });
    } catch {
      // Try handle-based or /i/ endpoint variant
      const handleMatch = targetUrl.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)\/status/i);
      const slug = handleMatch && !['status', 'i', 'home', 'explore'].includes(handleMatch[1].toLowerCase()) ? handleMatch[1] : 'i';
      res = await axios.get(`https://api.fxtwitter.com/${slug}/status/${tweetId}`, {
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': DEFAULT_USER_AGENT,
        },
        validateStatus: (status) => status === 200,
      });
    }

    const tweet = res.data?.tweet;
    if (!tweet || !tweet.author) {
      return null;
    }

    const authorName = tweet.author.name || 'User';
    const handle = tweet.author.screen_name ? `@${tweet.author.screen_name}` : '@user';
    const title = `${authorName} (${handle}) on X`;
    const description = cleanTweetText(tweet.text || '');

    const mediaList: MediaItem[] = [];
    if (Array.isArray(tweet.media?.photos)) {
      tweet.media.photos.forEach((photo: Record<string, unknown>) => {
        if (typeof photo?.url === 'string') {
          mediaList.push({ type: 'image', url: photo.url });
        }
      });
    }
    if (Array.isArray(tweet.media?.videos)) {
      tweet.media.videos.forEach((video: Record<string, unknown>) => {
        const vUrl = typeof video?.url === 'string' ? video.url : '';
        const vThumb = typeof video?.thumbnail_url === 'string' ? video.thumbnail_url : '';
        if (vUrl || vThumb) {
          mediaList.push({
            type: 'video',
            url: vUrl || vThumb,
          });
        }
      });
    }

    // Support quote tweet media if root tweet has no attached media
    if (mediaList.length === 0 && tweet.quote?.media) {
      if (Array.isArray(tweet.quote.media.photos)) {
        tweet.quote.media.photos.forEach((photo: Record<string, unknown>) => {
          if (typeof photo?.url === 'string') {
            mediaList.push({ type: 'image', url: photo.url });
          }
        });
      }
      if (Array.isArray(tweet.quote.media.videos)) {
        tweet.quote.media.videos.forEach((video: Record<string, unknown>) => {
          const vUrl = typeof video?.url === 'string' ? video.url : '';
          const vThumb = typeof video?.thumbnail_url === 'string' ? video.thumbnail_url : '';
          if (vUrl || vThumb) {
            mediaList.push({
              type: 'video',
              url: vUrl || vThumb,
            });
          }
        });
      }
    }

    const snapshot =
      mediaList[0]?.url ||
      tweet.media?.photos?.[0]?.url ||
      tweet.media?.videos?.[0]?.thumbnail_url ||
      tweet.quote?.media?.photos?.[0]?.url ||
      tweet.quote?.media?.videos?.[0]?.thumbnail_url ||
      null;

    const metrics: XCardData['metrics'] = {};
    if (tweet.replies !== undefined && tweet.replies !== null) metrics.replies = parseMetricValue(tweet.replies);
    if (tweet.retweets !== undefined && tweet.retweets !== null) metrics.reposts = parseMetricValue(tweet.retweets);
    if (tweet.likes !== undefined && tweet.likes !== null) metrics.likes = parseMetricValue(tweet.likes);
    if (tweet.views !== undefined && tweet.views !== null) metrics.views = parseMetricValue(tweet.views);
    if (tweet.bookmarks !== undefined && tweet.bookmarks !== null) metrics.bookmarks = parseMetricValue(tweet.bookmarks);

    const postedAt = tweet.created_at
      ? new Date(tweet.created_at).toISOString()
      : new Date().toISOString();

    const hasVideo = mediaList.some((m) => m.type === 'video');
    let videoThumbnail: string | null = null;
    if (hasVideo) {
      videoThumbnail =
        tweet.media?.videos?.[0]?.thumbnail_url ||
        tweet.quote?.media?.videos?.[0]?.thumbnail_url ||
        tweet.media?.photos?.[0]?.url ||
        snapshot ||
        null;
    }

    let avatarUrl = upgradeAvatarUrl(tweet.author.avatar_url);
    let verified = Boolean(tweet.author.verification?.verified || tweet.author.verified);

    // Enrich avatar or verified status if missing
    if ((!avatarUrl || !verified) && handle && handle !== '@user') {
      const profile = await resolveAuthorProfile(handle);
      if (!avatarUrl && profile.avatar_url) avatarUrl = profile.avatar_url;
      if (!verified) verified = profile.verified;
    }

    return {
      title,
      description,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: avatarUrl,
          verified,
        },
        metrics,
        media: mediaList.length > 0 ? mediaList : null,
        posted_at: postedAt,
        video_thumbnail: videoThumbnail,
      },
    };
  } catch {
    return null;
  }
}

async function tryVxTwitterApi(tweetId: string, targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, {
      timeout: 3500,
      headers: {
        'Accept': 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
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
    const description = cleanTweetText(data.text || '');

    const mediaList: MediaItem[] = [];
    if (Array.isArray(data.media_extended)) {
      data.media_extended.forEach((item: Record<string, unknown>) => {
        if (typeof item?.url === 'string') {
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

    // Support quote tweet media if root tweet has no attached media
    if (mediaList.length === 0 && data.qrt) {
      if (Array.isArray(data.qrt.media_extended)) {
        data.qrt.media_extended.forEach((item: Record<string, unknown>) => {
          if (typeof item?.url === 'string') {
            mediaList.push({
              type: item.type === 'video' || item.type === 'gif' ? 'video' : 'image',
              url: item.url,
            });
          }
        });
      } else if (Array.isArray(data.qrt.mediaURLs)) {
        data.qrt.mediaURLs.forEach((u: string) => {
          mediaList.push({ type: 'image', url: u });
        });
      }
    }

    const snapshot = mediaList[0]?.url || null;

    const metrics: XCardData['metrics'] = {};
    if (data.replies !== undefined && data.replies !== null) metrics.replies = parseMetricValue(data.replies);
    if (data.retweets !== undefined && data.retweets !== null) metrics.reposts = parseMetricValue(data.retweets);
    if (data.likes !== undefined && data.likes !== null) metrics.likes = parseMetricValue(data.likes);

    const hasVideo = mediaList.some((m) => m.type === 'video');
    let videoThumbnail: string | null = null;
    if (hasVideo) {
      const vidObj = Array.isArray(data.media_extended)
        ? data.media_extended.find((m: Record<string, unknown>) => m.type === 'video' || m.type === 'gif')
        : Array.isArray(data.qrt?.media_extended)
        ? data.qrt.media_extended.find((m: Record<string, unknown>) => m.type === 'video' || m.type === 'gif')
        : null;
      videoThumbnail =
        (typeof vidObj?.thumbnail_url === 'string' ? vidObj.thumbnail_url : null) ||
        data.mediaURLs?.[0] ||
        data.qrt?.mediaURLs?.[0] ||
        snapshot ||
        null;
    }

    let avatarUrl = upgradeAvatarUrl(data.user_profile_image_url);
    let verified = Boolean(data.verified || data.user_verified);

    // Enrich avatar or verified status if missing
    if ((!avatarUrl || !verified) && handle && handle !== '@user') {
      const profile = await resolveAuthorProfile(handle);
      if (!avatarUrl && profile.avatar_url) avatarUrl = profile.avatar_url;
      if (!verified) verified = profile.verified;
    }

    return {
      title,
      description,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: authorName,
          handle,
          avatar_url: avatarUrl,
          verified,
        },
        metrics,
        media: mediaList.length > 0 ? mediaList : null,
        posted_at: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
        video_thumbnail: videoThumbnail,
      },
    };
  } catch {
    return null;
  }
}

async function tryTwitterOEmbed(targetUrl: string): Promise<ExtractionResult<XCardData> | null> {
  try {
    const res = await axios.get(`https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}`, {
      timeout: 3000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });
    const data = res.data;
    if (!data || !data.author_name) return null;

    // Extract tweet text strictly from <p>...</p>, omitting attribution footer
    const pMatch = (data.html || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const rawContent = pMatch ? pMatch[1] : (data.html || '');
    const cleanedText = cleanTweetText(rawContent);

    // Extract handle from author_url (e.g. https://x.com/vovudebosh -> @vovudebosh)
    let handle = '@user';
    if (data.author_url) {
      const slug = data.author_url.split('/').filter(Boolean).pop();
      if (slug) handle = `@${slug}`;
    }

    // Extract posted date from anchor in oEmbed html: <a href="...status/...">September 10, 2026</a>
    let postedAt = new Date().toISOString();
    const dateMatch = (data.html || '').match(/<a[^>]*href="[^"]*status\/\d+[^"]*"[^>]*>([^<]+)<\/a>/i);
    if (dateMatch && dateMatch[1]) {
      const parsedDate = new Date(dateMatch[1].trim());
      if (!isNaN(parsedDate.getTime())) {
        postedAt = parsedDate.toISOString();
      }
    }

    // Resolve author avatar and verified status using author profile / cache
    let avatarUrl: string | null = null;
    let verified = false;
    if (handle && handle !== '@user') {
      const profile = await resolveAuthorProfile(handle);
      avatarUrl = profile.avatar_url;
      verified = profile.verified;
    }

    return {
      title: `${data.author_name} (${handle}) on X`,
      description: cleanedText,
      logo: X_LOGO_URL,
      ogSiteName: 'X (formerly Twitter)',
      card_data: {
        author: {
          name: data.author_name,
          handle,
          avatar_url: avatarUrl,
          verified,
        },
        metrics: {},
        media: null,
        posted_at: postedAt,
      },
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// Twitter / X Extractor with Multi-Tier Fallback Pipeline
// -------------------------------------------------------------
export const twitterExtractor: PlatformExtractor<XCardData> = {
  platformKey: 'x',
  async extract(targetUrl: string, html?: string): Promise<ExtractionResult<XCardData>> {
    // -----------------------------------------------------------
    // Tier 0: Direct HTML DOM Extraction (from Client / Extension)
    // -----------------------------------------------------------
    if (html && typeof html === 'string' && html.trim()) {
      const parsedFromClient = parseTwitterHtml(html, targetUrl);
      if (parsedFromClient && (parsedFromClient.card_data.author.avatar_url || parsedFromClient.description || (parsedFromClient.card_data.media && parsedFromClient.card_data.media.length > 0))) {
        return parsedFromClient;
      }
    }

    const tweetId = extractTweetId(targetUrl);

    // -----------------------------------------------------------
    // Tier 1: High-Performance Open APIs (FxTwitter -> VxTwitter)
    // -----------------------------------------------------------
    if (tweetId) {
      const fxResult = await tryFxTwitterApi(tweetId, targetUrl);
      if (fxResult) return fxResult;

      const vxResult = await tryVxTwitterApi(tweetId, targetUrl);
      if (vxResult) return vxResult;
    }

    // -----------------------------------------------------------
    // Tier 2: Direct x.com Bot Scrape (Immune to Cloudflare Datacenter Blocks)
    // -----------------------------------------------------------
    const directResult = await tryDirectTwitterScrape(targetUrl);
    const hasFullMetricsAndMedia =
      directResult &&
      directResult.card_data.author.avatar_url &&
      directResult.card_data.metrics.likes !== undefined &&
      (directResult.card_data.metrics.reposts !== undefined || directResult.card_data.metrics.views !== undefined);

    if (hasFullMetricsAndMedia) {
      return directResult;
    }

    // -----------------------------------------------------------
    // Tier 3: Playwright Fallback (Renders DOM to extract exact likes, reposts, views, bookmarks & carousels)
    // -----------------------------------------------------------
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitSelector: 'article[data-testid="tweet"], article',
        waitTimeout: 4000,
        timeout: 8000,
        includeHtml: true,
      });

      if (pwData.html) {
        const domResult = parseTwitterHtml(pwData.html, targetUrl);
        if (domResult && (domResult.card_data.metrics.likes !== undefined || (domResult.card_data.media && domResult.card_data.media.length > 0))) {
          return domResult;
        }
      }
    } catch (err) {
      logger.debug('TwitterExtractor', 'Playwright scrape failed, proceeding to next tier:', err);
    }

    // If Playwright was unavailable or blocked, return directResult if it resolved an author
    if (directResult && directResult.card_data.author.avatar_url) {
      return directResult;
    }

    // -----------------------------------------------------------
    // Tier 4: Cheerio + Crawler Scrape Fallback
    // -----------------------------------------------------------
    try {
      const cheerioData = await scrapeWithCheerio(targetUrl);
      if (cheerioData?.rawHtml) {
        const domResult = parseTwitterHtml(cheerioData.rawHtml, targetUrl);
        if (domResult && (domResult.card_data.author.avatar_url || domResult.card_data.metrics.likes !== undefined)) {
          return domResult;
        }
      }
    } catch (err) {
      logger.debug('TwitterExtractor', 'Cheerio scrape failed, proceeding to oEmbed:', err);
    }

    // -----------------------------------------------------------
    // Tier 5: Official Twitter / X oEmbed API (with Profile Enrichment)
    // -----------------------------------------------------------
    const oembedResult = await tryTwitterOEmbed(targetUrl);
    if (oembedResult) return oembedResult;

    // Default graceful baseline
    return {
      title: 'Post on X',
      description: '',
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
        media: null,
        posted_at: new Date().toISOString(),
      },
    };
  },
};
