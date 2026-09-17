import axios from 'axios';

/**
 * URL normalization, resolution, and canonicalization utilities.
 */

// Tracking, analytics, and social share tracking parameters that should be stripped
const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'stkn',        // Instagram share token
  'igsh',        // Instagram share hash
  'igshid',      // Instagram share id
  'fbclid',      // Facebook click id
  'gclid',       // Google click id
  'gbraid',      // Google app tracking
  'wbraid',
  'msclkid',     // Microsoft click id
  'yclid',       // Yandex click id
  'mc_cid',      // Mailchimp campaign id
  'mc_eid',      // Mailchimp email id
  'ref',         // Generic referrer
  'ref_src',     // Twitter ref source
  'ref_url',     // Twitter ref url
  's',           // Twitter share parameter (e.g. ?s=20)
  'si',          // YouTube share identifier
  'feature',     // YouTube feature parameter
  'pp',          // YouTube playlist param
  'mibextid',    // Facebook mobile tracking
  'share_id',    // Reddit share ID
  'rdt_cid',     // Reddit tracking
  '_ga',         // Google Analytics
  '_gl',
  '_hsenc',      // HubSpot
  '_hsmi',
  'rcm',         // LinkedIn referral/tracking
  'trk',         // LinkedIn tracking
  'trackingId',  // LinkedIn tracking ID
  'refId',       // LinkedIn ref ID
  'midToken',    // LinkedIn token
  'midSig',      // LinkedIn signature
  'trkInfo',     // LinkedIn tracking info
  'originalSubdomain', // LinkedIn subdomain tracking
  'original_referer',  // LinkedIn referer
  'lipi',        // LinkedIn page instance
  'licu',        // LinkedIn custom tracking
]);

/**
 * Pre-cleans raw user input: strips platform labels (e.g. 'x: ', 'insta: '),
 * removes markdown brackets, and isolates the URL candidate.
 */
function cleanRawUrlInput(rawInput: string): string {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let str = rawInput.trim();

  // Strip markdown links like [title](https://...) or <https://...>
  str = str.replace(/^<([^>]+)>$/, '$1');
  const mdMatch = str.match(/\[.*?\]\((https?:\/\/[^\s)]+)\)/i);
  if (mdMatch) {
    str = mdMatch[1];
  }

  // Strip leading platform labels like "x: ", "insta: ", "instagram: ", etc.
  str = str.replace(
    /^(?:x|twitter|insta|instagram|facebook|fb|reddit|youtube|yt|github|web|link):\s*/i,
    ''
  );

  return str.trim();
}

/**
 * Detects if a URL is a known shortlink/sharelink that redirects to a canonical destination.
 */
export function isResolvableShortlink(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  return (
    /reddit\.com\/(?:r\/[^/\s]+\/)?s\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /redd\.it\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /pin\.it\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /t\.co\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /bit\.ly\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /tinyurl\.com\/[a-zA-Z0-9_-]+/i.test(lower) ||
    /(?:lnkd\.in|linkd\.in)\/[a-zA-Z0-9_\/-]+/i.test(lower)
  );
}

/**
 * Resolves redirect shortlinks (e.g. reddit.com/r/sub/s/xyz, pin.it/xyz) to their final destination URL.
 */
export async function resolveShortlink(url: string, timeoutMs: number = 3000): Promise<string> {
  if (!isResolvableShortlink(url)) {
    return url;
  }
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (status) => status < 400,
    });
    const finalUrl = res.request?.res?.responseUrl || res.request?.responseURL;
    if (finalUrl && typeof finalUrl === 'string' && finalUrl.startsWith('http')) {
      return finalUrl;
    }
  } catch {
    try {
      const manualRes = await axios.get(url, {
        maxRedirects: 0,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        validateStatus: (status) => status >= 300 && status < 400,
      });
      const loc = manualRes.headers?.location;
      if (loc) {
        return loc.startsWith('http') ? loc : new URL(loc, url).toString();
      }
    } catch {}
  }
  return url;
}

/**
 * Produces a deterministic canonical URL for social media and general web links.
 * Strips tracking query parameters, normalizes path aliases (e.g. Instagram /reels/ vs /reel/),
 * and unifies hostnames so identical content shares the exact same cache key.
 */
