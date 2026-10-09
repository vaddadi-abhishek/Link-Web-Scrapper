import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, FacebookCardData, MediaItem, sanitizeMetrics } from './types';
import { playwrightEngine } from '../playwrightEngine';
import { cleanDescription } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';
import { avatarCache } from '../../utils/cache';
import { logger } from '../../utils/logger';

const FACEBOOK_LOGO_URL = 'https://www.facebook.com/favicon.ico';

function isFacebookReelOrVideo(targetUrl: string): boolean {
  return /\/(?:reels?|share\/[rv]|videos?|watch)/i.test(targetUrl);
}

function isMetricOrViewString(text: string): boolean {
  if (!text) return true;
  const l = text.toLowerCase().trim();
  if (
    /^\d+/.test(l) &&
    (l.includes('view') ||
      l.includes('వీక్షణలు') ||
      l.includes('reaction') ||
      l.includes('like') ||
      l.includes('share') ||
      l.includes('comment'))
  ) {
    return true;
  }
  if (l.includes('వీక్షణలు') || l.includes('views') || l.includes('reactions')) return true;
  if (/^[\d,.]+\s*[kmb]?\s*(?:views?|reactions?|likes?)?$/i.test(l)) return true;
  return false;
}

function isFacebookPostImage(url: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const l = url.toLowerCase();

  // Strictly reject non-post assets: emojis, UI icons, badges, favicons, data URIs
  if (
    l.startsWith('data:') ||
    l.includes('emoji.php') ||
    l.includes('rsrc.php') ||
    l.includes('static.xx.fbcdn.net') ||
    l.includes('favicon') ||
    l.includes('badge') ||
    l.includes('icon') ||
    l.includes('profile-display')
  ) {
    return false;
  }

  // Reject Facebook stickers, comment emojis, avatars, and profile pictures
  if (
    l.includes('t39.1997') || // Facebook stickers / comment emojis CDN
    l.includes('t39.30808-1') || // Facebook profile pictures CDN (specifically -1, not -6 which are post photos)
    l.includes('/stickers/') ||
    l.includes('sticker') ||
    l.includes('emoji') ||
    l.includes('120x120') ||
    l.includes('100x100') ||
    l.includes('40x40') ||
    l.includes('50x50')
  ) {
    return false;
  }

  // Reject HTML post or photo viewer pages on facebook.com
  if (l.includes('facebook.com') && !l.includes('fbcdn.net') && !l.includes('scontent') && !l.includes('fbsbx.com')) {
    return false;
  }

  // Accept lookaside crawler media, scontent CDN images, or direct valid image extensions
  return (
    l.includes('lookaside.fbsbx.com/lookaside/crawler/media') ||
    l.includes('scontent') ||
    (l.includes('fbcdn.net') && !l.includes('/static')) ||
    /\.(jpg|jpeg|png|webp)(?:\?.*)?$/i.test(l)
  );
}

export function isFacebookProfileUrl(targetUrl: string): boolean {
  if (!targetUrl) return false;
  try {
    const parsed = new URL(targetUrl);
    if (!parsed.hostname.includes('facebook.com')) return false;

    if (parsed.pathname === '/profile.php' && parsed.searchParams.has('id')) {
      return true;
    }

    if (parsed.pathname.startsWith('/people/')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && !['posts', 'videos', 'photos', 'reels'].includes(parts[parts.length - 1])) {
        return true;
      }
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return false;

    const systemPaths = new Set([
      'watch',
      'reel',
      'reels',
      'stories',
      'story.php',
      'photo',
      'photo.php',
      'photos',
      'video',
      'videos',
      'share',
      'permalink.php',
      'groups',
      'events',
      'gaming',
      'marketplace',
      'login',
      'login.php',
      'help',
      'settings',
      'policies',
      'recover',
      'checkpoint',
      'hashtag',
      'search',
      'dialog',
      'plugins',
    ]);

    const firstSegment = segments[0].toLowerCase();
    if (systemPaths.has(firstSegment)) return false;

    if (segments.length === 1) return true;

    if (segments.length === 2) {
      const profileSubpages = new Set(['about', 'followers', 'following', 'photos', 'reels', 'videos', 'community']);
      return profileSubpages.has(segments[1].toLowerCase());
    }

    return false;
  } catch {
    return false;
  }
}

function formatMetricShorthand(val: string | number | undefined | null): string | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[\d.]+[KMBkmb]?$/.test(trimmed)) return trimmed.toUpperCase();
    const clean = trimmed.replace(/,/g, '');
    const n = parseFloat(clean);
    if (!isNaN(n)) val = n;
    else return trimmed;
  }
  if (typeof val === 'number') {
    if (val >= 1_000_000) {
      const m = val / 1_000_000;
      return `${Math.floor(m)}M`;
    }
    if (val >= 1_000) {
      const k = val / 1_000;
      return `${Math.floor(k)}K`;
    }
    return val.toString();
  }
  return null;
}

/**
 * Resolves a lookaside.fbsbx.com crawler URL into a direct scontent.*.fbcdn.net image URL
 * that renders directly in any browser without login/redirect issues.
 */
