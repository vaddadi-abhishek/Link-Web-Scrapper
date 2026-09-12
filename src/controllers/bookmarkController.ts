import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { dispatchExtraction } from '../services/extractors';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { analyzeVisualContext } from '../services/aiVisualService';
import { canonicalizeUrl } from '../utils/urlFormatter';
import { logger } from '../utils/logger';
import { supabaseAdmin } from '../utils/supabaseClient';
import {
  getOrCreateUserSubscription,
  checkAiCreditEligibility,
  deductOneAiCredit,
} from '../services/subscriptionService';

/**
 * Maps database row to standard frontend Bookmark interface.
 */
function mapBookmarkRow(row: any) {
  const aiCtx = Array.isArray(row.ai_context) ? row.ai_context[0] : row.ai_context;

  // If ai_context record exists for this bookmark, resolve ai_status to 'completed'
  const hasAiContext = Boolean(
    aiCtx && (aiCtx.context || (Array.isArray(aiCtx.ai_tags) && aiCtx.ai_tags.length > 0) || aiCtx.ocr_text)
  );
  const resolvedStatus = hasAiContext ? 'completed' : (row.ai_status || 'pending_manual');

  return {
    id: row.id,
    user_id: row.user_id,
    url: row.url,
    title: row.title || row.url,
    description: row.description || '',
    snapshot: row.snapshot_url || null,
    logo: row.logo_url || null,
    site_name: row.site_name || '',
    type: row.type || 'generic',
    card_data: row.card_data || undefined,
    ai_status: resolvedStatus,
    created_at: row.created_at,
    ai_context: aiCtx?.context || null,
    ai_tags: aiCtx?.ai_tags || [],
    visual_entities: aiCtx?.visual_entities || [],
    ocr_text: aiCtx?.ocr_text || '',
  };
}

/**
 * Helper to check if a completed bookmark already exists for the given URLs across the database.
 */
async function findExistingCompletedBookmarkByUrl(urls: string[]) {
  try {
    const { data } = await supabaseAdmin
      .from('bookmarks')
      .select('*, ai_context(*)')
      .in('url', urls)
      .eq('ai_status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      const ctx = Array.isArray(data.ai_context) ? data.ai_context[0] : data.ai_context;
      if (ctx && (ctx.context || (Array.isArray(ctx.ai_tags) && ctx.ai_tags.length > 0) || ctx.ocr_text)) {
        return { bookmark: data, aiContext: ctx };
      }
    }
  } catch (err: any) {
    logger.warn('BookmarkController', 'Error checking completed bookmark by URL:', err?.message || err);
  }
  return null;
}

/**
 * GET /api/v1/bookmarks
 * Returns all bookmarks for the authenticated user with joined AI context.
 */
export async function getBookmarksController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from('bookmarks')
      .select('*, ai_context(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('BookmarkController', `Failed to fetch bookmarks for ${userId}:`, error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const formatted = (data || []).map(mapBookmarkRow);
    res.status(200).json(formatted);
  } catch (err: any) {
    logger.error('BookmarkController', 'Error in getBookmarks:', err?.message || err);
    res.status(500).json({ error: 'Internal server error while fetching bookmarks.' });
  }
}

/**
 * POST /api/v1/bookmarks
 * Creates a bookmark, scrapes metadata, checks user credits, conditionally runs Gemini AI,
 * and persists directly into Supabase.
 */