export function canonicalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  const preCleaned = cleanRawUrlInput(rawUrl);
  if (!preCleaned) return '';

  // 1. Twitter / X Canonicalization
  // Matches: x.com/user/status/123, twitter.com/user/status/123 with optional trailing text or paths
  const tweetMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:#!\/)?([a-zA-Z0-9_]+)\/status\/(\d+)/i
  );
  if (tweetMatch) {
    const handle = tweetMatch[1].toLowerCase();
    const statusId = tweetMatch[2];
    return `https://x.com/${handle}/status/${statusId}`;
  }

  // 2. Instagram Canonicalization
  // Matches: instagram.com/p/ID, instagram.com/reel/ID, instagram.com/reels/ID, instagram.com/tv/ID
  const igMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i
  );
  if (igMatch) {
    const shortcode = igMatch[1];
    return `https://www.instagram.com/reel/${shortcode}/`;
  }

  // 3. YouTube Canonicalization
  // Matches: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID
  const ytMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i
  );
  if (ytMatch) {
    const videoId = ytMatch[1];
    const tMatch = preCleaned.match(/[?&]t=([0-9a-zA-Z]+)/i);
    return tMatch
      ? `https://www.youtube.com/watch?v=${videoId}&t=${tMatch[1]}`
      : `https://www.youtube.com/watch?v=${videoId}`;
  }

  // 4. Reddit Canonicalization
  // 4a. Check for Comment URL first (so /comment/ID is not lost)
  const redditCommentMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s]+)\/comments\/([a-zA-Z0-9]+)(?:\/[^/\s]+)?\/comment\/([a-zA-Z0-9]+)/i
  );
  if (redditCommentMatch) {
    const subreddit = redditCommentMatch[1].toLowerCase();
    const postId = redditCommentMatch[2];
    const commentId = redditCommentMatch[3];
    return `https://www.reddit.com/r/${subreddit}/comments/${postId}/comment/${commentId}/`;
  }

  // 4b. Check for Old-style Comment URL: /r/sub/comments/POST_ID/slug/COMMENT_ID/ (comment ID is >= 6 chars alphanumeric)
  const oldCommentMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s]+)\/comments\/([a-zA-Z0-9]+)\/[^/\s]+\/([a-zA-Z0-9]{6,})(?:\/|$|\?)/i
  );
  if (oldCommentMatch && !['comment', 'comments', 'live', 'photos', 'video'].includes(oldCommentMatch[3].toLowerCase())) {
    const subreddit = oldCommentMatch[1].toLowerCase();
    const postId = oldCommentMatch[2];
    const commentId = oldCommentMatch[3];
    return `https://www.reddit.com/r/${subreddit}/comments/${postId}/comment/${commentId}/`;
  }

  // 4c. Check for Standard Post URL
  const redditPostMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s]+)\/comments\/([a-zA-Z0-9]+)/i
  );
  if (redditPostMatch) {
    const subreddit = redditPostMatch[1].toLowerCase();
    const postId = redditPostMatch[2];
    return `https://www.reddit.com/r/${subreddit}/comments/${postId}/`;
  }
  const redditShortMatch = preCleaned.match(/(?:https?:\/\/)?redd\.it\/([a-zA-Z0-9]+)/i);
  if (redditShortMatch) {
    return `https://redd.it/${redditShortMatch[1]}`;
  }

  // 5. Pinterest Canonicalization
  const pinMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:pinterest\.[a-z.]+|pin\.it)\/pin\/(\d+)/i
  );
  if (pinMatch) {
    const pinId = pinMatch[1];
    return `https://www.pinterest.com/pin/${pinId}/`;
  }
  const pinShortMatch = preCleaned.match(/(?:https?:\/\/)?pin\.it\/([a-zA-Z0-9]+)/i);
  if (pinShortMatch) {
    return `https://pin.it/${pinShortMatch[1]}`;
  }

  // 6. LinkedIn Canonicalization
  // Matches: linkedin.com/posts/..., linkedin.com/feed/update/..., linkedin.com/pulse/...
  const linkedInMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.|mobile\.)?linkedin\.com\/(posts\/[a-zA-Z0-9_.\-%]+|feed\/update\/urn:li:[a-zA-Z0-9_:]+|pulse\/[a-zA-Z0-9_.\-%]+)/i
  );
  if (linkedInMatch) {
    let cleanPath = linkedInMatch[1];
    if (cleanPath.endsWith('/')) {
      cleanPath = cleanPath.slice(0, -1);
    }
    return `https://www.linkedin.com/${cleanPath}`;
  }

  // 7. General Web Sites
  let formatted = preCleaned;
  const spaceIdx = formatted.search(/\s/);
  if (spaceIdx > 0) {
    formatted = formatted.slice(0, spaceIdx);
  }

  if (!/^https?:\/\//i.test(formatted)) {
    formatted = `https://${formatted}`;
  }

  try {
    const urlObj = new URL(formatted);
    let hostname = urlObj.hostname.toLowerCase();
    let pathname = urlObj.pathname;

    // Standardize protocol
    urlObj.protocol = 'https:';

    // Remove standard ports
    if (urlObj.port === '443' || urlObj.port === '80') {
      urlObj.port = '';
    }

    // Strip hash fragment
    urlObj.hash = '';

    if (hostname.includes('facebook.com')) {
      urlObj.hostname = 'www.facebook.com';
      for (const param of Array.from(urlObj.searchParams.keys())) {
        if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
          urlObj.searchParams.delete(param);
        }
      }
    } else {
      if (hostname.startsWith('www.')) {
        urlObj.hostname = hostname.slice(4);
      }
      for (const param of Array.from(urlObj.searchParams.keys())) {
        if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
          urlObj.searchParams.delete(param);
        }
      }
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
    }

    urlObj.pathname = pathname;
    urlObj.searchParams.sort();

    return urlObj.toString();
  } catch {
    return preCleaned;
  }
}

