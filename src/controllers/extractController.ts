import { Request, Response } from 'express';
import { dispatchExtraction } from '../services/extractors';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { analyzeVisualContext } from '../services/aiVisualService';
import { canonicalizeUrl } from '../utils/urlFormatter';
import { extractionCache } from '../utils/cache';
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
    const rawUrl = await getUrlFromRequest(req);
    if (!rawUrl) {
      res.status(400).json({ error: "Missing or invalid 'url' parameter." });
      return;
    }

    // Canonicalize the URL (strips tracking query params, unifies /reels/ to /reel/, normalizes hostnames)
    const canonicalUrl = canonicalizeUrl(rawUrl);
    
    const html = req.body?.html;
    const forceRefresh = Boolean(
      req.body?.forceRefresh ||
      req.body?.noCache ||
      req.query?.forceRefresh === 'true' ||
      req.query?.noCache === 'true'
    );

    // Check if AI Visual Intelligence is enabled via .env or request flags
    const isAiEnabled =
      process.env.ENABLE_AI_VISUAL === 'true' ||
      req.body?.enableAi === true ||
      req.query?.enableAi === 'true';

    // 1. Controller-Level Instant Cache Check
    // Returns full extracted metadata + AI analysis in <1ms on identical or tracking-parameterized URLs
    const fullCacheKey = `full_${canonicalUrl}_ai=${isAiEnabled}`;
    if (!forceRefresh && !html) {
      const cachedResponse = extractionCache.get(fullCacheKey);
      if (cachedResponse) {
        logger.info('ExtractController', `Instant Cache Hit (<1ms) for "${canonicalUrl}" (origin: "${rawUrl}")`);
        res.status(200).json({
          ...cachedResponse,
          url: rawUrl, // Preserve original requested URL
          canonical_url: canonicalUrl,
          cached: true,
        });
        return;
      }
    }

    // 2. Dispatch platform extraction with canonical URL
    const { result, platform, cached } = await dispatchExtraction(canonicalUrl, html, { forceRefresh });
    const siteName = deriveSiteName(canonicalUrl, result.ogSiteName);

    let aiContext: string | null = null;
    let aiCategory: string[] = [];
    let aiTags: string[] = [];
    let visualEntities: string[] = [];
    let ocrText = '';

    if (isAiEnabled) {
      try {
        const candidateSnapshot =
          result.snapshot ||
          (result.card_data as any)?.snapshot ||
          (result.card_data as any)?.media?.[0]?.url ||
          null;

        const aiAnalysis = await analyzeVisualContext({
          url: canonicalUrl,
          title: result.title !== undefined && result.title !== null ? result.title : '',
          description: result.description || '',
          snapshot: candidateSnapshot,
          site_name: siteName,
          type: platform,
          card_data: result.card_data,
          forceRefresh,
          article_content: (result.card_data as any)?.article_content || null,
          page_intent: (result.card_data as any)?.page_intent || null,
        });

        aiContext = aiAnalysis.ai_context;
        aiCategory = aiAnalysis.ai_category || [];
        aiTags = aiAnalysis.ai_tags || [];
        visualEntities = aiAnalysis.visual_entities || [];
        ocrText = aiAnalysis.ocr_text || '';
      } catch (aiErr: any) {
        logger.warn('ExtractController', 'AI Visual analysis failed:', aiErr?.message || aiErr);
      }
    }

    const fullResponse = {
      type: platform,
      url: rawUrl,
      canonical_url: canonicalUrl,
      title: result.title !== undefined ? result.title : null,
      description: result.description || '',
      logo: result.logo || null,
      site_name: siteName,
      card_data: result.card_data,
      ai_context: aiContext,
      ai_category: aiCategory,
      ai_tags: aiTags,
      visual_entities: visualEntities,
      ocr_text: ocrText,
    };

    // Cache full response (30-minute TTL)
    if (!forceRefresh && !html && (result.title || result.description || result.card_data)) {
      extractionCache.set(fullCacheKey, fullResponse);
    }

    res.status(200).json({
      ...fullResponse,
      ...(cached ? { cached: true } : {}),
    });
  } catch (error: any) {
    logger.error('ExtractController', 'Extraction error:', error?.message || error);
    res.status(500).json({ error: error.message || 'Failed to extract metadata' });
  }
};
