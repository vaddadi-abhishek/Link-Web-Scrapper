import axios from 'axios';
import * as cheerio from 'cheerio';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';
import { sharedHttpAgent, sharedHttpsAgent } from '../utils/httpClient';
import { logger } from '../utils/logger';

export type WebPageIntent = 'article' | 'tool_or_resource' | 'auth_or_portal' | 'general_website';

export interface ArticleExtractionResult {
  content: string | null;
  wordCount: number;
  readingTimeMinutes: number;
}

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
  rawHtml?: string | null;
  pageIntent?: WebPageIntent;
  articleContent?: string | null;
  wordCount?: number;
  readingTimeMinutes?: number;
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
 * Detects whether a page is an in-depth article/essay, developer tool/resource, or login/auth portal.
 */
export function detectPageIntent(
  $: cheerio.CheerioAPI,
  targetUrl: string,
  ogType?: string | null,
  jsonLdType?: string | null,
  proseWordCount: number = 0
): WebPageIntent {
  const urlLower = targetUrl.toLowerCase();

  // 1. Auth / Account / Login Portal
  const isAuthUrl = /\/(login|signin|signup|auth|account|register|join|session|recover|forgot)/i.test(urlLower);
  const hasPasswordInput = $('input[type="password"], input[name*="pass" i]').length > 0;
  const hasLoginForm = $('form[action*="login" i], form[action*="auth" i], form[action*="signin" i]').length > 0;
  if (hasPasswordInput || hasLoginForm || (isAuthUrl && $('input').length > 0)) {
    return 'auth_or_portal';
  }

  // 2. Explicit Article Metadata
  const isArticleMeta =
    ogType === 'article' ||
    Boolean(jsonLdType && /article|blogposting/i.test(jsonLdType)) ||
    $('meta[property="article:published_time"]').length > 0 ||
    $('meta[name="article:author"]').length > 0 ||
    $('meta[property="article:author"]').length > 0;

  if (isArticleMeta || ($('article').length > 0 && proseWordCount > 150) || proseWordCount > 250) {
    return 'article';
  }

  // 3. Component / Tool / Library / UI Gallery
  const isDocsOrTools = /\/(components|docs|tools|ui|library|resources|templates|icons|cheatsheet|showcase)/i.test(urlLower);
  const codeBlocksCount = $('pre, code, .component, .grid, .preview').length;
  if (isDocsOrTools || codeBlocksCount > 8) {
    return 'tool_or_resource';
  }

  return 'general_website';
}

/**
 * Extracts the full readable article text in structured Markdown format
 * from the most relevant article container, stripping non-content elements and ads.
 */
export function extractArticleContent($: cheerio.CheerioAPI): ArticleExtractionResult {
  try {
    const clone = $('body').clone();

    // 1. Strip non-content and noise elements
    clone.find(`
      nav, header, footer, script, style, aside, noscript, svg, form, iframe,
      .nav, .navbar, .menu, .navigation, .sidebar, .comments, .comment-section,
      .share, .social-share, .newsletter, .subscription, .advertisement, .ad,
      .author-bio, .related-posts, .recommended, .cookie-banner, .popup,
      [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"]
    `).remove();

    // 2. Candidate selectors for article body containers in order of priority
    const containerSelectors = [
      'article',
      '[itemprop="articleBody"]',
      '.post-content',
      '.gh-content',
      '.entry-content',
      '.article-content',
      '.article-body',
      '.story-body',
      '.content-body',
      '.post__content',
      '.markdown-body',
      'main',
    ];

    let $container: cheerio.Cheerio<any> | null = null;
    for (const sel of containerSelectors) {
      const match = clone.find(sel);
      if (match.length > 0) {
        let best = match.first();
        let maxLen = best.text().trim().length;
        match.each((_, el) => {
          const len = $(el).text().trim().length;
          if (len > maxLen) {
            maxLen = len;
            best = $(el);
          }
        });
        if (maxLen > 250) {
          $container = best;
          break;
        }
      }
    }

    if (!$container || $container.length === 0) {
      $container = clone;
    }

    // 3. Extract structured blocks
    const blocks: string[] = [];
    $container.find('h1, h2, h3, h4, h5, h6, p, blockquote, ul, ol, pre, figure, img').each((_, el) => {
      const $el = $(el);
      const tag = (el.tagName || '').toLowerCase();

      // Avoid duplicating nested elements (e.g. p inside blockquote or li)
      if (tag === 'p' && $el.parents('blockquote, li').length > 0) {
        return;
      }
      if (tag === 'img' && $el.parents('figure').length > 0) {
        return;
      }

      if (tag === 'p') {
        const text = $el.text().trim();
        if (text.length > 20) {
          blocks.push(text);
        }
      } else if (tag.startsWith('h')) {
        const text = $el.text().trim();
        if (text) {
          const levelNum = parseInt(tag.charAt(1), 10) || 2;
          const prefix = '#'.repeat(levelNum);
          blocks.push(`${prefix} ${text}`);
        }
      } else if (tag === 'blockquote') {
        const text = $el.text().trim();
        if (text) {
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
          blocks.push(lines.map((l) => `> ${l}`).join('\n'));
        }
      } else if (tag === 'pre') {
        const codeText = $el.find('code').length > 0 ? $el.find('code').text() : $el.text();
        if (codeText.trim()) {
          blocks.push(`\`\`\`\n${codeText.trim()}\n\`\`\``);
        }
      } else if (tag === 'ul' || tag === 'ol') {
        const items: string[] = [];
        $el.find('li').each((__, li) => {
          const liText = $(li).text().trim();
          if (liText) {
            items.push(`• ${liText}`);
          }
        });
        if (items.length > 0) {
          blocks.push(items.join('\n'));
        }
      } else if (tag === 'figure') {
        const img = $el.find('img').first();
        const src = img.attr('src') || img.attr('data-src') || img.attr('data-original');
        const caption = $el.find('figcaption').text().trim() || img.attr('alt') || '';
        if (src && !src.startsWith('data:image/svg') && !src.includes('1x1')) {
          blocks.push(`![${caption}](${src})`);
        }
      } else if (tag === 'img') {
        const src = $el.attr('src') || $el.attr('data-src');
        const alt = $el.attr('alt') || '';
        if (src && !src.startsWith('data:image/svg') && !src.includes('1x1') && !src.includes('tracking')) {
          blocks.push(`![${alt}](${src})`);
        }
      }
    });

    if (blocks.length === 0) {
      return { content: null, wordCount: 0, readingTimeMinutes: 0 };
    }

    const fullProse = blocks.join('\n\n').trim();
    if (!fullProse) {
      return { content: null, wordCount: 0, readingTimeMinutes: 0 };
    }

    const wordCount = fullProse.split(/\s+/).filter(Boolean).length;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    return {
      content: fullProse,
      wordCount,
      readingTimeMinutes,
    };
  } catch {
    return { content: null, wordCount: 0, readingTimeMinutes: 0 };
  }
}