async function resolveDirectFacebookCdnImage(mediaIdOrUrl: string): Promise<string> {
  if (!mediaIdOrUrl || typeof mediaIdOrUrl !== 'string') return mediaIdOrUrl;

  // Already a direct scontent CDN link
  if (mediaIdOrUrl.includes('scontent')) {
    return mediaIdOrUrl;
  }

  let mediaId: string | null = null;
  const m =
    mediaIdOrUrl.match(/media_id=(\d+)/i) ||
    mediaIdOrUrl.match(/fbid=(\d+)/i) ||
    mediaIdOrUrl.match(/\/photos\/[^/]+\/(\d+)/i) ||
    mediaIdOrUrl.match(/(\d{10,})/);
  if (m && m[1]) {
    mediaId = m[1];
  }

  if (!mediaId) return mediaIdOrUrl;

  const endpoints = [
    {
      url: `https://www.facebook.com/photo/?fbid=${mediaId}`,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    },
    {
      url: `https://m.facebook.com/photo.php?fbid=${mediaId}`,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    },
    {
      url: `https://www.facebook.com/photo.php?fbid=${mediaId}`,
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.get(ep.url, {
        headers: {
          'User-Agent': ep.ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 4000,
        maxRedirects: 5,
      });

      const $ = cheerio.load(res.data);
      const directImg = $('img[data-visualcompletion="media-vc-image"]').attr('src');
      if (directImg && directImg.includes('scontent')) {
        return directImg.replace(/&amp;/g, '&');
      }

      const matches = res.data.match(
        /https:\/\/[^"'\s\\]*scontent[^"'\s\\]*(?:dst-jpg|\.jpg|\.png|\.webp)[^"'\s\\]*/g
      );
      if (matches && matches.length > 0) {
        const cleanMatches = matches.map((item: string) =>
          item
            .replace(/\\u0025/g, '%')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
        );
        const postMatch = cleanMatches.find((item: string) => isFacebookPostImage(item));
        return postMatch || cleanMatches[0];
      }
    } catch {
      // Try next endpoint
    }
  }

  return mediaIdOrUrl;
}

function parseFacebookAuthor(
  rawTitle: string | null,
  targetUrl: string,
  finalUrl?: string | null,
  html?: string
): string {
  // 1. Check embedded script tags for explicit owner / creator names
  if (html) {
    const ownerNameMatch =
      html.match(/"video_owner"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i) ||
      html.match(/"owner"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i) ||
      html.match(/"owner_as_page"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i) ||
      html.match(/"actors"\s*:\s*\[\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i) ||
      html.match(/"owning_profile"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i);
    if (ownerNameMatch && ownerNameMatch[1]) {
      const candidate = ownerNameMatch[1]
        .replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
        .trim();
      if (candidate && !candidate.toLowerCase().includes('facebook') && !isMetricOrViewString(candidate)) {
        return candidate;
      }
    }
  }

  // 2. Parse from rawTitle
  if (rawTitle) {
    let clean = rawTitle.replace(/\s*\|\s*Facebook\s*$/i, '').trim();

    // Pattern 1: Pipe separated (e.g. "814K views · 6.8K reactions | Kendall Jenner opens up about happiness | Jay Shetty")
    // In Facebook video/reel titles, the author is the last non-metric segment
    if (clean.includes('|')) {
      const segments = clean
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s && !isMetricOrViewString(s));
      if (segments.length > 1) {
        const last = segments[segments.length - 1];
        if (last && !last.toLowerCase().includes('facebook') && !isMetricOrViewString(last)) {
          return last;
        }
      }
    }

    // Pattern 2: Middle dot (e.g. "Account Name · Video Title")
    if (clean.includes('·')) {
      const parts = clean
        .split('·')
        .map((s) => s.trim())
        .filter((s) => s && !isMetricOrViewString(s));
      if (parts.length > 0) {
        const candidate = parts[0];
        if (candidate && !candidate.toLowerCase().includes('facebook') && !isMetricOrViewString(candidate)) {
          return candidate;
        }
      }
    }

    // Pattern 3: "Account Name - Video Title"
    if (clean.includes(' - ')) {
      const parts = clean
        .split(' - ')
        .map((s) => s.trim())
        .filter((s) => s && !isMetricOrViewString(s));
      if (parts.length > 0) {
        const candidate = parts[0];
        if (candidate && !candidate.toLowerCase().includes('facebook') && !isMetricOrViewString(candidate)) {
          return candidate;
        }
      }
    }

    // Pattern 4: "Video Title | By Account Name"
    const byMatch = clean.match(/^(.*?)\s*\|\s*By\s+([^|]+)$/i);
    if (byMatch && byMatch[2] && !isMetricOrViewString(byMatch[2])) {
      return byMatch[2].trim();
    }

    // Pattern 5: "Account Name on Facebook: 'Caption'" or "Account Name on Facebook"
    const onMatch = clean.match(/^([^:]+)\s+on\s+Facebook/i);
    if (onMatch && onMatch[1] && !isMetricOrViewString(onMatch[1])) {
      return onMatch[1].trim();
    }

    // Pattern 6: "Account Name's Reel" or "Account Name - Reels"
    const reelMatch = clean.match(/^(.+?)(?:'s\s+Reel|\s+Reels)$/i);
    if (reelMatch && reelMatch[1] && !isMetricOrViewString(reelMatch[1])) {
      return reelMatch[1].trim();
    }

    // Pattern 7: Direct page / author name (e.g. "El-bethel Revival Centre", "We Thought")
    if (
      clean &&
      !clean.toLowerCase().includes('facebook') &&
      !isMetricOrViewString(clean) &&
      clean !== 'Log in or sign up to view'
    ) {
      return clean;
    }
  }

  // Fallback to URL path slug
  const checkUrl = finalUrl || targetUrl;
  const match = checkUrl.match(/facebook\.com\/([a-zA-Z0-9.-]+)\/(?:posts|videos|reel|photos)/i);
  if (match && match[1] && !['share', 'watch', 'reel', 'reels', 'p'].includes(match[1].toLowerCase())) {
    const raw = match[1].replace(/[.-]/g, ' ').trim();
    if (raw && !isMetricOrViewString(raw)) {
      return raw.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  return 'Facebook User';
}

function extractFacebookMetrics(html: string, combinedText?: string): FacebookCardData['metrics'] {
  let likes = 0;
  let comments = 0;
  let shares = 0;

  // 1. Reactions / Likes from script payloads
  const reactionMatch =
    html.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i) ||
    html.match(/"reaction_count"\s*:\s*(\d+)/i) ||
    html.match(/"like_count"\s*:\s*(\d+)/i);
  if (reactionMatch && reactionMatch[1]) {
    likes = parseInt(reactionMatch[1], 10);
  }

  // 2. Comments from script payloads
  const commentMatch =
    html.match(/"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i) ||
    html.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i) ||
    html.match(/"total_comment_count"\s*:\s*(\d+)/i);
  if (commentMatch && commentMatch[1]) {
    comments = parseInt(commentMatch[1], 10);
  }

  // 3. Shares from script payloads
  const shareMatch =
    html.match(/"share_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i) ||
    html.match(/"i18n_share_count"\s*:\s*"(\d+)"/i);
  if (shareMatch && shareMatch[1]) {
    shares = parseInt(shareMatch[1], 10);
  }

  // 4. Text regex fallback if any metric is still 0
  if (combinedText) {
    if (!likes) {
      const likesMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s*(?:likes?|reactions?)/i);
      if (likesMatch && likesMatch[1]) likes = parseFormattedNumber(likesMatch[1]);
    }
    if (!comments) {
      const commentsMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s*comments?/i);
      if (commentsMatch && commentsMatch[1]) comments = parseFormattedNumber(commentsMatch[1]);
    }
    if (!shares) {
      const sharesMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s*shares?/i);
      if (sharesMatch && sharesMatch[1]) shares = parseFormattedNumber(sharesMatch[1]);
    }
  }

  return sanitizeMetrics({ likes, comments, shares });
}

function extractFacebookFullDescription(html: string, ogDesc?: string | null): string | null {
  if (!html) return null;

  const candidates: string[] = [];

  // Priority 1: Match story message text inside JSON payloads: "message":{"text":"..."}
  const messageRegex = /"message"\s*:\s*\{[^}]*"text"\s*:\s*"((?:\\.|[^"\\]){50,})"/g;
  let msgMatch: RegExpExecArray | null;
  while ((msgMatch = messageRegex.exec(html)) !== null) {
    const unescaped = msgMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
      .trim();

    if (unescaped && !candidates.includes(unescaped)) {
      candidates.push(unescaped);
    }
  }

  // Priority 2: General "text":"..." blocks of at least 60 characters
  const regex = /"text"\s*:\s*"((?:\\.|[^"\\]){60,})"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const unescaped = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
      .trim();

    const lower = unescaped.toLowerCase();
    const isBoilerplate =
      lower.includes('log in or sign up to view') ||
      lower.includes('related videos') ||
      (lower.includes('see more of') && lower.includes('on facebook')) ||
      lower.includes('facebook ©') ||
      lower.startsWith('{"') ||
      lower.startsWith('["');

    if (unescaped && !isBoilerplate && !candidates.includes(unescaped)) {
      candidates.push(unescaped);
    }
  }

  // 1. If ogDesc is provided, find matching candidates that start with or contain the prefix
  if (ogDesc && ogDesc.trim()) {
    const cleanOg = ogDesc.replace(/[\n\r\t]+/g, ' ').trim();
    const prefix = cleanOg.substring(0, Math.min(30, cleanOg.length)).trim();
    const matching = candidates.filter((c) => {
      const cleanCandidate = c.replace(/[\n\r\t]+/g, ' ').trim();
      return cleanCandidate.startsWith(prefix) || cleanCandidate.includes(prefix);
    });
    if (matching.length > 0) {
      matching.sort((a, b) => b.length - a.length);
      return matching[0];
    }
  }

  // 2. If candidates exist, return the longest valid candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }

  return null;
}

