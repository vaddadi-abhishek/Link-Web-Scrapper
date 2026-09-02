import { Request, Response } from 'express';
import { dispatchExtraction } from '../services/extractors';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';

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
    const { result, platform } = await dispatchExtraction(url, html);
    const siteName = deriveSiteName(url, result.ogSiteName);

    res.status(200).json({
      type: platform,
      url,
      title: result.title || 'Unknown Title',
      description: result.description || '',
      snapshot: result.snapshot || null,
      logo: result.logo || null,
      site_name: siteName,
      card_data: result.card_data,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to extract metadata' });
  }
};
