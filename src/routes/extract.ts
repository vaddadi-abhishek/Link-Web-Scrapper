import { Router } from 'express';
import { extractMetadataController } from '../controllers/extractController';
import { aiAnalyzeController } from '../controllers/aiController';

const router = Router();

/**
 * POST /api/v1/extract
 * Master extraction endpoint.
 * Detects URL, extracts platform metadata & runs AI Visual Intelligence analysis.
 */
router.post('/extract', extractMetadataController);

/**
 * POST /api/v1/ai-analyze
 * Standalone AI Visual Intelligence analysis endpoint for re-analyzing or deep processing.
 */
router.post('/ai-analyze', aiAnalyzeController);

export default router;
