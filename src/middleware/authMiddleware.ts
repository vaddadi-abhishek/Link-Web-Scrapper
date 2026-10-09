import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin, getAuthenticatedSupabaseClient } from '../utils/supabaseClient';
import { SupabaseClient, User } from '@supabase/supabase-js';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: User;
  token?: string;
  supabase?: SupabaseClient;
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1]?.trim() || '';
    } else if (typeof req.query.token === 'string' && req.query.token.trim()) {
      token = req.query.token.trim();
    }

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Missing or invalid authentication token.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      logger.warn('AuthMiddleware', 'Invalid or expired user token:', error?.message);
      res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
      return;
    }

    req.user = data.user;
    req.token = token;
    req.supabase = getAuthenticatedSupabaseClient(token);

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthMiddleware', 'Authentication unexpected error:', message);
    res.status(500).json({ error: 'Internal auth verification error.' });
  }
}
