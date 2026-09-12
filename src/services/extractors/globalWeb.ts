import { PlatformExtractor, ExtractionResult, GlobalWebCardData } from './types';
import * as cheerio from 'cheerio';
import { scrapeWithCheerio, extractArticleContent, detectPageIntent } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';

function fallbackTitle(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return 'Untitled Bookmark';
  }
}

const buildGlobalCardData = (
  author: string | null,
  publishedAt: string | null,
  siteName: string | null,
  type: string | null,
  snapshot: string | null,
  pageIntent?: string | null,
  articleContent?: string | null,
  wordCount?: number | null,
  readingTimeMinutes?: number | null
): GlobalWebCardData => {
  return {
    author: author || null,
    published_at: publishedAt || null,
    site_name: siteName || null,
    type: type || 'website',
    snapshot: snapshot || null,
    page_intent: pageIntent || null,
    article_content: articleContent || null,
    word_count: wordCount !== undefined ? wordCount : null,
    reading_time_minutes: readingTimeMinutes !== undefined ? readingTimeMinutes : null,
  };
};

export const globalWebExtractor: PlatformExtractor<GlobalWebCardData> = {
  platformKey: 'generic',
  async extract(targetUrl: string): Promise<ExtractionResult<GlobalWebCardData>> {
    // 1. Cheerio Fast-Path: Ultra-fast (~150-300ms) metadata extraction
    const cheerioData = await scrapeWithCheerio(targetUrl);

    // If Cheerio extracted a title, description, or image, return immediately without invoking Playwright
    if (cheerioData && (cheerioData.title || cheerioData.description || cheerioData.image)) {
      const snap = cheerioData.image || null;
      return {
        title: cheerioData.title || fallbackTitle(targetUrl),
        description: cheerioData.description || '',
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData.ogSiteName,
        card_data: buildGlobalCardData(
          cheerioData.author,
          cheerioData.publishedAt,
          cheerioData.ogSiteName,
          cheerioData.type,
          snap,
          cheerioData.pageIntent,
          cheerioData.articleContent,
          cheerioData.wordCount,
          cheerioData.readingTimeMinutes
        ),
      };
    }

    // 2. Playwright Fallback: Headless browser (<2s, styles/images blocked) for JS-rendered SPAs or blocked requests
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitTimeout: 2000,
        includeHtml: true,
      });

      let articleContent = cheerioData?.articleContent || null;
      let wordCount = cheerioData?.wordCount || null;
      let readingTimeMinutes = cheerioData?.readingTimeMinutes || null;
      let pageIntent = cheerioData?.pageIntent;

      if (!articleContent && pwData.html) {
        const $pw = cheerio.load(pwData.html);
        const articleRes = extractArticleContent($pw);
        articleContent = articleRes.content;
        wordCount = articleRes.wordCount;
        readingTimeMinutes = articleRes.readingTimeMinutes;
        pageIntent = detectPageIntent($pw, targetUrl, pwData.type, null, articleRes.wordCount);
      }

      const snap = pwData.snapshot || cheerioData?.image || null;
      return {
        title: pwData.title || cheerioData?.title || fallbackTitle(targetUrl),
        description: pwData.description || cheerioData?.description || '',
        logo: pwData.logo || cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: pwData.ogSiteName || cheerioData?.ogSiteName || null,
        card_data: buildGlobalCardData(
          pwData.author || cheerioData?.author || null,
          pwData.publishedAt || cheerioData?.publishedAt || null,
          pwData.ogSiteName || cheerioData?.ogSiteName || null,
          pwData.type || cheerioData?.type || null,
          snap,
          pageIntent,
          articleContent,
          wordCount,
          readingTimeMinutes
        ),
      };
    } catch {
      const snap = cheerioData?.image || null;
      return {
        title: cheerioData?.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || '',
        logo: cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData?.ogSiteName || null,
        card_data: buildGlobalCardData(
          cheerioData?.author || null,
          cheerioData?.publishedAt || null,
          cheerioData?.ogSiteName || null,
          cheerioData?.type || null,
          snap,
          cheerioData?.pageIntent,
          cheerioData?.articleContent,
          cheerioData?.wordCount,
          cheerioData?.readingTimeMinutes
        ),
      };
    }
  },
};