async function resolveFacebookAuthorAvatar(
  html: string,
  authorName: string,
  targetUrl: string,
  finalUrl?: string | null
): Promise<string> {
  const cacheKey = `fb_${authorName}_${finalUrl || targetUrl}`;
  const cached = avatarCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const candidates: string[] = [];

  // 1. From URLs: finalUrl or targetUrl
  const urlsToCheck = [finalUrl, targetUrl].filter(Boolean) as string[];
  for (const u of urlsToCheck) {
    // Check people format: facebook.com/people/Name/ID/
    const peopleMatch = u.match(/facebook\.com\/people\/([^/]+)\/(\d+)/i);
    if (peopleMatch) {
      candidates.push(peopleMatch[2]);
      candidates.push(peopleMatch[1]);
    }
    const slugMatch = u.match(/facebook\.com\/([a-zA-Z0-9.-]+)\/(?:posts|videos|reel|photos|\?|$)/i);
    if (slugMatch && slugMatch[1] && !['share', 'watch', 'reel', 'reels', 'p', 'people'].includes(slugMatch[1].toLowerCase())) {
      candidates.push(slugMatch[1]);
    }
  }

  // 2. From HTML script payloads
  if (html) {
    const actorMatch =
      html.match(/"actors"\s*:\s*\[\s*\{[^}]*"id"\s*:\s*"(\d+)"/i) ||
      html.match(/"owner"\s*:\s*\{[^}]*"id"\s*:\s*"(\d+)"/i) ||
      html.match(/"owning_profile"\s*:\s*\{[^}]*"id"\s*:\s*"(\d+)"/i) ||
      html.match(/"profile_picture":\s*\{\s*"uri"\s*:\s*"[^"]*media_id=(\d+)"/i);
    if (actorMatch && actorMatch[1]) {
      candidates.push(actorMatch[1]);
    }

    const actorUrlMatch =
      html.match(/"actors"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"https:\\\/\\\/www\.facebook\.com\\\/people\\\/([^\\/"]+)\\\/(\d+)\\\/"/i);
    if (actorUrlMatch) {
      candidates.push(actorUrlMatch[2]);
      candidates.push(actorUrlMatch[1]);
    }

    const standardActorUrl =
      html.match(/"actors"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"https:\\\/\\\/www\.facebook\.com\\\/([^\\/"]+)\\\/"/i) ||
      html.match(/"profile_url"\s*:\s*"https:\\\/\\\/www\.facebook\.com\\\/([^\\/"]+)\\\/"/i) ||
      html.match(/"permalink_url"\s*:\s*"https:\\\/\\\/www\.facebook\.com\\\/([^\\/"]+)\\\/(?:videos|posts)/i);
    if (standardActorUrl && standardActorUrl[1] && !['share', 'watch', 'reel', 'reels', 'p', 'people'].includes(standardActorUrl[1].toLowerCase())) {
      candidates.push(standardActorUrl[1]);
    }
  }

  // 3. From Author Name
  if (authorName && authorName !== 'Facebook User') {
    const cleanName = authorName.replace(/[^a-zA-Z0-9.-]/g, '');
    if (cleanName && !candidates.includes(cleanName)) {
      candidates.push(cleanName);
    }
  }

  // Deduplicate and prioritize numeric IDs (best for Graph API), take top 2 to avoid waterfall delays
  const uniqueCandidates = Array.from(new Set(candidates))
    .filter(Boolean)
    .sort((a, b) => (/^\d+$/.test(b) ? 1 : 0) - (/^\d+$/.test(a) ? 1 : 0))
    .slice(0, 2);

  for (const slugOrId of uniqueCandidates) {
    // 1. Try public Graph API
    try {
      const gRes = await axios.get(
        `https://graph.facebook.com/${encodeURIComponent(slugOrId)}/picture?type=large&redirect=false`,
        { timeout: 2000 }
      );
      if (gRes.data?.data?.url && !gRes.data.data.is_silhouette) {
        const resolved = gRes.data.data.url;
        avatarCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch {}

    // 2. Fallback: Try m.facebook.com with mobile headers
    try {
      const mRes = await axios.get(`https://m.facebook.com/${encodeURIComponent(slugOrId)}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        maxRedirects: 5,
        timeout: 2000,
      });
      const $ = cheerio.load(mRes.data);
      const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[property="og:image:secure_url"]').attr('content');
      if (ogImg && (ogImg.includes('scontent') || ogImg.includes('fbcdn.net')) && !ogImg.includes('static')) {
        const resolved = ogImg.replace(/&amp;/g, '&');
        avatarCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch {}
  }

  // Fallback to clean UI-Avatar
  const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=1877f2&color=fff&size=128&bold=true`;
  avatarCache.set(cacheKey, fallbackAvatar);
  return fallbackAvatar;
}

async function extractFacebookProfile(
  targetUrl: string,
  crawlerHtml: string,
  finalUrl?: string | null
): Promise<ExtractionResult<FacebookCardData>> {
  let rawHtml = crawlerHtml || '';
  const $ = cheerio.load(rawHtml);

  // 1. Author Name
  let name = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Facebook User';
  name = name.replace(/\s*\|\s*Facebook$/i, '').trim();
  if (!name || name === 'Log in or sign up to view') {
    const slugMatch = (finalUrl || targetUrl).match(/facebook\.com\/([a-zA-Z0-9.-]+)/i);
    if (slugMatch && slugMatch[1]) {
      name = slugMatch[1].replace(/[.-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // 2. Verified status
  let verified =
    rawHtml.includes('"is_verified":true') ||
    rawHtml.includes('"verification_status":"BLUE_VERIFIED"') ||
    rawHtml.includes('"verification_status":"VERIFIED"') ||
    rawHtml.includes('title="Verified account"') ||
    rawHtml.includes('<title>Verified account</title>') ||
    rawHtml.includes('aria-label="Verified account"');

  // 3. Author Avatar
  let authorAvatar: string | null = null;
  const avatarMatch =
    rawHtml.match(/"profile_picture":\s*\{[^}]*"uri":\s*"([^"]+)"/i) ||
    rawHtml.match(/"profilePhoto":\s*\{[^}]*"uri":\s*"([^"]+)"/i);
  if (avatarMatch && avatarMatch[1]) {
    const cleanAv = avatarMatch[1]
      .replace(/\\\//g, '/')
      .replace(/\\u0025/g, '%')
      .replace(/\\u0026/g, '&');
    if (!cleanAv.includes('lookaside')) {
      authorAvatar = cleanAv;
    }
  }
  if (!authorAvatar) {
    authorAvatar = await resolveFacebookAuthorAvatar(rawHtml, name, targetUrl, finalUrl);
  }

  // 4. Banner / Cover photo
  let coverUri: string | null = null;
  const coverMatch =
    rawHtml.match(/"cover_photo":\s*\{[^}]*"image":\s*\{\s*"uri":\s*"([^"]+)"/i) ||
    rawHtml.match(/"cover_photo":\s*\{[^}]*"photo":\s*\{[^}]*"image":\s*\{\s*"uri":\s*"([^"]+)"/i) ||
    rawHtml.match(/"cover_photo":\s*\{[^}]*"id":\s*"(\d+)"/i) ||
    rawHtml.match(/"profile_cover_photo":\s*\{[^}]*"uri":\s*"([^"]+)"/i) ||
    rawHtml.match(/"header_photo":\s*\{[^}]*"uri":\s*"([^"]+)"/i);
  if (coverMatch && coverMatch[1]) {
    coverUri = coverMatch[1]
      .replace(/\\\//g, '/')
      .replace(/\\u0025/g, '%')
      .replace(/\\u0026/g, '&');
  }

  let bannerUrl: string | null = null;
  if (coverUri) {
    bannerUrl = await resolveDirectFacebookCdnImage(coverUri);
  }

  // 5. Bio / Description
  let bio: string | null = null;
  const bioMatch =
    rawHtml.match(/"best_description":\s*\{\s*"text":\s*"([^"]+)"/i) ||
    rawHtml.match(/"bio_text":\s*\{\s*"text":\s*"([^"]+)"/i) ||
    rawHtml.match(/"profile_bio":\s*\{\s*"text":\s*"([^"]+)"/i);
  if (bioMatch && bioMatch[1]) {
    bio = bioMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      .replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
      .trim();
  }

  if (!bio) {
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    // Pattern: "Spider-Man. 19,920,702 followers · 80 talking about this. Welcome to the official..."
    const stripped = ogDesc.replace(/^[^.]+\.\s*[\d,.]+[KMBkmb]?\s*(?:followers|likes)[^.]*\.\s*/i, '').trim();
    if (stripped && !stripped.toLowerCase().includes('log in or sign up')) {
      bio = stripped;
    }
  }

  // 6. Followers & Following
  let followers: string | null = null;
  let following: string | null = null;

  // Check JSON "text":"... followers"
  const followersTextMatch =
    rawHtml.match(/"text":\s*"([^\"]*followers[^\"]*)"/i) ||
    rawHtml.match(/"follower_count":\s*(\d+)/i);
  if (followersTextMatch && followersTextMatch[1]) {
    const m = followersTextMatch[1].match(/([\d,.]+[KMBkmb]?)/i);
    if (m) followers = formatMetricShorthand(m[1]);
  }

  if (!followers) {
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    const m = ogDesc.match(/([\d,.]+[KMBkmb]?)\s*followers/i);
    if (m) followers = formatMetricShorthand(m[1]);
  }

  const followingTextMatch =
    rawHtml.match(/"text":\s*"([^\"]*following[^\"]*)"/i) ||
    rawHtml.match(/"following_count":\s*(\d+)/i);
  if (followingTextMatch && followingTextMatch[1]) {
    const m = followingTextMatch[1].match(/([\d,.]+[KMBkmb]?)/i);
    if (m) following = formatMetricShorthand(m[1]);
  }

  // 7. Category
  let category: string | null = null;
  const catMatch =
    rawHtml.match(/"category_name":\s*"([^"]+)"/i) ||
    rawHtml.match(/"page_category":\s*"([^"]+)"/i);
  if (catMatch && catMatch[1]) {
    category = catMatch[1]
      .replace(/\\u[\dA-F]{4}/gi, (m) => String.fromCharCode(parseInt(m.replace(/\\u/g, ''), 16)))
      .trim();
  }

  // 8. If Playwright is needed (e.g. bannerUrl or bio or followers missing)
  if (!bannerUrl || !bio || !followers) {
    try {
      const pwResult = await playwrightEngine.scrape<any>(finalUrl || targetUrl, {
        waitSelector: 'h1, [role="main"]',
        waitTimeout: 2000,
        timeout: 7000,
        customEvaluator: async (page) => {
          return await page.evaluate(() => {
            const coverEl =
              document.querySelector('img[data-imgperflogname="profileCoverPhoto"]') ||
              document.querySelector('a[aria-label*="cover photo" i] img') ||
              document.querySelector('a[href*="/photo/"] img');
            const pwCover = coverEl ? (coverEl as HTMLImageElement).src : null;

            let pwAvatar: string | null = null;
            const svgImg = document.querySelector('svg image');
            if (svgImg) {
              pwAvatar = svgImg.getAttribute('xlink:href') || svgImg.getAttribute('href');
            }
            if (!pwAvatar) {
              const profImg = document.querySelector('img[data-imgperflogname="profilePhoto"]');
              if (profImg) pwAvatar = (profImg as HTMLImageElement).src;
            }

            const h1 = document.querySelector('h1');
            const pwName = h1 ? h1.innerText.trim() : null;

            const isVer = Boolean(
              document.querySelector('svg title')?.textContent?.includes('Verified') ||
              document.querySelector('svg[aria-label*="Verified" i]') ||
              document.querySelector('[aria-label*="Verified account" i]')
            );

            let pwFollowers: string | null = null;
            let pwFollowing: string | null = null;
            const links = Array.from(document.querySelectorAll('a'));
            for (const a of links) {
              const href = a.getAttribute('href') || '';
              const text = a.innerText.trim();
              if (href.includes('/followers')) {
                const m = text.match(/([\d,.]+[KMBkmb]?)/i);
                if (m) pwFollowers = m[1];
              } else if (href.includes('/following')) {
                const m = text.match(/([\d,.]+[KMBkmb]?)/i);
                if (m) pwFollowing = m[1];
              }
            }

            let pwCategory: string | null = null;
            const detailsList = document.querySelector('[aria-label="Highlighted details"]');
            if (detailsList) {
              pwCategory = (detailsList as HTMLElement).innerText.trim();
            }

            let pwBio: string | null = null;
            const bioSpans = Array.from(document.querySelectorAll('span[dir="auto"]'));
            for (const s of bioSpans) {
              const txt = (s as HTMLElement).innerText?.trim();
              if (
                txt &&
                txt.length > 15 &&
                !txt.includes('followers') &&
                !txt.includes('following') &&
                !txt.includes('Message') &&
                !txt.includes('Follow') &&
                !txt.includes('Search') &&
                !txt.includes('Log in')
              ) {
                pwBio = txt;
                break;
              }
            }

            return {
              pwCover,
              pwAvatar,
              pwName,
              isVer,
              pwFollowers,
              pwFollowing,
              pwCategory,
              pwBio,
            };
          });
        },
      });

      if (pwResult.customData) {
        const cd = pwResult.customData;
        if (!bannerUrl && cd.pwCover) bannerUrl = cd.pwCover;
        if ((!authorAvatar || authorAvatar.includes('ui-avatars')) && cd.pwAvatar) authorAvatar = cd.pwAvatar;
        if (!name || name === 'Facebook User') if (cd.pwName) name = cd.pwName;
        if (!verified && cd.isVer) verified = true;
        if (!followers && cd.pwFollowers) followers = formatMetricShorthand(cd.pwFollowers);
        if (!following && cd.pwFollowing) following = formatMetricShorthand(cd.pwFollowing);
        if (!category && cd.pwCategory) category = cd.pwCategory;
        if (!bio && cd.pwBio) bio = cd.pwBio;
      }
    } catch {
      // Playwright fallback failed, keep static results
    }
  }

  const finalBio = bio ? cleanDescription(bio) || null : null;

  return {
    title: null,
    description: finalBio,
    logo: FACEBOOK_LOGO_URL,
    ogSiteName: 'Facebook',
    card_data: {
      author: {
        name,
        avatar_url: authorAvatar,
        verified,
      },
      metrics: null,
      followers,
      following,
      media: null,
      images: null,
      banner_url: bannerUrl,
      category,
      is_profile: true,
      posted_at: new Date().toISOString(),
      video_thumbnail: null,
    },
  };
}

export const facebookExtractor: PlatformExtractor<FacebookCardData> = {
  platformKey: 'facebook',
  async extract(targetUrl: string): Promise<ExtractionResult<FacebookCardData>> {
    let isVideo = isFacebookReelOrVideo(targetUrl);
    let isProfile = isFacebookProfileUrl(targetUrl);

    let rawTitle: string | null = null;
    let rawDesc: string | null = null;
    let candidateImage: string | null = null;
    let videoUrl: string | null = null;
    let authorName: string | null = null;
    let authorAvatar: string | null = null;
    let publishedAt: string | null = null;
    let finalUrl: string | null = null;
    let rawHtml = '';
    let metrics: FacebookCardData['metrics'] = null;
    const discoveredImages: string[] = [];

    // -----------------------------------------------------------
    // Tier 1: Fast-Path Axios Parallel Fetch (~250ms)
    // -----------------------------------------------------------
    // 1) Crawler headers (standard for posts & reels - contains rich script payloads & metrics)
    // 2) If isVideo, iOS mobile headers (returns og:video and direct .mp4 CDN stream link!)
    const crawlerPromise = axios
      .get(targetUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        maxRedirects: 5,
        timeout: 3500,
        validateStatus: (status) => status >= 200 && status < 400,
      })
      .catch(() => null);

    const iosPromise = isVideo
      ? axios
          .get(targetUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            maxRedirects: 5,
            timeout: 3500,
            validateStatus: (status) => status >= 200 && status < 400,
          })
          .catch(() => null)
      : Promise.resolve(null);

    const [crawlerRes, iosRes] = await Promise.all([crawlerPromise, iosPromise]);

    if (iosRes && iosRes.data) {
      const iosHtml = String(iosRes.data);
      const $ios = cheerio.load(iosRes.data);
      videoUrl =
        $ios('meta[property="og:video"]').attr('content') ||
        $ios('meta[property="og:video:secure_url"]').attr('content') ||
        $ios('meta[property="og:video:url"]').attr('content') ||
        null;

      if (!videoUrl) {
        const mp4Matches = [...iosHtml.matchAll(/https:[^"'\s\\]+?\.mp4[^"'\s\\]*/gi)];
        for (const m of mp4Matches) {
          const url = m[0];
          // Exclude standalone audio streams (e.g. DASH audio stream segments)
          if (url.includes('dash_ln_heaac') || url.includes('_audio') || url.includes('vbr3_audio')) {
            continue;
          }
          videoUrl = url
            .replace(/\\u0025/g, '%')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&');
          break;
        }
      }

      candidateImage =
        $ios('meta[property="og:image"]').attr('content') ||
        $ios('meta[property="og:image:secure_url"]').attr('content') ||
        null;
      rawTitle = $ios('meta[property="og:title"]').attr('content') || $ios('title').text() || null;
      rawDesc = $ios('meta[property="og:description"]').attr('content') || null;
    }

    if (crawlerRes && crawlerRes.data) {
      rawHtml = String(crawlerRes.data);
      finalUrl = crawlerRes.request?.res?.responseUrl || crawlerRes.config.url || targetUrl;

      if (!isProfile) {
        if (
          rawHtml.includes('__isRenderedProfile') ||
          rawHtml.includes('"profile_cover_photo"') ||
          rawHtml.includes('profileCoverPhoto') ||
          rawHtml.includes('"best_description"') ||
          /og:description"[^>]*content="[^"]*followers[^"]*talking about this/i.test(rawHtml)
        ) {
          isProfile = true;
        }
      }
    }

    if (isProfile) {
      return await extractFacebookProfile(targetUrl, rawHtml, finalUrl);
    }

    if (crawlerRes && crawlerRes.data) {
      const $ = cheerio.load(crawlerRes.data);

      if (!rawTitle) {
        rawTitle =
          $('meta[property="og:title"]').attr('content') ||
          $('meta[name="twitter:title"]').attr('content') ||
          $('title').text() ||
          null;
      }
      if (!rawDesc) {
        rawDesc =
          $('meta[property="og:description"]').attr('content') ||
          $('meta[name="description"]').attr('content') ||
          null;
      }
      if (!candidateImage) {
        candidateImage =
          $('meta[property="og:image"]').attr('content') ||
          $('meta[property="og:image:secure_url"]').attr('content') ||
          $('meta[name="twitter:image"]').attr('content') ||
          null;
      }
      if (!authorName) {
        authorName =
          $('meta[name="author"]').attr('content') ||
          $('meta[property="article:author"]').attr('content') ||
          null;
      }
      publishedAt =
        $('meta[property="article:published_time"]').attr('content') ||
        $('meta[name="pubdate"]').attr('content') ||
        null;

      // Prioritize data-visualcompletion="media-vc-image"
      const directVcImg = $('img[data-visualcompletion="media-vc-image"]').attr('src');
      if (directVcImg && isFacebookPostImage(directVcImg)) {
        candidateImage = directVcImg.replace(/&amp;/g, '&');
      }

      // Collect all legitimate post images from HTML (ignoring comments/comment forms)
      $('img').each((_, el) => {
        const $el = $(el);
        if ($el.closest('[role="article"], [aria-label*="comment" i], form').length > 0) {
          return;
        }
        const src = $el.attr('src');
        if (src && isFacebookPostImage(src) && !discoveredImages.includes(src)) {
          discoveredImages.push(src);
        }
      });

      // Extract metrics from script payloads
      const textContent = `${rawTitle || ''} ${rawDesc || ''} ${$('body').text()}`;
      metrics = extractFacebookMetrics(rawHtml, textContent);

      // Detect if post is a video even if initial URL did not explicitly indicate it
      const ogType = $('meta[property="og:type"]').attr('content') || '';
      const isVideoPost =
        ogType.includes('video') ||
        isFacebookReelOrVideo(finalUrl || '') ||
        /video_inline|playable_duration/i.test(rawHtml);
      if (isVideoPost) {
        isVideo = true;
      }

      // If recognized as video and videoUrl was not resolved via initial iosPromise, fetch via mobile headers now
      if (isVideo && !videoUrl) {
        try {
          const lateIosRes = await axios.get(finalUrl || targetUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            maxRedirects: 5,
            timeout: 3500,
          });
          if (lateIosRes && lateIosRes.data) {
            const $late = cheerio.load(lateIosRes.data);
            videoUrl =
              $late('meta[property="og:video"]').attr('content') ||
              $late('meta[property="og:video:secure_url"]').attr('content') ||
              $late('meta[property="og:video:url"]').attr('content') ||
              null;
            if (!videoUrl) {
              const mp4Matches = String(lateIosRes.data).match(/https:[^"'\s\\]+?\.mp4[^"'\s\\]*/gi);
              if (mp4Matches && mp4Matches[0]) {
                videoUrl = mp4Matches[0]
                  .replace(/\\u0025/g, '%')
                  .replace(/\\u0026/g, '&')
                  .replace(/\\\//g, '/')
                  .replace(/&amp;/g, '&');
              }
            }
          }
        } catch {}
      }
    }

    // -----------------------------------------------------------
    // Tier 2: Playwright Fallback (<2s)
    // -----------------------------------------------------------
    if (!rawTitle && !candidateImage && !videoUrl && discoveredImages.length === 0) {
      try {
        const pwResult = await playwrightEngine.scrape<any>(targetUrl, {
          waitSelector: '[role="main"], [role="feed"], article, main',
          waitTimeout: 1500,
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          customEvaluator: async (page) => {
            return await page.evaluate(() => {
              const getMeta = (...names: string[]) => {
                for (const name of names) {
                  const el =
                    document.querySelector(`meta[property="${name}"]`) ||
                    document.querySelector(`meta[name="${name}"]`);
                  if (el) {
                    const c = el.getAttribute('content');
                    if (c && c.trim()) return c.trim();
                  }
                }
                return null;
              };

              const title = getMeta('og:title', 'twitter:title', 'title') || document.title || null;
              const desc = getMeta('og:description', 'twitter:description', 'description') || null;
              let image = getMeta('og:image', 'og:image:secure_url', 'twitter:image') || null;

              const vcImg = document.querySelector('img[data-visualcompletion="media-vc-image"]');
              if (vcImg && (vcImg as HTMLImageElement).src) {
                image = (vcImg as HTMLImageElement).src;
              }

              const imgs: string[] = [];
              document.querySelectorAll('img').forEach((img) => {
                // Ignore comment section images and stickers
                if (img.closest('[role="article"], [aria-label*="comment" i], form')) {
                  return;
                }
                const src = (img as HTMLImageElement).src;
                if (src) imgs.push(src);
              });

              const author = getMeta('author', 'article:author');
              const pubTime = getMeta('article:published_time', 'pubdate');

              return {
                title,
                desc,
                image,
                imgs,
                author,
                pubTime,
                html: document.documentElement.innerHTML,
                bodyText: document.body?.innerText || '',
              };
            });
          },
        });

        if (pwResult.customData) {
          if (!rawTitle) rawTitle = pwResult.customData.title;
          if (!rawDesc) rawDesc = pwResult.customData.desc;
          if (!candidateImage) candidateImage = pwResult.customData.image;
          if (!authorName) authorName = pwResult.customData.author;
          if (!publishedAt) publishedAt = pwResult.customData.pubTime;
          if (Array.isArray(pwResult.customData.imgs)) {
            pwResult.customData.imgs.forEach((u: string) => {
              if (isFacebookPostImage(u) && !discoveredImages.includes(u)) {
                discoveredImages.push(u);
              }
            });
          }
          if (!metrics?.likes && !metrics?.comments && !metrics?.shares && pwResult.customData.html) {
            metrics = extractFacebookMetrics(pwResult.customData.html, pwResult.customData.bodyText);
          }
        }
      } catch {}
    }

    // For Reels and Videos, Facebook SSR payloads omit share counts.
    // If shares is 0 or null, fetch live action bar metrics via Playwright evaluator.
    if (isVideo && (!metrics?.shares)) {
      try {
        const pwTarget = finalUrl || targetUrl;
        const pwMetrics = await playwrightEngine.scrape<any>(pwTarget, {
          waitSelector: '[role="button"]',
          waitTimeout: 2000,
          timeout: 8000,
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          customEvaluator: async (page) => {
            return await page.evaluate(() => {
              const getButtonText = (btn: Element) => {
                let p: Element | null = btn;
                for (let i = 0; i < 4; i++) {
                  if (!p) break;
                  const nextSibling = p.nextElementSibling as HTMLElement | null;
                  const nextText = nextSibling?.innerText?.trim();
                  if (nextText) return nextText;
                  const selfText = (p as HTMLElement).innerText?.trim();
                  if (selfText) return selfText;
                  p = p.parentElement;
                }
                return null;
              };

              const buttons = Array.from(document.querySelectorAll('[role="button"]'));
              let likes: string | null = null;
              let comments: string | null = null;
              let shares: string | null = null;

              for (const b of buttons) {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                if (
                  aria.includes('share') ||
                  aria.includes('భాగస్వామ్యం') ||
                  aria.includes('compartir') ||
                  aria.includes('partager') ||
                  aria.includes('teilen')
                ) {
                  shares = getButtonText(b);
                }
                if (
                  aria.includes('like') ||
                  aria.includes('లైక్') ||
                  aria.includes('react') ||
                  aria.includes('ప్రతిస్పందించు') ||
                  aria.includes('me gusta') ||
                  aria.includes('j’aime')
                ) {
                  likes = getButtonText(b);
                }
                if (
                  aria.includes('comment') ||
                  aria.includes('కామెంట్') ||
                  aria.includes('comentario') ||
                  aria.includes('commentaire')
                ) {
                  comments = getButtonText(b);
                }
              }

              return { likes, comments, shares };
            });
          },
        });

        if (pwMetrics.customData?.shares) {
          const parsedShares = parseFormattedNumber(pwMetrics.customData.shares);
          if (parsedShares > 0) {
            metrics = { ...(metrics || { likes: 0, comments: 0, shares: 0 }), shares: parsedShares };
          }
        }
        if (pwMetrics.customData?.likes) {
          const parsedLikes = parseFormattedNumber(pwMetrics.customData.likes);
          if (parsedLikes > 0 && (!metrics || !metrics.likes)) {
            metrics = { ...(metrics || { likes: 0, comments: 0, shares: 0 }), likes: parsedLikes };
          }
        }
        if (pwMetrics.customData?.comments) {
          const parsedComments = parseFormattedNumber(pwMetrics.customData.comments);
          if (parsedComments > 0 && (!metrics || !metrics.comments)) {
            metrics = { ...(metrics || { likes: 0, comments: 0, shares: 0 }), comments: parsedComments };
          }
        }
      } catch {}
    }

    // Resolve Author Name (never fall back to view count or generic "Facebook Creator")
    if (!authorName) {
      authorName = parseFacebookAuthor(rawTitle, targetUrl, finalUrl, rawHtml);
    }

    let media: MediaItem[] = [];
    let snapshot: string | null = null;

    if (isVideo && videoUrl) {
      let directSnapshot = candidateImage;
      if (candidateImage) {
        directSnapshot = await resolveDirectFacebookCdnImage(candidateImage);
      }
      snapshot = directSnapshot;
      media = [
        {
          type: 'video',
          url: videoUrl.replace(/&amp;/g, '&'),
        },
      ];
    } else {
      // Assemble clean raw candidate images
      const rawCandidateImages: string[] = [];
      if (candidateImage && isFacebookPostImage(candidateImage)) {
        rawCandidateImages.push(candidateImage);
      }

      discoveredImages.forEach((imgUrl) => {
        if (!rawCandidateImages.includes(imgUrl)) {
          rawCandidateImages.push(imgUrl);
        }
      });

      // Deduplicate by media ID and bound parallel requests to top 6 images
      const seenMediaIds = new Set<string>();
      const candidateImagesToResolve = rawCandidateImages.filter((u) => {
        const m = u.match(/media_id=(\d+)/i) || u.match(/fbid=(\d+)/i);
        if (m && m[1]) {
          if (seenMediaIds.has(m[1])) return false;
          seenMediaIds.add(m[1]);
        }
        return true;
      }).slice(0, 6);

      // Resolve direct scontent.*.fbcdn.net image links in parallel
      const directImages = await Promise.all(
        candidateImagesToResolve.map((u) => resolveDirectFacebookCdnImage(u))
      );

      // If direct scontent/fbcdn CDN images were resolved, strip any unresolved lookaside crawler URLs
      const hasDirectCdn = directImages.some((u) => u.includes('scontent') || u.includes('fbcdn.net'));
      const finalImages = (hasDirectCdn
        ? directImages.filter((u) => !u.includes('lookaside.fbsbx.com'))
        : directImages
      ).filter(isFacebookPostImage);

      media = finalImages.map((url) => ({
        type: 'image',
        url,
      }));

      snapshot = media[0]?.url || null;
    }

    // Resolve actual author profile picture (fallback to UI-Avatar if silhouette or not found)
    authorAvatar = await resolveFacebookAuthorAvatar(rawHtml, authorName, targetUrl, finalUrl);

    // Untruncate full description from GraphQL script payloads if available
    const fullDesc = extractFacebookFullDescription(rawHtml, rawDesc);
    if (fullDesc && fullDesc.length > (rawDesc?.length || 0)) {
      rawDesc = fullDesc;
    }

    const finalDescription = rawDesc ? cleanDescription(rawDesc) || '' : '';
    const hasVideo = media.some((m) => m.type === 'video');
    const videoThumbnail = hasVideo ? (snapshot || candidateImage || null) : null;

    return {
      title: null, // Title is null for Facebook (no post titles, only author & description)
      description: finalDescription,
      logo: FACEBOOK_LOGO_URL,
      ogSiteName: 'Facebook',
      card_data: {
        author: {
          name: authorName,
          avatar_url: authorAvatar,
        },
        metrics: sanitizeMetrics(metrics),
        media,
        posted_at: publishedAt || new Date().toISOString(),
        video_thumbnail: videoThumbnail,
      },
    };
  },
};
