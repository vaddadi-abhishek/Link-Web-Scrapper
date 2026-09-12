import { Router } from 'express';
import {
  signupController,
  loginController,
  getCurrentUserController,
} from '../controllers/authController';

const router = Router();

router.post('/signup', signupController);
router.post('/login', loginController);
router.get('/me', getCurrentUserController);

export default router;
