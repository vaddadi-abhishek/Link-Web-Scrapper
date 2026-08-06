import { Router, Request, Response } from 'express';
import { extractMetadata } from '../services/extractor';

const router = Router();

/**
 * POST /api/v1/extract
 * Request body: { "url": "https://example.com" }
 */
router.post('/extract', async (req: Request, res: Response): Promise<void> => {
  try {
    const { url } = req.body || {};

    if (!url || typeof url !== 'string' || !url.trim()) {
      res.status(400).json({
        error: "Missing or invalid 'url' string parameter in request body.",
      });
      return;
    }

    const result = await extractMetadata(url);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to extract metadata from provided URL.',
    });
  }
});

export default router;
