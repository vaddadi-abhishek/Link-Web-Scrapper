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
 * Produces a deterministic canonical URL for social media and general web links.
 * Strips tracking query parameters, normalizes path aliases (e.g. Instagram /reels/ vs /reel/),
 * and unifies hostnames so identical content shares the exact same cache key.
 */
export function canonicalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  let trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  try {
    const urlObj = new URL(trimmed);
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

    // 1. Instagram Canonicalization
    if (hostname.includes('instagram.com')) {
      urlObj.hostname = 'www.instagram.com';

      // Normalize /reels/<id> to /reel/<id>
      pathname = pathname.replace(/\/reels\//i, '/reel/');

      // Posts, reels, and IGTV have distinct shortcodes that do not require query parameters
      const igMatch = pathname.match(/\/(reel|p|tv)\/([a-zA-Z0-9_-]+)/i);
      if (igMatch) {
        const type = igMatch[1].toLowerCase();
        const shortcode = igMatch[2];
        pathname = `/${type}/${shortcode}/`;
        urlObj.search = '';
      } else {
        // Strip tracking params for profiles or other IG paths
        for (const param of Array.from(urlObj.searchParams.keys())) {
          if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
            urlObj.searchParams.delete(param);
          }
        }
      }
    }
    // 2. Twitter / X Canonicalization
    else if (hostname.includes('twitter.com') || hostname === 'x.com') {
      urlObj.hostname = 'x.com';

      const tweetMatch = pathname.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/i);
      if (tweetMatch) {
        pathname = `/${tweetMatch[1]}/status/${tweetMatch[2]}`;
        urlObj.search = '';
      } else {
        for (const param of Array.from(urlObj.searchParams.keys())) {
          if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
            urlObj.searchParams.delete(param);
          }
        }
        pathname = pathname.replace(/\/+$/, '');
      }
    }
    // 3. YouTube Canonicalization
    else if (hostname.includes('youtube.com') || hostname === 'youtu.be') {
      urlObj.hostname = 'www.youtube.com';

      let videoId: string | null = null;
      if (hostname === 'youtu.be') {
        videoId = pathname.replace(/^\//, '').split('/')[0] || null;
      } else if (pathname.startsWith('/shorts/')) {
        videoId = pathname.replace('/shorts/', '').split('/')[0] || null;
      } else if (pathname === '/watch') {
        videoId = urlObj.searchParams.get('v');
      }

      if (videoId) {
        pathname = '/watch';
        const t = urlObj.searchParams.get('t');
        urlObj.search = '';
        urlObj.searchParams.set('v', videoId);
        if (t) urlObj.searchParams.set('t', t);
      } else {
        for (const param of Array.from(urlObj.searchParams.keys())) {
          if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
            urlObj.searchParams.delete(param);
          }
        }
      }
    }
    // 4. Reddit Canonicalization
    else if (hostname.includes('reddit.com')) {
      urlObj.hostname = 'www.reddit.com';
      const redditPostMatch = pathname.match(/^(\/r\/[^\/]+\/comments\/[a-zA-Z0-9]+)/i);
      if (redditPostMatch) {
        pathname = `${redditPostMatch[1]}/`;
        urlObj.search = '';
      } else {
        for (const param of Array.from(urlObj.searchParams.keys())) {
          if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
            urlObj.searchParams.delete(param);
          }
        }
      }
    }
    // 5. Facebook Canonicalization
    else if (hostname.includes('facebook.com')) {
      urlObj.hostname = 'www.facebook.com';
      for (const param of Array.from(urlObj.searchParams.keys())) {
        if (TRACKING_QUERY_PARAMS.has(param.toLowerCase())) {
          urlObj.searchParams.delete(param);
        }
      }
    }
    // 6. General Web Sites
    else {
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
    return trimmed;
  }
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
