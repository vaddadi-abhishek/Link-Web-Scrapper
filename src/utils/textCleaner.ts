/**
 * Utility for sanitizing and cleaning extracted titles and descriptions.
 */

// Comprehensive HTML Entity Unescaping
export function unescapeHtml(text: string): string {
  if (!text) return '';
  if (!text.includes('&') && !text.includes('\\')) return text;
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        const code = parseInt(h, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    })
    .replace(/&#([0-9]+);/g, (_, d) => {
      try {
        const code = parseInt(d, 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\+([^a-zA-Z0-9\s])/g, '$1');
}

// Remove social engagement metrics header from descriptions (Instagram, Facebook, LinkedIn, Twitter)
// e.g. "654K likes, 4,503 comments - srividyakotnala on July 14, 2025: \"This song...\""
export function stripEngagementHeader(text: string): string {
  if (!text) return '';

  let cleaned = text.trim();

  // Pattern 1: Instagram style engagement metrics prefix
  // "654K likes, 4,503 comments - srividyakotnala on July 14, 2025: "
  cleaned = cleaned.replace(
    /^(?:[\d,.\sKMB]+(?:likes|comments|followers|views|posts|reposts|retweets)[^:]*:\s*"?)/i,
    ''
  );

  // Pattern 2: "username on Platform (Date): " or "username on Date: "
  cleaned = cleaned.replace(/^[a-zA-Z0-9._-]+\s+on\s+[a-zA-Z0-9\s,.:]+:\s*"?/i, '');

  return cleaned.trim();
}

// Remove Instagram / X / Platform Title prefix
// e.g. "Srividya Kotnala on Instagram: \"This song...\""
// e.g. "User (@handle) on X: \"...\""
export function stripPlatformTitlePrefix(title: string): string {
  if (!title) return '';

  let cleaned = title.trim();

  // "Author on Platform: " or "Author (@handle) on Platform: "
  cleaned = cleaned.replace(/^[^:]+\s+on\s+(?:Instagram|Twitter|X|Facebook|Reddit|LinkedIn|Pinterest):\s*"?/i, '');

  // Trailing platform site names: " | Instagram", " - YouTube", " • Instagram photos and videos"
  cleaned = cleaned.replace(/\s*[|•-]\s*(?:Instagram(?:\s+photos\s+and\s+videos)?|Twitter|X|Facebook|YouTube|Reddit|LinkedIn)\s*$/i, '');

  return cleaned.trim();
}

// Clean dot line spam used for formatting breaks (e.g. "\n.\n.\n" or " . . . ")
export function removeDotSpam(text: string): string {
  if (!text) return '';

  // Replace lines that contain only a dot, dash, or bullet
  let cleaned = text.replace(/(?:\r?\n\s*[\.\•\-]\s*)+/g, '\n');

  // Replace inline dot spam like " . . . " or " . . "
  cleaned = cleaned.replace(/(?:\s*\.\s*){3,}/g, ' ');

  return cleaned.trim();
}

// Strip outer quotes if enclosed ("title" -> title)
export function stripOuterQuotes(text: string): string {
  if (!text) return '';

  let cleaned = text.trim();

  // Strip leading/trailing quote marks if they wrap the entire string
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('“') && cleaned.endsWith('”')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Remove dangling trailing quote artifacts like '".' or '"' at the end of a string
  cleaned = cleaned.replace(/["”]\.?$/, '').trim();
  cleaned = cleaned.replace(/^["“]/, '').trim();

  return cleaned;
}

/**
 * Cleans extracted title string into an unescaped title, preserving line breaks.
 */
export function cleanTitle(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) return null;

  let title = unescapeHtml(rawTitle);
  title = stripPlatformTitlePrefix(title);
  title = stripOuterQuotes(title);
  title = removeDotSpam(title);

  return title.trim() || null;
}

/**
 * Normalizes multi-line text by trimming lines, removing trailing "Read more" UI artifacts,
 * and collapsing consecutive blank lines into double newlines.
 */
export function normalizeParagraphs(text: string): string {
  if (!text) return '';

  return text
    .replace(/\r\n/g, '\n')
    // Remove trailing expansion UI buttons like "Read more", "Show more", "Show less", "See more", "...more"
    .replace(/\s*(?:\.\.\.\s*)?(?:Read\s*more|Show\s*more|Show\s*less|See\s*more)\s*\.?\s*$/i, '')
    // Split into lines, trim each line's leading/trailing spaces
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    // Collapse 3 or more consecutive newlines into a standard double newline (paragraph break)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cleans extracted description string into clean text, preserving line breaks.
 */
export function cleanDescription(rawDescription: string | null | undefined): string | null {
  if (!rawDescription) return null;

  let desc = unescapeHtml(rawDescription);
  desc = stripEngagementHeader(desc);
  desc = stripOuterQuotes(desc);
  desc = removeDotSpam(desc);
  desc = normalizeParagraphs(desc);

  return desc.trim() || null;
}

/**
 * Detects if extracted title, description, or HTML content is an Access Denied / WAF / Cloudflare block or bot challenge page.
 */
export function isAccessDeniedOrChallenge(
  title?: string | null,
  description?: string | null,
  htmlOrBody?: string | null
): boolean {
  const cleanT = (title || '').trim().toLowerCase();
  const cleanD = (description || '').trim().toLowerCase();
  const cleanH = (htmlOrBody || '').substring(0, 3000).toLowerCase();

  const exactBlockedTitles = [
    'access denied',
    'access to this page has been denied',
    '403 forbidden',
    '403 - forbidden',
    'forbidden',
    'just a moment...',
    'attention required! | cloudflare',
    'security check',
    'robot or human?',
    'bot verification',
    'please verify you are a human',
    'are you a human?',
    'human verification',
    'blocked',
    'request rejected',
    'ddos-guard',
  ];

  if (exactBlockedTitles.includes(cleanT)) {
    return true;
  }

  const combined = `${cleanT} ${cleanD} ${cleanH}`;
  if (
    /reference\s*#[0-9a-f.]+/i.test(combined) ||
    combined.includes('errors.edgesuite.net') ||
    combined.includes("you don't have permission to access") ||
    combined.includes('access to this page has been denied') ||
    combined.includes('our systems have detected unusual traffic') ||
    combined.includes('cf-browser-verification') ||
    combined.includes('cloudflare ray id') ||
    combined.includes('incapsula incident id')
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether an Instagram HTML response or redirection target is a login wall,
 * auth challenge, or empty JavaScript shell without OpenGraph metadata.
 */
export function isInstagramBlockedOrAuthWall(html: string | null | undefined, responseUrl?: string | null): boolean {
  if (!html && !responseUrl) return true;
  if (responseUrl) {
    const cleanUrl = responseUrl.toLowerCase();
    if (cleanUrl.includes('/accounts/login') || cleanUrl.includes('/accounts/onetap') || cleanUrl.includes('/challenge/')) {
      return true;
    }
  }
  if (!html) return true;

  // Real Instagram profiles and posts contain og:description (followers/posts/caption) or og:title
  const hasOgDesc = html.includes('property="og:description"');
  const hasOgTitle = html.includes('property="og:title"');
  const hasOgImg = html.includes('property="og:image"');

  if (hasOgDesc) {
    return false; // Valid post or profile page with metadata
  }

  if (hasOgTitle) {
    // If og:title is just "Instagram" with no og:description and static generic assets, it's the landing/login page
    const isGenericLanding = html.includes('content="Instagram"') && (html.includes('static.cdninstagram.com/rsrc.php') || !html.includes('cdninstagram.com'));
    if (isGenericLanding && !hasOgImg) {
      return true;
    }
    return false;
  }

  // Fallback checks for explicit login page titles
  const sample = html.substring(0, 30000).toLowerCase();
  if (sample.includes('<title>login • instagram</title>') || sample.includes('<title>log in • instagram</title>')) {
    return true;
  }

  // Instagram client-side empty shell without any OpenGraph metadata
  if (!hasOgDesc && !hasOgTitle && !hasOgImg) {
    return true;
  }

  return false;
}

/**
 * Checks whether an extracted result is degraded (e.g. login wall placeholder,
 * missing author details, empty media on profiles) to prevent cache pollution.
 */
export function isDegradedExtractionResult(platform: string | null | undefined, result: any): boolean {
  if (!result) return true;
  const p = (platform || '').toLowerCase();
  const cardData = result.card_data || (result.result && result.result.card_data);
  const title = (result.title || '').trim().toLowerCase();
  const description = (result.description || '').trim();

  if (p === 'instagram') {
    if (cardData) {
      const authorName = (cardData.author?.name || '').trim();
      const hasMedia = Array.isArray(cardData.media) && cardData.media.length > 0;
      // Degraded if author name is generic placeholder with no bio or media
      if (authorName === 'Instagram User' && !description && !hasMedia) {
        return true;
      }
      // Degraded if is_profile but media has no post images or contains only the avatar
      if (cardData.is_profile) {
        if (!hasMedia) {
          return true;
        }
        if (cardData.media.length <= 1) {
          const firstUrl = cardData.media[0]?.url || '';
          const avatarUrl = cardData.author?.avatar_url || '';
          if (
            !firstUrl ||
            firstUrl === avatarUrl ||
            firstUrl.includes('t51.82787-19') ||
            firstUrl.includes('s100x100') ||
            firstUrl.includes('s150x150') ||
            firstUrl.includes('profile_pic')
          ) {
            return true;
          }
        }
      }
    }
    // Generic empty titles on Instagram without description
    if ((title === 'instagram' || title === 'instagram post' || !title) && !description) {
      return true;
    }
  }

  if (p === 'twitter') {
    if (cardData && (!result.title && !result.description)) {
      return true;
    }
  }

  return false;
}



