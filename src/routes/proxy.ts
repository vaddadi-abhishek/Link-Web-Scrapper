import { Router } from 'express';
import { imageProxyController } from '../controllers/proxyController';
import { heavyScrapingRateLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * GET /api/v1/proxy-image
 * Proxies image requests to bypass scraper protections (e.g. Facebook, Instagram)
 * Usage: /api/v1/proxy-image?url=ENCODED_IMAGE_URL
 */
router.get('/proxy-image', heavyScrapingRateLimiter, imageProxyController);

export default router;
