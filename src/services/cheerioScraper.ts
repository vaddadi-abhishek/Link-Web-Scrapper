import axios from 'axios';
import * as cheerio from 'cheerio';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';

export interface CheerioExtractionResult {
  title: string | null;
  rawTitle: string | null;
  twitterTitle: string | null;
  description: string | null;
  rawDescription: string | null;
  image: string | null;
  logo: string | null;
  ogSiteName: string | null;
  author: string | null;
  authorAvatar: string | null;
  publishedAt: string | null;
  type: string | null;
  likes: number | string | null;
  comments: number | string | null;
  shares: number | string | null;
  views: number | string | null;
}

interface JsonLdData {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  author?: string | null;
  authorAvatar?: string | null;
  publishedAt?: string | null;
  type?: string | null;
}

/**
 * Extracts titles, descriptions, and images from embedded JSON-LD scripts (<script type="application/ld+json">).
 */
function extractJsonLd($: cheerio.CheerioAPI): JsonLdData {
  let title: string | null = null;
  let description: string | null = null;
  let image: string | null = null;
  let author: string | null = null;
  let authorAvatar: string | null = null;
  let publishedAt: string | null = null;
  let type: string | null = null;

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

        if (!type && item['@type']) {
          type = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
        }

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

        // Extract image
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

        // Extract author
        if (!author && item.author) {
          if (typeof item.author === 'string') {
            author = item.author.trim();
          } else if (typeof item.author === 'object') {
            author = item.author.name || null;
            if (typeof item.author.image === 'string') {
              authorAvatar = item.author.image.trim();
            } else if (item.author.image && typeof item.author.image.url === 'string') {
              authorAvatar = item.author.image.url.trim();
            }
          }
        }

        // Extract published date
        if (!publishedAt) {
          const pubDate = item.datePublished || item.dateCreated || item.uploadDate;
          if (typeof pubDate === 'string' && pubDate.trim()) {
            publishedAt = pubDate.trim();
          }
        }
      }
    } catch {
      // Ignore JSON parse failures in script tags
    }
  });

  return { title, description, image, author, authorAvatar, publishedAt, type };
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

    // Helper to extract content from an array of meta selectors in order
    const getMeta = (...selectors: string[]): string | null => {
      for (const sel of selectors) {
        const val = $(sel).attr('content');
        if (val && val.trim()) {
          return val.trim();
        }
      }
      return null;
    };

    // 1. Title resolution order: twitter -> meta property/name -> og -> jsonLd -> htmlTitle
    const twitterTitle = getMeta('meta[name="twitter:title"]', 'meta[property="twitter:title"]');
    const metaTitle = getMeta('meta[property="title"]', 'meta[name="title"]');
    const ogTitle = getMeta('meta[property="og:title"]', 'meta[name="og:title"]');
    const htmlTitle = $('title').first().text().trim() || null;
    const rawTitle = twitterTitle || metaTitle || ogTitle || jsonLd.title || htmlTitle || null;
    const title = cleanTitle(rawTitle);

    // 2. Description resolution order: twitter -> meta property/name -> og -> jsonLd
    const twitterDesc = getMeta('meta[name="twitter:description"]', 'meta[property="twitter:description"]');
    const metaDesc = getMeta('meta[property="description"]', 'meta[name="description"]');
    const ogDesc = getMeta('meta[property="og:description"]', 'meta[name="og:description"]');
    const rawDesc = twitterDesc || metaDesc || ogDesc || jsonLd.description || null;
    const description = cleanDescription(rawDesc);

    // 3. Direct Image resolution order: twitter -> meta property/name -> og -> jsonLd
    const twitterImage = getMeta(
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[property="twitter:image:src"]'
    );
    const metaImage = getMeta('meta[property="image"]', 'meta[name="image"]');
    const ogImage = getMeta(
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="og:image:secure_url"]'
    );
    const rawImage = twitterImage || metaImage || ogImage || jsonLd.image || null;
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

    // 4. Logo resolution order: twitter -> meta property/name -> og -> link icons -> /favicon.ico
    const twitterLogo = getMeta(
      'meta[name="twitter:logo"]',
      'meta[property="twitter:logo"]',
      'meta[name="twitter:app:icon:iphone"]',
      'meta[name="twitter:app:icon:googleplay"]'
    );
    const metaLogo = getMeta('meta[property="logo"]', 'meta[name="logo"]');
    const ogLogo = getMeta('meta[property="og:logo"]', 'meta[name="og:logo"]');
    const appleIcon = $('link[rel~="apple-touch-icon"]').attr('href');
    const icon = $('link[rel~="icon"]').attr('href');
    const shortcutIcon = $('link[rel~="shortcut icon"]').attr('href');
    const rawLogo = twitterLogo || metaLogo || ogLogo || appleIcon || icon || shortcutIcon;
    const logo = resolveUrl(rawLogo, targetUrl) || resolveUrl('/favicon.ico', targetUrl);

    // og:site_name
    const ogSiteName = $('meta[property="og:site_name"]').attr('content') || null;

    // Author resolution
    const metaAuthor = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || $('meta[name="twitter:creator"]').attr('content');
    const author = (metaAuthor || jsonLd.author || '').trim() || null;

    // Published date resolution
    const metaDate = $('meta[property="article:published_time"]').attr('content') || $('meta[name="pubdate"]').attr('content') || $('meta[name="date"]').attr('content');
    const publishedAt = (metaDate || jsonLd.publishedAt || '').trim() || null;

    // Type resolution
    const metaType = $('meta[property="og:type"]').attr('content');
    const type = (metaType || jsonLd.type || 'website').trim();

    // Author avatar resolution
    const authorAvatar = resolveUrl(jsonLd.authorAvatar, targetUrl);

    return {
      title,
      rawTitle,
      twitterTitle: twitterTitle || null,
      description,
      rawDescription: rawDesc,
      image,
      logo,
      ogSiteName,
      author,
      authorAvatar,
      publishedAt,
      type,
      likes: null,
      comments: null,
      shares: null,
      views: null,
    };
  } catch (error) {
    console.error(`[cheerioScraper] Error scraping ${targetUrl}:`, error);
    return null;
  }
}
