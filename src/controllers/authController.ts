import { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabaseClient';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/v1/auth/signup
 */
export async function signupController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    const trimmedUsername = typeof username === 'string' ? username.trim() : '';

    const { data, error } = await supabaseAdmin.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        data: {
          username: trimmedUsername || trimmedEmail.split('@')[0],
        },
      },
    });

    if (error) {
      logger.warn('AuthController', 'Sign up error:', error.message);
      // Return user-friendly error message
      res.status(400).json({ error: error.message || 'Unable to create account.' });
      return;
    }

    const userMetadata = data.user?.user_metadata || {};
    const displayName = userMetadata.username || trimmedUsername || 'User';

    res.status(200).json({
      user: data.user
        ? {
            id: data.user.id,
            email: data.user.email,
            name: displayName,
          }
        : null,
      token: data.session?.access_token || null,
      refreshToken: data.session?.refresh_token || null,
      message: data.session ? undefined : 'Please check your email to confirm registration.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in signup:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * POST /api/v1/auth/login
 * Enforces generic error messages to eliminate user enumeration (CWE-204).
 */
export async function loginController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid email or password.' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error || !data.session || !data.user) {
      logger.warn('AuthController', `Failed login attempt for ${trimmedEmail}`);
      // Security standard: Always return a generic error to prevent account harvesting
      res.status(401).json({ error: 'Invalid email or password.' });
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
      refreshToken: data.session.refresh_token,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in login:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * POST /api/v1/auth/refresh
 * Exchanges a valid refresh token for a fresh access token without logging the user out.
 */
export async function refreshTokenController(req: Request, res: Response): Promise<void> {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ error: 'Missing refresh token.' });
      return;
    }

    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken.trim(),
    });

    if (error || !data.session || !data.user) {
      logger.warn('AuthController', 'Token refresh failed:', error?.message);
      res.status(401).json({ error: 'Session expired. Please log in again.' });
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
      refreshToken: data.session.refresh_token,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in refreshToken:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * POST /api/v1/auth/forgot-password
 * Triggers password reset email via Supabase GoTrue.
 * Returns generic message to prevent account enumeration.
 */
export async function forgotPasswordController(req: Request, res: Response): Promise<void> {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Trigger Supabase password reset email
    await supabaseAdmin.auth.resetPasswordForEmail(trimmedEmail);

    // Generic response: Never disclose whether the email exists
    res.status(200).json({
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in forgotPassword:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user profile using authMiddleware context.
 */
export async function getCurrentUserController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }

    const userMetadata = user.user_metadata || {};
    const displayName =
      userMetadata.username ||
      userMetadata.name ||
      user.email?.split('@')[0] ||
      'User';

    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        name: displayName,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Failed to retrieve profile:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}
