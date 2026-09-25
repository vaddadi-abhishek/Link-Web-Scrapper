import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Strict rate limiter for authentication routes (login, signup, password reset).
 * Restricts brute-force password guessing, automated credential stuffing, and bot abuse.
 * Window: 15 minutes, Max: 15 failed requests per IP (skips successful attempts).
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 requests per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

/**
 * Strict rate limiter for OTP verification endpoints.
 * Defends against brute-force token enumeration attacks.
 * Window: 5 minutes, Max: 10 attempts per IP.
 */
export const otpRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'Too many verification attempts. Please wait a few minutes before trying again.',
  },
});

/**
 * Anti-spam rate limiter for OTP resend requests.
 * Defends against email bombing, quota exhaustion, and griefing.
 * Window: 15 minutes, Max: 5 resend attempts per IP.
 */
export const resendOtpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: {
    error: 'Too many verification code requests. Please wait 15 minutes before requesting another code.',
  },
});

/**
 * Key generator that throttles authenticated users by user ID,
 * falling back to client IP for unauthenticated requests with IPv6 normalization.
 */
const userOrIpKey = (req: any): string => {
  if (req.user?.id) {
    return req.user.id;
  }
  return ipKeyGenerator(req.ip || '127.0.0.1');
};

/**
 * Standard rate limiter for general authenticated API routes (/api/v1/bookmarks, etc.).
 * Window: 15 minutes, Max: 300 requests per user/IP.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: userOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.',
  },
});

/**
 * Stricter rate limiter for resource-intensive operations (/extract, /ai-analyze, image proxy).
 * Protects Playwright browser instances and Gemini AI quota from exhaustion.
 * Window: 1 minute, Max: 20 requests per user/IP.
 */
export const heavyScrapingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  keyGenerator: userOrIpKey,
  validate: { keyGeneratorIpFallback: false, xForwardedForHeader: false },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Rate limit exceeded for extraction/proxy operations. Please slow down.',
  },
});
