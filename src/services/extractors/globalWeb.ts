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
    // 1. Cheerio Fast-Path: ALWAYS target og:image or twitter:image first
    const cheerioData = await scrapeWithCheerio(targetUrl);

    const hasDirectImage = !!(cheerioData && cheerioData.image);

    // If og:image or twitter:image is found in HTML metadata, return immediately
    if (cheerioData && hasDirectImage) {
      return {
        title: cheerioData.title || fallbackTitle(targetUrl),
        description: cheerioData.description || '',
        snapshot: cheerioData.image,
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

    // 2. Playwright Fallback: Only take a screenshot if NO og:image or twitter:image was found in HTML
    try {
      const pwData = await playwrightEngine.scrape(targetUrl, {
        viewport: { width: 1920, height: 1080 },
        viewportOnly: true,
      });

      return {
        title: cheerioData?.title || pwData.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || pwData.description || '',
        snapshot: pwData.snapshot || null,
        logo: cheerioData?.logo || pwData.logo || resolveUrl('/favicon.ico', targetUrl),
        ogSiteName: cheerioData?.ogSiteName || pwData.ogSiteName || null,
        card_data: buildGlobalCardData(
          cheerioData?.author || pwData.author,
          cheerioData?.publishedAt || pwData.publishedAt,
          cheerioData?.ogSiteName || pwData.ogSiteName,
          cheerioData?.type || pwData.type
        ),
      };
    } catch {
      return {
        title: cheerioData?.title || fallbackTitle(targetUrl),
        description: cheerioData?.description || '',
        snapshot: null,
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
