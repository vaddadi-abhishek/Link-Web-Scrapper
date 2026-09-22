import { Request, Response } from 'express';
import { analyzeVisualContext, AIVisualAnalysisInput } from '../services/aiVisualService';
import { logger } from '../utils/logger';

export const aiAnalyzeController = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: AIVisualAnalysisInput = req.body;

    if (!payload || (!payload.url && !payload.title && !payload.snapshot)) {
      res.status(400).json({ error: 'Missing required payload fields (url, title, or snapshot).' });
      return;
    }

    const result = await analyzeVisualContext(payload);
    res.status(200).json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('AIController', 'AI analysis failed:', message);
    res.status(500).json({ error: 'Failed to perform AI visual analysis. Please try again later.' });
  }
};
