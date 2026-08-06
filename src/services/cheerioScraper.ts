import axios from 'axios';
import * as cheerio from 'cheerio';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';

export interface CheerioExtractionResult {
  title: string | null;
  description: string | null;
  image: string | null;
  logo: string | null;
  ogSiteName: string | null;
}

interface JsonLdData {
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

/**
 * Extracts titles, descriptions, and images from embedded JSON-LD scripts (<script type="application/ld+json">).
 */
function extractJsonLd($: cheerio.CheerioAPI): JsonLdData {
  let title: string | null = null;
  let description: string | null = null;
  let image: string | null = null;

  const scripts = $('script[type="application/ld+json"]');
  scripts.each((_, el) => {
    try {
      const rawText = $(el).html() || $(el).text();
      if (!rawText) return;
      const json = JSON.parse(rawText);

      // Normalize structures: single object, array of objects, or @graph node array
      const items: any[] = [];
      if (Array.isArray(json)) {
        items.push(...json);
      } else if (json && typeof json === 'object') {
        if (Array.isArray(json['@graph'])) {
          items.push(...json['@graph']);
        }
        items.push(json);
      }

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        // Extract title (headline or name)
        if (!title) {
          const rawTitle = item.headline || item.name;
          if (typeof rawTitle === 'string' && rawTitle.trim()) {
            title = rawTitle.trim();
          }
        }

        // Extract description
        if (!description) {
          const rawDesc = item.description;
          if (typeof rawDesc === 'string' && rawDesc.trim()) {
            description = rawDesc.trim();
          }
        }

        // Extract image (can be string, object with url property, or array)
        if (!image) {
          const rawImg = item.image;
          if (typeof rawImg === 'string' && rawImg.trim()) {
            image = rawImg.trim();
          } else if (Array.isArray(rawImg) && rawImg.length > 0) {
            const first = rawImg[0];
            if (typeof first === 'string' && first.trim()) {
              image = first.trim();
            } else if (first && typeof first === 'object' && typeof first.url === 'string' && first.url.trim()) {
              image = first.url.trim();
            }
          } else if (rawImg && typeof rawImg === 'object' && typeof rawImg.url === 'string' && rawImg.url.trim()) {
            image = rawImg.url.trim();
          }
        }
      }
    } catch {
      // Ignore JSON parse failures in script tags
    }
  });

  return { title, description, image };
}

/**
 * Fast-path scraper using Axios & Cheerio.
 * Timeout: 4000ms.
 */
export async function scrapeWithCheerio(targetUrl: string): Promise<CheerioExtractionResult | null> {
  try {
    const lowerUrl = targetUrl.toLowerCase();
    const isTwitterOrX = lowerUrl.includes('x.com') || lowerUrl.includes('twitter.com');
    const userAgent = isTwitterOrX
      ? 'Twitterbot/1.0 (https://dev.twitter.com/cards/overview)'
      : 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

    const response = await axios.get(targetUrl, {
      timeout: 4000,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const html = response.data;
    if (typeof html !== 'string') {
      return null;
    }

    const $ = cheerio.load(html);

    // Extract JSON-LD metadata
    const jsonLd = extractJsonLd($);

    // Title resolution: og:title -> twitter:title -> jsonLd.title -> htmlTitle
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const twitterTitle = $('meta[name="twitter:title"]').attr('content') || $('meta[property="twitter:title"]').attr('content');
    const htmlTitle = $('title').first().text();
    const rawTitle = (ogTitle || twitterTitle || jsonLd.title || htmlTitle || '').trim() || null;
    const title = cleanTitle(rawTitle);

    // Description resolution: og:description -> twitter:description -> jsonLd.description -> meta:description
    const ogDesc = $('meta[property="og:description"]').attr('content');
    const twitterDesc = $('meta[name="twitter:description"]').attr('content') || $('meta[property="twitter:description"]').attr('content');
    const metaDesc = $('meta[name="description"]').attr('content');
    const rawDesc = (ogDesc || twitterDesc || jsonLd.description || metaDesc || '').trim() || null;
    const description = cleanDescription(rawDesc);

    // Direct Image resolution: og:image -> twitter:image -> jsonLd.image
    const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[property="og:image:secure_url"]').attr('content');
    const twitterImage = $('meta[name="twitter:image"]').attr('content') || $('meta[property="twitter:image"]').attr('content');
    const rawImage = (ogImage || twitterImage || jsonLd.image || '').trim() || null;
    let image = resolveUrl(rawImage, targetUrl);

    // Reddit shreddit-post content-href attribute extraction
    if (lowerUrl.includes('reddit.com')) {
      const shredditContentHref =
        $('shreddit-post').attr('content-href') ||
        $('article[content-href]').attr('content-href') ||
        $('[content-href]').first().attr('content-href');
      if (shredditContentHref) {
        const resolvedHref = resolveUrl(shredditContentHref, targetUrl);
        if (resolvedHref) {
          image = resolvedHref;
        }
      }
    }

    // Reddit Logo Filtering: Discard generic Reddit logo URLs to trigger Playwright container screenshot fallback
    if (image && lowerUrl.includes('reddit.com')) {
      const lowerImage = image.toLowerCase();
      const logoSignatures = ['redditstatic.com', 'snoo', 'icon', 'avatar'];
      if (logoSignatures.some((sig) => lowerImage.includes(sig))) {
        image = null;
      }
    }

    // Logo / Favicon resolution
    const appleIcon = $('link[rel~="apple-touch-icon"]').attr('href');
    const icon = $('link[rel~="icon"]').attr('href');
    const shortcutIcon = $('link[rel~="shortcut icon"]').attr('href');
    const rawLogo = appleIcon || icon || shortcutIcon;
    const logo = resolveUrl(rawLogo, targetUrl) || resolveUrl('/favicon.ico', targetUrl);

    // og:site_name
    const ogSiteName = $('meta[property="og:site_name"]').attr('content') || null;

    return {
      title,
      description,
      image,
      logo,
      ogSiteName,
    };
  } catch (error) {
    // Return null if request times out or returns error status
    return null;
  }
}
