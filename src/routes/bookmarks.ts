import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getBookmarksController,
  createBookmarkController,
  generateAiForBookmarkController,
  deleteBookmarkController,
  getUserPlanController,
  updateUserSettingsController,
} from '../controllers/bookmarkController';

const router = Router();

// Apply authentication middleware to all bookmark and user routes
router.use(authMiddleware);

// Bookmark CRUD & AI Triggers
router.get('/bookmarks', getBookmarksController);
router.post('/bookmarks', createBookmarkController);
router.post('/bookmarks/:id/generate-ai', generateAiForBookmarkController);
router.delete('/bookmarks/:id', deleteBookmarkController);

// User Plan & Preferences
router.get('/user/plan', getUserPlanController);
router.patch('/user/settings', updateUserSettingsController);

export default router;
