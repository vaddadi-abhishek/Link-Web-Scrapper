import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import DOMPurifyFactory from 'dompurify';
import { JSDOM } from 'jsdom';
import { ArticleData } from './extractors/types';
import { logger } from '../utils/logger';

const domWindow = new JSDOM('').window;
const DOMPurify = DOMPurifyFactory(domWindow as any);

export interface ReadabilityOptions {
  minWordCount?: number;
}

/**
 * Sanitizes extracted article HTML strictly against XSS attacks.
 * Restricts tags strictly to structural elements and attributes to href, src, alt, title,
 * while rejecting javascript: and other dangerous pseudo-protocols.
 */
export function sanitizeArticleHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'blockquote',
      'code',
      'pre',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'a',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/**
 * Synthesizes clean canonical Markdown from sanitized article HTML.
 */
export function synthesizeMarkdownFromHtml(sanitizedHtml: string): string {
  if (!sanitizedHtml) return '';
  return sanitizedHtml
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n')
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img\s+(?:[^>]*?\s+)?src="([^"]*)"(?:\s+alt="([^"]*)")?[^>]*>/gi, '![$2]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/ul>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts clean, reader-mode article content from HTML using Mozilla Readability.
 * Includes DOM pre-cleaning for sidebars, link-density analysis, and URL normalization.
 */
export function extractArticleWithReadability(
  rawHtml: string,
  targetUrl: string,
  options: ReadabilityOptions = {}
): ArticleData | null {
  try {
    if (!rawHtml || typeof rawHtml !== 'string' || rawHtml.trim().length < 200) {
      return null;
    }

    const { document } = parseHTML(rawHtml);

    // 1. Pre-clean obvious navigation, documentation sidebars, table-of-contents, and header/footer noise
    const noiseSelectors = [
      '[data-slot="sidebar"]',
      '[data-sidebar]',
      '[data-sidebar="sidebar"]',
      'aside',
      'nav',
      '[role="navigation"]',
      '[role="menubar"]',
      '[role="complementary"]',
      '[class*="sidebar-menu"]',
      '[class*="sidebar-group"]',
      '[class*="sidebar-content"]',
      '[class*="table-of-contents"]',
      '[class*="toc-"]',
      '[class*="on-this-page"]',
      '[class*="pagination"]',
      '[class*="breadcrumb"]',
      '[class*="cookie"]',
      '[id*="cookie"]',
      '[class*="newsletter"]',
      '[id*="newsletter"]',
      'body > header',
      'body > footer',
    ];

    try {
      document.querySelectorAll(noiseSelectors.join(',')).forEach((el) => {
        el.remove();
      });
    } catch {
      // Ignore any querySelector syntax edge-cases
    }

    // 2. Resolve relative URLs (href & img src) against targetUrl to prevent localhost leak
    if (targetUrl) {
      document.querySelectorAll('a[href]').forEach((a) => {
        try {
          const href = a.getAttribute('href');
          if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('javascript:')) {
            a.setAttribute('href', new URL(href, targetUrl).href);
          }
        } catch {
          // Ignore invalid URL formatting
        }
      });

      document.querySelectorAll('img[src], img[data-src]').forEach((img) => {
        try {
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
            const absoluteSrc = new URL(src, targetUrl).href;
            img.setAttribute('src', absoluteSrc);
          }
        } catch {
          // Ignore invalid image URL
        }
      });
    }

    // 3. Run Mozilla Readability parser
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 150,
      keepClasses: false,
    });

    const parsed = reader.parse();
    if (!parsed || !parsed.content) {
      return null;
    }

    const textContent = (parsed.textContent || '').trim();
    const words = textContent.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // Reject pages with too few words (e.g. login screens, navigation portals)
    const minWords = options.minWordCount ?? 80;
    if (wordCount < minWords) {
      return null;
    }

    // 4. Link Density Guard: Check if the extracted content is still predominantly a list of links
    const { document: parsedDoc } = parseHTML(parsed.content);
    let linkChars = 0;
    parsedDoc.querySelectorAll('a').forEach((a) => {
      linkChars += (a.textContent || '').trim().length;
    });

    const totalChars = textContent.length;
    if (totalChars > 0 && linkChars / totalChars > 0.55) {
      // More than 55% of the extracted content is link anchor text -> directory/menu, not an article
      logger.info('ReadabilityService', `Rejected ${targetUrl} due to high link density (${Math.round((linkChars / totalChars) * 100)}%)`);
      return null;
    }

    // Standard human reading speed: ~200 words per minute
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    const sanitizedHtml = sanitizeArticleHtml(parsed.content);
    const canonicalMarkdown = synthesizeMarkdownFromHtml(sanitizedHtml);

    return {
      content_html: sanitizedHtml,
      content_text: textContent,
      content_markdown: canonicalMarkdown,
      byline: parsed.byline || null,
      excerpt: parsed.excerpt || null,
      word_count: wordCount,
      reading_time_minutes: readingTimeMinutes,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('ReadabilityService', `Failed to parse article for ${targetUrl}:`, message);
    return null;
  }
}
