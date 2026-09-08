import { Request, Response } from 'express';
import { dispatchExtraction } from '../services/extractors';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { logger } from '../utils/logger';

const getUrlFromRequest = async (req: Request): Promise<string | null> => {
  const url = req.body?.url || req.query?.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return null;
  }
  
  const trimmedUrl = url.trim();
  const isSafe = await validateUrlAgainstSSRF(trimmedUrl);
  if (!isSafe) {
    throw new Error('Security Error: Invalid or internal URL provided (Possible SSRF attack blocked).');
  }
  
  return trimmedUrl;
};

export const extractMetadataController = async (req: Request, res: Response): Promise<void> => {
  try {
    const url = await getUrlFromRequest(req);
    if (!url) {
      res.status(400).json({ error: "Missing or invalid 'url' parameter." });
      return;
    }
    
    const html = req.body?.html;
    const forceRefresh = Boolean(
      req.body?.forceRefresh ||
      req.body?.noCache ||
      req.query?.forceRefresh === 'true' ||
      req.query?.noCache === 'true'
    );

    const { result, platform, cached } = await dispatchExtraction(url, html, { forceRefresh });
    const siteName = deriveSiteName(url, result.ogSiteName);

    // AI Context invocation disabled during scraping for speed & optimization
    // Standalone analysis remains available via POST /api/v1/ai-analyze
    const aiContext: string | null = null;
    const aiTags: string[] = [];
    const visualEntities: string[] = [];
    const ocrText = '';

    res.status(200).json({
      type: platform,
      url,
      title: result.title !== undefined ? result.title : null,
      description: result.description || '',
      logo: result.logo || null,
      site_name: siteName,
      card_data: result.card_data,
      ai_context: aiContext,
      ai_tags: aiTags,
      visual_entities: visualEntities,
      ocr_text: ocrText,
      ...(cached ? { cached: true } : {}),
    });
  } catch (error: any) {
    logger.error('ExtractController', 'Extraction error:', error?.message || error);
    res.status(500).json({ error: error.message || 'Failed to extract metadata' });
  }
};
