import { Request, Response } from 'express';
import { supabaseAdmin, supabasePublic } from '../utils/supabaseClient';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { validateEmail } from '../utils/emailValidator';

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

/**
 * POST /api/v1/auth/signup
 * Blocks temporary/disposable emails and registers user with Supabase GoTrue OTP confirmation.
 */
export async function signupController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    // Comprehensive email validation (syntax, length, RFC compliance, and live disposable domain threat intelligence)
    const emailValidation = await validateEmail(email);
    if (!emailValidation.isValid) {
      res.status(400).json({ error: emailValidation.error });
      return;
    }

    const trimmedEmail = emailValidation.normalizedEmail;

    if (!PASSWORD_REGEX.test(password)) {
      res.status(400).json({
        error: 'Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, and one number.',
      });
      return;
    }

    const trimmedUsername = typeof username === 'string' ? username.trim() : '';

    // Use supabasePublic with ANON_KEY so GoTrue sends the confirmation OTP / verification email
    const { data, error } = await supabasePublic.auth.signUp({
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
      res.status(400).json({ error: error.message || 'Unable to create account. Please check your details and try again.' });
      return;
    }

    // If confirmation is required, Supabase does not return a session immediately
    if (!data.session) {
      res.status(200).json({
        requireVerification: true,
        email: trimmedEmail,
        message: 'A 6-digit verification code has been sent to your email. Please enter it to complete registration.',
      });
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
      requireVerification: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in signup:', message);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * POST /api/v1/auth/login
 * Enforces generic error messages to eliminate user enumeration (CWE-204),
 * and catches unconfirmed emails to prompt OTP entry.
 */
export async function loginController(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid email or password.' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();

    const { data, error } = await supabasePublic.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error) {
      // Check if user is registered but has unconfirmed email
      if (error.message?.toLowerCase().includes('email not confirmed')) {
        logger.warn('AuthController', `Login attempt for unconfirmed email: ${trimmedEmail}`);
        res.status(403).json({
          error: 'Please verify your email address to log in.',
          requireVerification: true,
          email: trimmedEmail,
        });
        return;
      }

      logger.warn('AuthController', `Failed login attempt for ${trimmedEmail}`);
      // Security standard: Always return a generic error to prevent account harvesting
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (!data.session || !data.user) {
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
 * POST /api/v1/auth/verify-otp
 * Verifies a 6-digit confirmation token.
 * Validates token structure, marks email confirmed in Supabase, and returns authenticated session.
 */
export async function verifyOtpController(req: Request, res: Response): Promise<void> {
  try {
    const { email, token, type = 'signup' } = req.body;

    if (!email || !token || typeof email !== 'string' || typeof token !== 'string') {
      res.status(400).json({ error: 'Email and verification code are required.' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedToken = token.trim();

    // Verify token format (strict 6-digit numeric pattern)
    if (!/^\d{6}$/.test(trimmedToken)) {
      res.status(400).json({ error: 'Verification code must be exactly 6 digits.' });
      return;
    }

    const { data, error } = await supabasePublic.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedToken,
      type: type === 'email' ? 'email' : 'signup',
    });

    if (error || !data.user) {
      logger.warn('AuthController', `OTP verification failed for ${trimmedEmail}:`, error?.message);
      res.status(400).json({
        error: error?.message || 'Invalid or expired verification code. Please check the code and try again.',
      });
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
      token: data.session?.access_token || null,
      refreshToken: data.session?.refresh_token || null,
      message: 'Email successfully verified.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in verifyOtp:', message);
    res.status(500).json({ error: 'An unexpected error occurred during verification. Please try again.' });
  }
}

/**
 * POST /api/v1/auth/resend-otp
 * Re-sends verification code to the user's email.
 * Re-checks disposable email blocklist and enforces rate limits.
 */
export async function resendOtpController(req: Request, res: Response): Promise<void> {
  try {
    const { email, type = 'signup' } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }

    const emailValidation = await validateEmail(email);
    if (!emailValidation.isValid) {
      res.status(400).json({ error: emailValidation.error });
      return;
    }

    const trimmedEmail = emailValidation.normalizedEmail;

    const { error } = await supabasePublic.auth.resend({
      email: trimmedEmail,
      type: type === 'email_change' ? 'email_change' : 'signup',
    });

    if (error) {
      logger.warn('AuthController', `Resend OTP failed for ${trimmedEmail}:`, error.message);
      if (error.status === 429 || error.message.toLowerCase().includes('rate')) {
        res.status(429).json({ error: 'Please wait before requesting another verification code.' });
        return;
      }
    }

    res.status(200).json({
      message: 'If an account exists with this email, a new 6-digit verification code has been sent.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('AuthController', 'Unexpected error in resendOtp:', message);
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
