import rateLimit from 'express-rate-limit';

/**
 * Strict rate limiter for authentication routes (login, signup, password reset).
 * Restricts brute-force password guessing, automated credential stuffing, and bot abuse.
 * Window: 15 minutes, Max: 5 requests per IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
  skipSuccessfulRequests: false,
});

/**
 * Standard rate limiter for general authenticated API routes (/api/v1/bookmarks, etc.).
 * Window: 15 minutes, Max: 300 requests per IP.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.',
  },
});

/**
 * Stricter rate limiter for resource-intensive operations (/extract, /ai-analyze, image proxy).
 * Protects Playwright browser instances and Gemini AI quota from exhaustion.
 * Window: 1 minute, Max: 20 requests per IP.
 */
export const heavyScrapingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Rate limit exceeded for extraction/proxy operations. Please slow down.',
  },
});
