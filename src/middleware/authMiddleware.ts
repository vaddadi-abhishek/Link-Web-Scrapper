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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header.' });
      return;
    }

    const token = authHeader.split(' ')[1]?.trim();
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Bearer token is empty.' });
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
  } catch (err: any) {
    logger.error('AuthMiddleware', 'Authentication unexpected error:', err?.message || err);
    res.status(500).json({ error: 'Internal auth verification error.' });
  }
}
