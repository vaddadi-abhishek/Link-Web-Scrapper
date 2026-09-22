import { Router } from 'express';
import { imageProxyController } from '../controllers/proxyController';
import { heavyScrapingRateLimiter } from '../middleware/rateLimiter';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

/**
 * GET /api/v1/proxy-image
 * Proxies image requests to bypass scraper protections (e.g. Facebook, Instagram)
 * Usage: /api/v1/proxy-image?url=ENCODED_IMAGE_URL
 */
router.get('/proxy-image', authMiddleware, heavyScrapingRateLimiter, imageProxyController);

export default router;
