import { Router } from 'express';
import { extractMetadataController } from '../controllers/extractController';

const router = Router();

/**
 * POST /api/v1/extract
 * Master extraction endpoint.
 * Detects URL and formats card_data dynamically depending on the platform.
 */
router.post('/extract', extractMetadataController);

export default router;
