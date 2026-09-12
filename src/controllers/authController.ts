import { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabaseClient';
import { logger } from '../utils/logger';

/**
 * POST /api/v1/auth/signup
 */
export async function signupController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, username } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          username: (username || '').trim() || email.trim().split('@')[0],
        },
      },
    });

    if (error) {
      logger.warn('AuthController', 'Sign up error:', error.message);
      res.status(400).json({ error: error.message });
      return;
    }

    const userMetadata = data.user?.user_metadata || {};
    const displayName = userMetadata.username || (username || '').trim() || 'User';

    res.status(200).json({
      user: data.user
        ? {
            id: data.user.id,
            email: data.user.email,
            name: displayName,
          }
        : null,
      token: data.session?.access_token || null,
      message: data.session ? undefined : 'Please check your email to confirm registration.',
    });
  } catch (err: any) {
    logger.error('AuthController', 'Unexpected error in signup:', err?.message || err);
    res.status(500).json({ error: 'Internal server error during sign up.' });
  }
}

/**
 * POST /api/v1/auth/login
 */
export async function loginController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      logger.warn('AuthController', 'Login error:', error.message);
      res.status(401).json({ error: error.message });
      return;
    }

    const userMetadata = data.user?.user_metadata || {};
    const displayName =
      userMetadata.username ||
      userMetadata.name ||
      data.user?.email?.split('@')[0] ||
      'User';

    res.status(200).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        name: displayName,
      },
      token: data.session.access_token,
    });
  } catch (err: any) {
    logger.error('AuthController', 'Unexpected error in login:', err?.message || err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
}

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user profile based on Bearer token.
 */
export async function getCurrentUserController(req: Request, res: Response): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }

    const token = authHeader.split(' ')[1]?.trim();
    if (!token) {
      res.status(401).json({ error: 'Token missing.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Session expired or invalid.' });
      return;
    }

    const userMetadata = data.user.user_metadata || {};
    const displayName =
      userMetadata.username ||
      userMetadata.name ||
      data.user.email?.split('@')[0] ||
      'User';

    res.status(200).json({
      user: {
        id: data.user.id,
        email: data.user.email,
        name: displayName,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to verify session.' });
  }
}
