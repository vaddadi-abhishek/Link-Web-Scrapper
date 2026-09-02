import { Router } from 'express';
import { imageProxyController } from '../controllers/proxyController';

const router = Router();

/**
 * GET /api/v1/proxy-image
 * Proxies image requests to bypass scraper protections (e.g. Facebook)
 * Usage: /api/v1/proxy-image?url=ENCODED_IMAGE_URL
 */
router.get('/proxy-image', imageProxyController);

export default router;
