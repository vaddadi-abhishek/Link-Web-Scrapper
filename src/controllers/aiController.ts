import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { analyzeVisualContext, AIVisualAnalysisInput } from '../services/aiVisualService';
import { reserveUserCredit, refundUserCredit } from '../services/subscriptionService';
import { logger } from '../utils/logger';

export const aiAnalyzeController = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const payload: AIVisualAnalysisInput = req.body;

    if (!payload || (!payload.url && !payload.title && !payload.snapshot)) {
      res.status(400).json({ error: 'Missing required payload fields (url, title, or snapshot).' });
      return;
    }

    const supabase = req.supabase!;
    const userId = req.user!.id;

    // Atomically reserve 1 credit before invoking Gemini API
    const reservation = await reserveUserCredit(supabase, userId);
    if (!reservation.success) {
      res.status(402).json({
        error: 'NO_CREDITS_LEFT',
        message: 'No free AI credits remaining for this period.',
      });
      return;
    }

    try {
      const result = await analyzeVisualContext(payload);
      res.status(200).json(result);
    } catch (aiErr: unknown) {
      // Refund reserved credit if analysis fails
      await refundUserCredit(supabase, userId);
      throw aiErr;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('AIController', 'AI analysis failed:', message);
    res.status(500).json({ error: 'Failed to perform AI visual analysis. Please try again later.' });
  }
};