/**
 * Extracts numeric activity or share ID from a LinkedIn URL if present.
 */
export function extractLinkedInPostId(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/(?:activity[-:]|share[-:]|posts\/[a-zA-Z0-9_.\-%]*?-)(\d{18,20})/i);
  if (match) return match[1];
  const genericMatch = url.match(/linkedin\.com\/.*?(?:activity|share|posts).*?(\d{18,20})/i);
  return genericMatch ? genericMatch[1] : null;
}

/**
 * Checks if two URLs represent the exact same piece of content by comparing
 * their canonical strings as well as platform entity identifiers.
 */
export function isSameBookmarkUrl(urlA?: string | null, urlB?: string | null): boolean {
  if (!urlA || !urlB) return false;
  const trimmedA = urlA.trim();
  const trimmedB = urlB.trim();
  if (trimmedA === trimmedB) return true;

  const canonicalA = canonicalizeUrl(trimmedA);
  const canonicalB = canonicalizeUrl(trimmedB);
  if (canonicalA && canonicalB && canonicalA === canonicalB) return true;

  const tweetIdA = trimmedA.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?[a-zA-Z0-9_]+\/status\/(\d+)/i)?.[1];
  const tweetIdB = trimmedB.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?[a-zA-Z0-9_]+\/status\/(\d+)/i)?.[1];
  if (tweetIdA && tweetIdB && tweetIdA === tweetIdB) return true;

  const igCodeA = trimmedA.match(/instagram\.com\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i)?.[1];
  const igCodeB = trimmedB.match(/instagram\.com\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i)?.[1];
  if (igCodeA && igCodeB && igCodeA === igCodeB) return true;

  const ytA = trimmedA.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i)?.[1];
  const ytB = trimmedB.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i)?.[1];
  if (ytA && ytB && ytA === ytB) return true;

  // Reddit comparison: distinguish between post-level links and specific comment links
  const redA = trimmedA.match(/reddit\.com\/r\/[^/\s]+\/comments\/([a-zA-Z0-9]+)/i)?.[1] || trimmedA.match(/redd\.it\/([a-zA-Z0-9]+)/i)?.[1];
  const redB = trimmedB.match(/reddit\.com\/r\/[^/\s]+\/comments\/([a-zA-Z0-9]+)/i)?.[1] || trimmedB.match(/redd\.it\/([a-zA-Z0-9]+)/i)?.[1];
  if (redA && redB && redA === redB) {
    const commentA = trimmedA.match(/\/comment\/([a-zA-Z0-9]+)/i)?.[1] || trimmedA.match(/comments\/[a-zA-Z0-9]+\/[^/\s]+\/([a-zA-Z0-9]{6,})/i)?.[1];
    const commentB = trimmedB.match(/\/comment\/([a-zA-Z0-9]+)/i)?.[1] || trimmedB.match(/comments\/[a-zA-Z0-9]+\/[^/\s]+\/([a-zA-Z0-9]{6,})/i)?.[1];
    if (!commentA && !commentB) return true;
    if (commentA && commentB && commentA === commentB) return true;
    return false;
  }

  const pinA = trimmedA.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i)?.[1] || trimmedA.match(/pin\.it\/([a-zA-Z0-9]+)/i)?.[1];
  const pinB = trimmedB.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i)?.[1] || trimmedB.match(/pin\.it\/([a-zA-Z0-9]+)/i)?.[1];
  if (pinA && pinB && pinA === pinB) return true;

  const linkedInIdA = extractLinkedInPostId(trimmedA);
  const linkedInIdB = extractLinkedInPostId(trimmedB);
  if (linkedInIdA && linkedInIdB && linkedInIdA === linkedInIdB) return true;

  return false;
}

/**
 * Normalizes a raw input URL by canonicalizing format, adding scheme if missing, and validating.
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  const canonical = canonicalizeUrl(rawUrl);
  if (!canonical) {
    throw new Error(`Invalid URL format: ${rawUrl}`);
  }
  return canonical;
}

/**
 * Resolves relative URLs (e.g. /favicon.ico) against a base URL.
 */
export function resolveUrl(relativeOrAbsolute: string | null | undefined, baseUrl: string): string | null {
  if (!relativeOrAbsolute) return null;
  const trimmed = relativeOrAbsolute.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}
