import { PlatformExtractor, ExtractionResult, GlobalWebCardData, ArticleData } from './types';
import * as cheerio from 'cheerio';
import { scrapeWithCheerio, extractArticleContent, detectPageIntent } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';
import { isAccessDeniedOrChallenge } from '../../utils/textCleaner';
import { extractArticleWithReadability } from '../readabilityService';

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
    const isCheerioBlocked = cheerioData
      ? isAccessDeniedOrChallenge(cheerioData.title, cheerioData.description, cheerioData.rawHtml)
      : false;

    // If Cheerio extracted valid metadata (and is NOT blocked), process article readability and return
    if (cheerioData && !isCheerioBlocked && (cheerioData.title || cheerioData.description || cheerioData.image)) {
      const snap = cheerioData.image || null;
      let articleData: ArticleData | null = null;

      if (cheerioData.rawHtml) {
        articleData = extractArticleWithReadability(cheerioData.rawHtml, targetUrl);
      }

      const finalArticleContent = articleData?.content_text || cheerioData.articleContent || null;
      const finalWordCount = articleData?.word_count ?? cheerioData.wordCount ?? null;
      const finalReadingTime = articleData?.reading_time_minutes ?? cheerioData.readingTimeMinutes ?? null;

      return {
        title: cheerioData.title || fallbackTitle(targetUrl),
        description: cheerioData.description || '',
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData.ogSiteName,
        article: articleData,
        card_data: buildGlobalCardData(
          articleData?.byline || cheerioData.author,
          cheerioData.publishedAt,
          cheerioData.ogSiteName,
          articleData ? 'article' : cheerioData.type,
          snap,
          articleData ? 'article' : cheerioData.pageIntent,
          finalArticleContent,
          finalWordCount,
          finalReadingTime
        ),
      };
    }

    // 2. Playwright Fallback: Headless browser (<2s, styles/images blocked) for JS-rendered SPAs or blocked requests
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitTimeout: 2000,
        includeHtml: true,
      });

      const isPwBlocked = isAccessDeniedOrChallenge(pwData.title, pwData.description, pwData.html);
      if (isPwBlocked) {
        throw new Error(`Playwright received access denied / bot challenge for ${targetUrl}`);
      }

      let articleData: ArticleData | null = null;
      const htmlToParse = pwData.html || (!isCheerioBlocked ? cheerioData?.rawHtml : null);
      if (htmlToParse) {
        articleData = extractArticleWithReadability(htmlToParse, targetUrl);
      }

      let articleContent = articleData?.content_text || (!isCheerioBlocked ? cheerioData?.articleContent : null);
      let wordCount = articleData?.word_count ?? (!isCheerioBlocked ? cheerioData?.wordCount : null);
      let readingTimeMinutes = articleData?.reading_time_minutes ?? (!isCheerioBlocked ? cheerioData?.readingTimeMinutes : null);
      let pageIntent = articleData ? 'article' : (!isCheerioBlocked ? cheerioData?.pageIntent : null);

      if (!articleContent && pwData.html) {
        const $pw = cheerio.load(pwData.html);
        const articleRes = extractArticleContent($pw);
        articleContent = articleRes.content;
        wordCount = articleRes.wordCount;
        readingTimeMinutes = articleRes.readingTimeMinutes;
        pageIntent = detectPageIntent($pw, targetUrl, pwData.type, null, articleRes.wordCount);
      }

      const snap = pwData.snapshot || (!isCheerioBlocked ? cheerioData?.image : null) || null;
      return {
        title: pwData.title || (!isCheerioBlocked ? cheerioData?.title : null) || fallbackTitle(targetUrl),
        description: pwData.description || (!isCheerioBlocked ? cheerioData?.description : null) || '',
        logo: pwData.logo || cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: pwData.ogSiteName || (!isCheerioBlocked ? cheerioData?.ogSiteName : null) || null,
        article: articleData,
        card_data: buildGlobalCardData(
          articleData?.byline || pwData.author || (!isCheerioBlocked ? cheerioData?.author : null) || null,
          pwData.publishedAt || (!isCheerioBlocked ? cheerioData?.publishedAt : null) || null,
          pwData.ogSiteName || (!isCheerioBlocked ? cheerioData?.ogSiteName : null) || null,
          articleData ? 'article' : (pwData.type || (!isCheerioBlocked ? cheerioData?.type : null) || null),
          snap,
          pageIntent,
          articleContent,
          wordCount,
          readingTimeMinutes
        ),
      };
    } catch {
      const snap = !isCheerioBlocked ? (cheerioData?.image || null) : null;
      const articleData = (!isCheerioBlocked && cheerioData?.rawHtml)
        ? extractArticleWithReadability(cheerioData.rawHtml, targetUrl)
        : null;

      const safeTitle = (!isCheerioBlocked && cheerioData?.title)
        ? cheerioData.title
        : fallbackTitle(targetUrl);
      const safeDesc = (!isCheerioBlocked && cheerioData?.description)
        ? cheerioData.description
        : '';

      return {
        title: safeTitle,
        description: safeDesc,
        logo: cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: !isCheerioBlocked ? (cheerioData?.ogSiteName || null) : null,
        article: articleData,
        card_data: buildGlobalCardData(
          articleData?.byline || (!isCheerioBlocked ? cheerioData?.author : null) || null,
          !isCheerioBlocked ? cheerioData?.publishedAt || null : null,
          !isCheerioBlocked ? cheerioData?.ogSiteName || null : null,
          articleData ? 'article' : (!isCheerioBlocked ? cheerioData?.type || null : null),
          snap,
          articleData ? 'article' : (!isCheerioBlocked ? cheerioData?.pageIntent : null),
          articleData?.content_text || (!isCheerioBlocked ? cheerioData?.articleContent : null),
          articleData?.word_count ?? (!isCheerioBlocked ? cheerioData?.wordCount : null),
          articleData?.reading_time_minutes ?? (!isCheerioBlocked ? cheerioData?.readingTimeMinutes : null)
        ),
      };
    }
  },
};

