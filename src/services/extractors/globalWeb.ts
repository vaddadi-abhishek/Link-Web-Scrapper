import { PlatformExtractor, ExtractionResult, GlobalWebCardData } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
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
  type: string | null
): GlobalWebCardData => {
  return {
    author: author || null,
    published_at: publishedAt || null,
    site_name: siteName || null,
    type: type || 'website',
  };
};

export const globalWebExtractor: PlatformExtractor<GlobalWebCardData> = {
  platformKey: 'generic',
  async extract(targetUrl: string): Promise<ExtractionResult<GlobalWebCardData>> {
    // 1. Cheerio Fast-Path: Ultra-fast (~150-300ms) metadata extraction
    const cheerioData = await scrapeWithCheerio(targetUrl);

    // If Cheerio extracted a title, description, or image, return immediately without invoking Playwright
    if (cheerioData && (cheerioData.title || cheerioData.description || cheerioData.image)) {
      return {
        title: cheerioData.title || fallbackTitle(targetUrl),
        description: cheerioData.description || '',
        snapshot: cheerioData.image || null,
        logo: cheerioData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData.ogSiteName,
        card_data: buildGlobalCardData(
          cheerioData.author,
          cheerioData.publishedAt,
          cheerioData.ogSiteName,
          cheerioData.type
        ),
      };
    }

    // 2. Playwright Fallback: Headless browser (<2s, styles/images blocked) for JS-rendered SPAs or blocked requests
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        waitTimeout: 2000,
      });

      return {
        title: pwData.title || cheerioData?.title || fallbackTitle(targetUrl),
        description: pwData.description || cheerioData?.description || '',
        snapshot: pwData.snapshot || cheerioData?.image || null,
        logo: pwData.logo || cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: pwData.ogSiteName || cheerioData?.ogSiteName || null,
        card_data: buildGlobalCardData(
          pwData.author || cheerioData?.author || null,
          pwData.publishedAt || cheerioData?.publishedAt || null,
          pwData.ogSiteName || cheerioData?.ogSiteName || null,
          pwData.type || cheerioData?.type || null
        ),
      };
    } catch {
      return {
        title: cheerioData?.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || '',
        snapshot: cheerioData?.image || null,
        logo: cheerioData?.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData?.ogSiteName || null,
        card_data: buildGlobalCardData(
          cheerioData?.author || null,
          cheerioData?.publishedAt || null,
          cheerioData?.ogSiteName || null,
          cheerioData?.type || null
        ),
      };
    }
  },
};
