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
  const redditMatch = preCleaned.match(
    /(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s]+)\/comments\/([a-zA-Z0-9]+)/i
  );
  if (redditMatch) {
    const subreddit = redditMatch[1].toLowerCase();
    const postId = redditMatch[2];
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

  // 6. General Web Sites
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

  const redA = trimmedA.match(/reddit\.com\/r\/[^/\s]+\/comments\/([a-zA-Z0-9]+)/i)?.[1] || trimmedA.match(/redd\.it\/([a-zA-Z0-9]+)/i)?.[1];
  const redB = trimmedB.match(/reddit\.com\/r\/[^/\s]+\/comments\/([a-zA-Z0-9]+)/i)?.[1] || trimmedB.match(/redd\.it\/([a-zA-Z0-9]+)/i)?.[1];
  if (redA && redB && redA === redB) return true;

  const pinA = trimmedA.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i)?.[1] || trimmedA.match(/pin\.it\/([a-zA-Z0-9]+)/i)?.[1];
  const pinB = trimmedB.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i)?.[1] || trimmedB.match(/pin\.it\/([a-zA-Z0-9]+)/i)?.[1];
  if (pinA && pinB && pinA === pinB) return true;

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