/**
 * Fast-path scraper using Axios & Cheerio with Connection Reuse.
 * Timeout: 4000ms.
 */
export async function scrapeWithCheerio(targetUrl: string): Promise<CheerioExtractionResult | null> {
  try {
    const lowerUrl = targetUrl.toLowerCase();
    const isTwitterOrX = lowerUrl.includes('x.com') || lowerUrl.includes('twitter.com');
    const isReddit = lowerUrl.includes('reddit.com');
    const userAgent = isTwitterOrX || isReddit
      ? 'Twitterbot/1.0 (https://dev.twitter.com/cards/overview)'
      : 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

    const response = await axios.get(targetUrl, {
      timeout: 4000,
      maxContentLength: 5 * 1024 * 1024,
      httpAgent: sharedHttpAgent,
      httpsAgent: sharedHttpsAgent,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
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

    // 1. Title resolution order: twitter -> og -> meta[name="title"] -> jsonLd -> htmlTitle -> h1
    const twitterTitle = getMeta('meta[name="twitter:title"]', 'meta[property="twitter:title"]');
    const ogTitle = getMeta('meta[property="og:title"]', 'meta[name="og:title"]');
    const metaTitle = getMeta('meta[name="title"]', 'meta[property="title"]');
    const htmlTitle = $('title').first().text().trim() || null;
    const h1Title = $('h1').first().text().trim() || null;
    const rawTitle = twitterTitle || ogTitle || metaTitle || jsonLd.title || htmlTitle || h1Title || null;
    let title = cleanTitle(rawTitle);

    // 2. Description resolution order: twitter -> og -> meta[name="description"] -> jsonLd -> first <p>
    const twitterDesc = getMeta('meta[name="twitter:description"]', 'meta[property="twitter:description"]');
    const ogDesc = getMeta('meta[property="og:description"]', 'meta[name="og:description"]');
    const metaDesc = getMeta('meta[name="description"]', 'meta[property="description"]');
    let firstP: string | null = null;
    const pText = $('article p, main p, p').first().text().trim();
    if (pText && pText.length > 20) {
      firstP = pText.substring(0, 300);
    }
    const rawDesc = twitterDesc || ogDesc || metaDesc || jsonLd.description || firstP || null;
    let description = cleanDescription(rawDesc);

    // Filter generic Login / Auth Wall metadata (e.g. "Login • Instagram", "Welcome back to Instagram...")
    const combinedAuth = `${title || ''} ${description || ''}`.toLowerCase();
    if (
      combinedAuth.includes('login • instagram') ||
      combinedAuth.includes('welcome back to instagram') ||
      combinedAuth.includes('sign in to check out what your friends') ||
      combinedAuth.includes('log in to instagram') ||
      title?.toLowerCase() === 'login'
    ) {
      title = null;
      description = null;
    }

    // 3. Direct Image resolution order prioritizing og:image and twitter:image
    const ogImage = getMeta(
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="og:image:secure_url"]'
    );
    const twitterImage = getMeta(
      'meta[name="twitter:image"]',
      'meta[property="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[property="twitter:image:src"]'
    );
    const metaImage = getMeta('meta[name="image"]', 'meta[property="image"]');
    const rawImage = ogImage || twitterImage || metaImage || jsonLd.image || null;
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

    // Extract readable article text & classify page intent
    const { content: articleContent, wordCount: proseWordCount, readingTimeMinutes } = extractArticleContent($);
    const pageIntent = detectPageIntent($, targetUrl, metaType, jsonLd.type, proseWordCount);

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
      rawHtml: html,
      pageIntent,
      articleContent,
      wordCount: proseWordCount,
      readingTimeMinutes,
    };
  } catch (error: any) {
    logger.warn('CheerioScraper', `Error scraping ${targetUrl}:`, error?.message || error);
    return null;
  }
}
