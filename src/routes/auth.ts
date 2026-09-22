import { Router } from 'express';
import {
  signupController,
  loginController,
  refreshTokenController,
  forgotPasswordController,
  getCurrentUserController,
} from '../controllers/authController';
import { authRateLimiter } from '../middleware/rateLimiter';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

// Rate-limited authentication endpoints
router.post('/signup', authRateLimiter, signupController);
router.post('/login', authRateLimiter, loginController);
router.post('/refresh', authRateLimiter, refreshTokenController);
router.post('/forgot-password', authRateLimiter, forgotPasswordController);

// Authenticated session check
router.get('/me', authMiddleware, getCurrentUserController);

export default router;
