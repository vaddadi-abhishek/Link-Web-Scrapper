import { normalizeUrl } from '../utils/urlFormatter';
import { deriveSiteName } from '../utils/siteName';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';
import { dispatchExtraction } from './extractors';

export interface ExtractionResponse {
  url: string;
  title: string;
  description: string;
  snapshot: string | null;
  logo: string | null;
  site_name: string;
  published_at: string | null;
}

/**
 * Tiered Modular Metadata and Snapshot Extraction Service
 */
export async function extractMetadata(rawUrl: string): Promise<ExtractionResponse> {
  const url = normalizeUrl(rawUrl);

  const result = await dispatchExtraction(url);

  const siteName = deriveSiteName(url, result.ogSiteName);
  const title = cleanTitle(result.title) || fallbackTitle(url);
  const description = cleanDescription(result.description) || '';

  // Only populate published_at for Instagram (e.g. "August 1, 2026"), null for all other sites
  const isInstagram = url.toLowerCase().includes('instagram.com');
  const published_at = isInstagram ? result.publishedAt || null : null;

  return {
    url,
    title,
    description,
    snapshot: result.snapshot,
    logo: result.logo,
    site_name: siteName,
    published_at,
  };
}

function fallbackTitle(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return 'Untitled Bookmark';
  }
}