export async function createBookmarkController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;
    const rawUrl = req.body?.url;

    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      res.status(400).json({ error: "Missing or invalid 'url' in request body." });
      return;
    }

    const trimmedUrl = rawUrl.trim();
    const isSafe = await validateUrlAgainstSSRF(trimmedUrl);
    if (!isSafe) {
      res.status(400).json({ error: 'Security Error: Invalid or internal URL provided (SSRF Blocked).' });
      return;
    }

    // Deterministic canonicalization: strips tracking parameters (?s=20, ?utm_source...&stkn=..., ?si=...)
    const canonicalUrl = canonicalizeUrl(trimmedUrl);
    const searchUrls = Array.from(new Set([canonicalUrl, trimmedUrl]));

    // 1. User duplicate check: has THIS user already bookmarked this URL?
    const { data: existingUserBm } = await supabase
      .from('bookmarks')
      .select('*, ai_context(*)')
      .eq('user_id', userId)
      .in('url', searchUrls)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingUserBm) {
      logger.info('BookmarkController', `Duplicate URL posted by user ${userId}: ${canonicalUrl}. Returning existing bookmark (0 credits used).`);
      const finalBm = mapBookmarkRow(existingUserBm);
      res.status(200).json({
        ...finalBm,
        already_exists: true,
      });
      return;
    }

    // Read user subscription & credit status
    const sub = await getOrCreateUserSubscription(supabase, userId);

    // Check X-Auto-AI-Context header, fallback to body, fallback to user setting
    const autoAiHeader = req.headers['x-auto-ai-context'];
    let shouldRunAi = sub.auto_ai_context;
    if (autoAiHeader !== undefined) {
      shouldRunAi = String(autoAiHeader).toLowerCase() === 'true';
    } else if (req.body?.auto_ai_context !== undefined) {
      shouldRunAi = Boolean(req.body.auto_ai_context);
    }

    // 2. Global check: has ANY bookmark for this exact canonical URL already completed AI analysis?
    const existingGlobal = await findExistingCompletedBookmarkByUrl(searchUrls);

    let metadataResult: any;
    let platform: string;
    let siteName: string;
    let snapshotUrl: string | null = null;
    let aiStatus: 'completed' | 'pending_manual' | 'no_credits' | 'failed' = 'pending_manual';
    let aiAnalysisResult: any = null;

    if (existingGlobal) {
      const prevBm = existingGlobal.bookmark;
      logger.info('BookmarkController', `Reusing existing analysis for canonical URL: ${canonicalUrl}. 0 Gemini calls, 0 credits deducted.`);
      platform = prevBm.type || 'generic';
      siteName = prevBm.site_name || '';
      snapshotUrl = prevBm.snapshot_url || null;
      metadataResult = {
        title: prevBm.title,
        description: prevBm.description || '',
        logo: prevBm.logo_url || null,
        card_data: prevBm.card_data || null,
      };
      aiStatus = 'completed';
      aiAnalysisResult = {
        ai_context: existingGlobal.aiContext.context || '',
        ai_tags: existingGlobal.aiContext.ai_tags || [],
        visual_entities: existingGlobal.aiContext.visual_entities || [],
        ocr_text: existingGlobal.aiContext.ocr_text || '',
      };
      // NOTE: deductOneAiCredit is SKIPPED! Neither Gemini API nor user credits are consumed.
    } else {
      // Fresh URL: Scrape metadata
      const { result, platform: extractedPlatform } = await dispatchExtraction(canonicalUrl);
      platform = extractedPlatform;
      metadataResult = result;
      siteName = deriveSiteName(canonicalUrl, result.ogSiteName);
      snapshotUrl =
        result.snapshot ||
        (result.card_data as any)?.snapshot ||
        (result.card_data as any)?.media?.[0]?.url ||
        null;

      // Evaluate AI Context creation
      if (!shouldRunAi) {
        // User opted out of auto-AI -> mark as pending_manual (card will show "Generate AI" in 3-dots)
        aiStatus = 'pending_manual';
      } else {
        const { isEligible } = checkAiCreditEligibility(sub);

        if (!isEligible) {
          // Free user with 0 credits left -> skip AI, set badge flag
          aiStatus = 'no_credits';
        } else {
          // Eligible -> Attempt Gemini AI analysis
          try {
            aiAnalysisResult = await analyzeVisualContext({
              url: canonicalUrl,
              title: result.title || '',
              description: result.description || '',
              snapshot: snapshotUrl,
              site_name: siteName,
              type: platform,
              card_data: result.card_data,
              article_content: (result.card_data as any)?.article_content || null,
              page_intent: (result.card_data as any)?.page_intent || null,
            });

            // SUCCESS: Now and ONLY now deduct 1 credit for free tier
            await deductOneAiCredit(supabase, sub);
            aiStatus = 'completed';
          } catch (aiErr: any) {
            logger.warn('BookmarkController', 'Gemini AI generation failed. Preserving user credits:', aiErr?.message);
            aiStatus = 'failed';
          }
        }
      }
    }

    // 3. Insert into bookmarks table with CANONICAL URL
    const { data: bookmarkRow, error: bmError } = await supabase
      .from('bookmarks')
      .insert({
        user_id: userId,
        url: canonicalUrl,
        title: metadataResult.title || trimmedUrl,
        description: metadataResult.description || '',
        snapshot_url: snapshotUrl,
        logo_url: metadataResult.logo || null,
        site_name: siteName,
        type: platform,
        card_data: metadataResult.card_data || null,
        ai_status: aiStatus,
      })
      .select()
      .single();

    if (bmError || !bookmarkRow) {
      logger.error('BookmarkController', 'Failed to insert bookmark into Supabase:', bmError?.message);
      res.status(500).json({ error: bmError?.message || 'Failed to save bookmark.' });
      return;
    }

    // 4. Insert into ai_context table if AI was generated successfully
    let savedAiContext = null;
    if (aiStatus === 'completed' && aiAnalysisResult) {
      const { data: aiRow, error: aiError } = await supabase
        .from('ai_context')
        .insert({
          bookmark_id: bookmarkRow.id,
          user_id: userId,
          context: aiAnalysisResult.ai_context || '',
          ai_tags: aiAnalysisResult.ai_tags || [],
          visual_entities: aiAnalysisResult.visual_entities || [],
          ocr_text: aiAnalysisResult.ocr_text || '',
        })
        .select()
        .single();

      if (aiError) {
        logger.error('BookmarkController', 'Failed to insert ai_context into Supabase:', aiError.message);
      } else {
        savedAiContext = aiRow;
      }
    }

    const finalResponse = mapBookmarkRow({
      ...bookmarkRow,
      ai_context: savedAiContext,
    });

    res.status(201).json(finalResponse);
  } catch (err: any) {
    logger.error('BookmarkController', 'Error creating bookmark:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Internal server error while creating bookmark.' });
  }
}

