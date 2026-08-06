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
  created_at: string;
}

/**
 * Tiered Modular Metadata and Snapshot Extraction Service
 */
export async function extractMetadata(rawUrl: string): Promise<ExtractionResponse> {
  const url = normalizeUrl(rawUrl);
  const createdAt = new Date().toISOString();

  const result = await dispatchExtraction(url);

  const siteName = deriveSiteName(url, result.ogSiteName);
  const title = cleanTitle(result.title) || fallbackTitle(url);
  const description = cleanDescription(result.description) || '';

  return {
    url,
    title,
    description,
    snapshot: result.snapshot,
    logo: result.logo,
    site_name: siteName,
    created_at: createdAt,
  };
}

function fallbackTitle(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return 'Untitled Bookmark';
  }
}
