import { Router } from 'express';
import { extractMetadataController } from '../controllers/extractController';
import { aiAnalyzeController } from '../controllers/aiController';
import { authMiddleware } from '../middleware/authMiddleware';
import { heavyScrapingRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// Apply authentication and strict rate limiting to heavy extraction and AI endpoints
router.use(authMiddleware);
router.use(heavyScrapingRateLimiter);

/**
 * POST /api/v1/extract
 * Protected master extraction endpoint.
 */
router.post('/extract', extractMetadataController);

/**
 * POST /api/v1/ai-analyze
 * Protected standalone AI Visual Intelligence analysis endpoint.
 */
router.post('/ai-analyze', aiAnalyzeController);

export default router;