/**
 * POST /api/v1/bookmarks/:id/generate-ai
 * Manual trigger from 3-dots menu to generate AI context for an existing bookmark.
 */
export async function generateAiForBookmarkController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;
    const bookmarkId = req.params.id;

    if (!bookmarkId) {
      res.status(400).json({ error: 'Missing bookmark ID in URL params.' });
      return;
    }

    // 1. Fetch bookmark
    const { data: bookmark, error: fetchError } = await supabase
      .from('bookmarks')
      .select('*')
      .eq('id', bookmarkId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !bookmark) {
      res.status(404).json({ error: 'Bookmark not found.' });
      return;
    }

    // 2. Check if this canonical URL already has completed AI in the database
    const canonicalBmUrl = canonicalizeUrl(bookmark.url);
    const existingGlobal = await findExistingCompletedBookmarkByUrl([canonicalBmUrl, bookmark.url]);

    if (existingGlobal) {
      logger.info('BookmarkController', `Manual AI: Reusing existing analysis for ${canonicalBmUrl}. 0 credits deducted.`);
      const { data: aiContextRow, error: aiError } = await supabase
        .from('ai_context')
        .upsert(
          {
            bookmark_id: bookmarkId,
            user_id: userId,
            context: existingGlobal.aiContext.context || '',
            ai_tags: existingGlobal.aiContext.ai_tags || [],
            visual_entities: existingGlobal.aiContext.visual_entities || [],
            ocr_text: existingGlobal.aiContext.ocr_text || '',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'bookmark_id' }
        )
        .select()
        .single();

      if (aiError) {
        logger.error('BookmarkController', 'Error saving cached ai_context on manual generate:', aiError.message);
      }

      const { data: updatedBm } = await supabase
        .from('bookmarks')
        .update({ ai_status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', bookmarkId)
        .select()
        .single();

      // Zero credits deducted!
      const response = mapBookmarkRow({
        ...updatedBm,
        ai_context: aiContextRow,
      });

      res.status(200).json(response);
      return;
    }

    // 3. Only if NO existing analysis exists, check subscription & credit eligibility
    const sub = await getOrCreateUserSubscription(supabase, userId);
    const { isEligible, creditsRemaining } = checkAiCreditEligibility(sub);

    if (!isEligible) {
      // Free limit reached -> Update bookmark status and return 402 Payment Required
      await supabase
        .from('bookmarks')
        .update({ ai_status: 'no_credits', updated_at: new Date().toISOString() })
        .eq('id', bookmarkId);

      res.status(402).json({
        error: 'NO_CREDITS_LEFT',
        message: 'No free AI credits remaining for this period.',
        ai_status: 'no_credits',
      });
      return;
    }

    // 3. Run Gemini AI
    try {
      const aiAnalysis = await analyzeVisualContext({
        url: bookmark.url,
        title: bookmark.title || '',
        description: bookmark.description || '',
        snapshot: bookmark.snapshot_url,
        site_name: bookmark.site_name,
        type: bookmark.type,
        card_data: bookmark.card_data,
        article_content: (bookmark.card_data as any)?.article_content || null,
        page_intent: (bookmark.card_data as any)?.page_intent || null,
      });

      // SUCCESS: Deduct 1 credit now
      await deductOneAiCredit(supabase, sub);

      // Save/upsert to ai_context
      const { data: aiContextRow, error: aiError } = await supabase
        .from('ai_context')
        .upsert(
          {
            bookmark_id: bookmarkId,
            user_id: userId,
            context: aiAnalysis.ai_context,
            ai_tags: aiAnalysis.ai_tags || [],
            visual_entities: aiAnalysis.visual_entities || [],
            ocr_text: aiAnalysis.ocr_text || '',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'bookmark_id' }
        )
        .select()
        .single();

      if (aiError) {
        logger.error('BookmarkController', 'Error saving ai_context on manual generate:', aiError.message);
      }

      // Update bookmark ai_status
      const { data: updatedBm } = await supabase
        .from('bookmarks')
        .update({ ai_status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', bookmarkId)
        .select()
        .single();

      const response = mapBookmarkRow({
        ...updatedBm,
        ai_context: aiContextRow,
      });

      res.status(200).json(response);
    } catch (aiErr: any) {
      logger.warn('BookmarkController', 'Manual AI generation failed. Preserving credits:', aiErr?.message);
      await supabase
        .from('bookmarks')
        .update({ ai_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', bookmarkId);

      res.status(500).json({ error: 'AI generation failed. Your credit was not deducted.', ai_status: 'failed' });
    }
  } catch (err: any) {
    logger.error('BookmarkController', 'Error in generateAiForBookmark:', err?.message || err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * DELETE /api/v1/bookmarks/:id
 */
export async function deleteBookmarkController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;
    const bookmarkId = req.params.id;

    const { error } = await supabase
      .from('bookmarks')
      .delete()
      .eq('id', bookmarkId)
      .eq('user_id', userId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error while deleting bookmark.' });
  }
}

/**
 * GET /api/v1/user/plan
 */
export async function getUserPlanController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;

    const sub = await getOrCreateUserSubscription(supabase, userId);
    const { isEligible, isPaid, creditsRemaining } = checkAiCreditEligibility(sub);

    res.status(200).json({
      plan: sub.plan,
      is_paid: isPaid,
      credits_remaining: creditsRemaining,
      credits_limit: sub.ai_credits_limit,
      credits_used: sub.ai_credits_used,
      credits_reset_at: sub.credits_reset_at,
      trial_ends_at: sub.trial_ends_at,
      auto_ai_context: sub.auto_ai_context,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch user plan.' });
  }
}

/**
 * PATCH /api/v1/user/settings
 */
export async function updateUserSettingsController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;
    const { auto_ai_context } = req.body;

    if (auto_ai_context === undefined) {
      res.status(400).json({ error: "Missing 'auto_ai_context' in body." });
      return;
    }

    const { data, error } = await supabase
      .from('user_subscriptions')
      .update({
        auto_ai_context: Boolean(auto_ai_context),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update user settings.' });
  }
}
