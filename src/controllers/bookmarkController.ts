import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { dispatchExtraction, ExtractionResult, sanitizeMetrics } from '../services/extractors';
import { ArticleData } from '../services/extractors/types';
import { deriveSiteName } from '../utils/siteName';
import { validateUrlAgainstSSRF } from '../utils/ssrfValidator';
import { analyzeVisualContext, AIVisualAnalysisResult } from '../services/aiVisualService';
import { canonicalizeUrl, isResolvableShortlink, resolveShortlink, extractLinkedInPostId } from '../utils/urlFormatter';
import { extractTwitterProfileUsername } from '../services/extractors/twitter';
import { logger } from '../utils/logger';
import { supabaseAdmin } from '../utils/supabaseClient';
import {
  getOrCreateUserSubscription,
  checkAiCreditEligibility,
  reserveUserCredit,
  refundUserCredit,
} from '../services/subscriptionService';

export interface AiContextDbRow {
  context?: string | null;
  ai_category?: string[] | null;
  ai_tags?: string[] | null;
  visual_entities?: string[] | null;
  ocr_text?: string | null;
}

export interface BookmarkDbRow {
  id: string;
  user_id: string;
  url: string;
  title?: string | null;
  description?: string | null;
  snapshot_url?: string | null;
  logo_url?: string | null;
  site_name?: string | null;
  type?: string | null;
  card_data?: Record<string, unknown> | null;
  is_article?: boolean | null;
  ai_status?: 'completed' | 'pending_manual' | 'no_credits' | 'failed' | string;
  created_at: string;
  ai_context?: AiContextDbRow | AiContextDbRow[] | null;
}

export interface BookmarkResponse {
  id: string;
  user_id: string;
  url: string;
  title: string;
  description: string | null;
  logo: string | null;
  snapshot_url?: string | null;
  snapshot?: string | null;
  site_name: string;
  type: string;
  card_data?: Record<string, unknown>;
  is_article?: boolean;
  ai_status: string;
  created_at: string;
  ai_context: string | null;
  ai_category: string[];
  ai_tags: string[];
  visual_entities: string[];
  ocr_text: string;
  already_exists?: boolean;
}

/**
 * Maps database row to standard frontend Bookmark interface.
 */
function mapBookmarkRow(row: BookmarkDbRow): BookmarkResponse {
  const aiCtx = Array.isArray(row.ai_context) ? row.ai_context[0] : row.ai_context;

  // If ai_context record exists for this bookmark, resolve ai_status to 'completed'
  const hasAiContext = Boolean(
    aiCtx && (
      aiCtx.context ||
      (Array.isArray(aiCtx.ai_category) && aiCtx.ai_category.length > 0) ||
      (Array.isArray(aiCtx.ai_tags) && aiCtx.ai_tags.length > 0) ||
      aiCtx.ocr_text
    )
  );
  const resolvedStatus = hasAiContext ? 'completed' : (row.ai_status || 'pending_manual');

  let cardData: Record<string, unknown> | undefined = undefined;
  if (row.card_data) {
    if (typeof row.card_data === 'string') {
      try {
        cardData = JSON.parse(row.card_data);
      } catch {
        cardData = undefined;
      }
    } else if (typeof row.card_data === 'object' && row.card_data !== null) {
      cardData = { ...row.card_data };
    }
  }

  const resolvedSnapshotUrl =
    row.snapshot_url ||
    (typeof cardData?.snapshot === 'string' ? cardData.snapshot : null);

  if (cardData && !cardData.snapshot && resolvedSnapshotUrl) {
    cardData.snapshot = resolvedSnapshotUrl;
  }
  if (!cardData && resolvedSnapshotUrl) {
    cardData = { snapshot: resolvedSnapshotUrl };
  }

  return {
    id: row.id,
    user_id: row.user_id,
    url: row.url,
    title: row.title || row.url,
    description: row.description && row.description.trim() ? row.description.trim() : null,
    logo: row.logo_url || null,
    snapshot_url: resolvedSnapshotUrl,
    snapshot: resolvedSnapshotUrl,
    site_name: row.site_name || '',
    type: row.type || 'generic',
    card_data: cardData,
    is_article: Boolean(row.is_article),
    ai_status: resolvedStatus,
    created_at: row.created_at,
    ai_context: aiCtx?.context || null,
    ai_category: Array.isArray(aiCtx?.ai_category) ? aiCtx.ai_category : [],
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
      if (
        ctx &&
        (ctx.context ||
          (Array.isArray(ctx.ai_category) && ctx.ai_category.length > 0) ||
          (Array.isArray(ctx.ai_tags) && ctx.ai_tags.length > 0) ||
          ctx.ocr_text)
      ) {
        return { bookmark: data as BookmarkDbRow, aiContext: ctx as AiContextDbRow };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('BookmarkController', 'Error checking completed bookmark by URL:', message);
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

    const limitQuery = req.query.limit ? parseInt(req.query.limit as string, 10) : 250;
    const offsetQuery = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const safeLimit = Math.min(Math.max(1, isNaN(limitQuery) ? 250 : limitQuery), 500);
    const safeOffset = Math.max(0, isNaN(offsetQuery) ? 0 : offsetQuery);

    const { data, error } = await supabase
      .from('bookmarks')
      .select('*, ai_context(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);

    if (error) {
      logger.error('BookmarkController', `Failed to fetch bookmarks for ${userId}:`, error.message);
      res.status(500).json({ error: 'Failed to retrieve bookmarks.' });
      return;
    }

    const rows = (data || []) as BookmarkDbRow[];
    for (const row of rows) {
      const isXProfile = extractTwitterProfileUsername(row.url);
      if (isXProfile) {
        const cd = (row.card_data as Record<string, unknown>) || {};
        const metrics = (cd.metrics as Record<string, unknown>) || {};
        if (!cd.banner_url || !metrics.followers) {
          // Trigger background enrichment for any profile missing complete metadata
          dispatchExtraction(row.url, undefined, { forceRefresh: true }).then(async ({ result }) => {
            if (result.card_data) {
              Promise.resolve(
                supabaseAdmin.from('bookmarks').update({
                  card_data: result.card_data,
                  description: (result.description && result.description.trim()) ? result.description.trim() : null,
                  title: result.title || row.title,
                }).eq('id', row.id)
              ).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }

    const formatted = rows.map(mapBookmarkRow);
    res.status(200).json(formatted);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error in getBookmarks:', message);
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
    if (trimmedUrl.length > 2048) {
      res.status(400).json({ error: 'URL exceeds maximum permitted length of 2048 characters.' });
      return;
    }
    // Resolve shortlinks (e.g. reddit.com/r/.../s/..., pin.it/...) to their true destination URL
    let effectiveUrl = trimmedUrl;
    if (isResolvableShortlink(trimmedUrl)) {
      effectiveUrl = await resolveShortlink(trimmedUrl);
    }

    // Deterministic canonicalization: strips tracking parameters, platform prefixes, trailing text
    const canonicalUrl = canonicalizeUrl(effectiveUrl) || effectiveUrl;

    const isSafe = await validateUrlAgainstSSRF(canonicalUrl);
    if (!isSafe) {
      res.status(400).json({ error: 'Security Error: Invalid or internal URL provided (SSRF Blocked).' });
      return;
    }

    // Build comprehensive search list to catch canonical, effective, trimmed, and platform variations
    const searchUrls = Array.from(new Set([
      canonicalUrl,
      effectiveUrl,
      trimmedUrl,
      canonicalUrl.replace('https://x.com', 'https://twitter.com'),
      canonicalUrl.replace('https://twitter.com', 'https://x.com'),
      canonicalUrl.replace('https://www.linkedin.com', 'https://linkedin.com'),
      canonicalUrl.replace('https://linkedin.com', 'https://www.linkedin.com'),
      canonicalUrl + '/',
      canonicalUrl.replace('https://www.linkedin.com', 'https://linkedin.com') + '/',
      canonicalUrl.replace('/reel/', '/reels/'),
      canonicalUrl.replace('/reels/', '/reel/'),
      canonicalUrl.replace('/p/', '/reel/'),
      canonicalUrl.replace('/reel/', '/p/'),
    ])).filter(Boolean);

    const linkedInPostId = extractLinkedInPostId(canonicalUrl) || extractLinkedInPostId(effectiveUrl) || extractLinkedInPostId(trimmedUrl);
    if (linkedInPostId) {
      searchUrls.push(
        `https://www.linkedin.com/feed/update/urn:li:activity:${linkedInPostId}`,
        `https://www.linkedin.com/feed/update/urn:li:activity:${linkedInPostId}/`,
        `https://www.linkedin.com/feed/update/urn:li:share:${linkedInPostId}`,
        `https://www.linkedin.com/feed/update/urn:li:share:${linkedInPostId}/`
      );
    }

    // 1. User duplicate check: has THIS user already bookmarked this URL?
    let { data: existingUserBm } = await supabase
      .from('bookmarks')
      .select('*, ai_context(*)')
      .eq('user_id', userId)
      .in('url', searchUrls)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 1b. Fallback check for existing LinkedIn posts:
    // If exact searchUrls didn't match, check if user has a bookmark containing the same numeric post ID
    if (!existingUserBm && linkedInPostId) {
      const { data: candidateBms } = await supabase
        .from('bookmarks')
        .select('*, ai_context(*)')
        .eq('user_id', userId)
        .ilike('url', `%${linkedInPostId}%`)
        .order('created_at', { ascending: false })
        .limit(1);

      if (candidateBms && candidateBms.length > 0) {
        existingUserBm = candidateBms[0];
      }
    }

    // 1c. Backward-compatibility check: If user saved a shortlink (e.g. lnkd.in) prior to this fix,
    // resolve any shortlink bookmarks the user has to see if they point to this same canonical URL or post ID
    if (!existingUserBm && (trimmedUrl.includes('linkedin.com') || trimmedUrl.includes('lnkd.in'))) {
      const { data: shortlinkBms } = await supabase
        .from('bookmarks')
        .select('*, ai_context(*)')
        .eq('user_id', userId)
        .ilike('url', '%lnkd.in%')
        .order('created_at', { ascending: false })
        .limit(10);

      if (shortlinkBms && shortlinkBms.length > 0) {
        for (const bm of shortlinkBms) {
          try {
            const resolved = await resolveShortlink(bm.url);
            const canonicalResolved = canonicalizeUrl(resolved);
            if (
              canonicalResolved === canonicalUrl ||
              (linkedInPostId && extractLinkedInPostId(resolved) === linkedInPostId)
            ) {
              existingUserBm = bm;
              break;
            }
          } catch {}
        }
      }
    }

    if (existingUserBm) {
      const isXProfile = extractTwitterProfileUsername(canonicalUrl);
      const existingCardData = existingUserBm.card_data as Record<string, unknown> | null;
      const existingMetrics = (existingCardData?.metrics as Record<string, unknown>) || {};
      const isMissingXProfileData = isXProfile && (!existingCardData?.is_profile || (!existingCardData?.banner_url && !existingMetrics.followers));

      if (isMissingXProfileData) {
        logger.info('BookmarkController', `Existing X profile bookmark ${canonicalUrl} has stale card_data. Upgrading to full profile metadata...`);
        try {
          const { result: freshResult } = await dispatchExtraction(canonicalUrl, undefined, { forceRefresh: true });
          const freshCardData = freshResult.card_data ? { ...(freshResult.card_data as Record<string, unknown>) } : null;
          const freshDesc = (freshResult.description && freshResult.description.trim()) ? freshResult.description.trim() : null;

          if (freshCardData) {
            await supabase
              .from('bookmarks')
              .update({
                card_data: freshCardData,
                description: freshDesc,
                title: freshResult.title || existingUserBm.title,
              })
              .eq('id', existingUserBm.id);

            existingUserBm.card_data = freshCardData;
            existingUserBm.description = freshDesc;
            if (freshResult.title) existingUserBm.title = freshResult.title;
          }
        } catch (enrichErr) {
          logger.warn('BookmarkController', 'Failed to enrich stale X profile bookmark:', enrichErr);
        }
      }

      logger.info('BookmarkController', `Duplicate URL posted by user ${userId}: ${canonicalUrl}. Returning existing bookmark (0 credits used).`);
      const finalBm = mapBookmarkRow(existingUserBm as BookmarkDbRow);
      res.status(200).json({
        ...finalBm,
        already_exists: true,
      });
      return;
    }

    // 2. Dispatch platform extraction with canonical URL (fast pure metadata scraping)
    const requestHtml = typeof req.body?.html === 'string' && req.body.html.trim() ? req.body.html.trim() : undefined;
    const { result, platform: extractedPlatform } = await dispatchExtraction(canonicalUrl, requestHtml);
    const platform = (result as ExtractionResult).type || extractedPlatform;
    const metadataResult = result as ExtractionResult;
    const siteName = deriveSiteName(canonicalUrl, result.ogSiteName);

    let extractedArticle = (result as ExtractionResult).article || null;

    const clientCardData = typeof req.body?.card_data === 'object' && req.body?.card_data !== null
      ? (req.body.card_data as Record<string, unknown>)
      : null;
    const clientSnapshot = typeof req.body?.snapshot_url === 'string' && req.body.snapshot_url.trim()
      ? req.body.snapshot_url.trim()
      : null;
    const clientTitle = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : null;
    const clientDescription = typeof req.body?.description === 'string' && req.body.description.trim()
      ? req.body.description.trim()
      : null;

    const cardDataObj = typeof result.card_data === 'object' && result.card_data !== null
      ? (result.card_data as Record<string, unknown>)
      : {};

    // Synthesize ArticleData if article_content is present in card_data but article was not set at root
    if (!extractedArticle && typeof cardDataObj.article_content === 'string' && cardDataObj.article_content.trim()) {
      const artText = cardDataObj.article_content.trim();
      const words = typeof cardDataObj.word_count === 'number' ? cardDataObj.word_count : artText.split(/\s+/).filter(Boolean).length;
      const readingTime = typeof cardDataObj.reading_time_minutes === 'number' ? cardDataObj.reading_time_minutes : Math.max(1, Math.ceil(words / 200));
      extractedArticle = {
        content_html: `<p>${artText.replace(/\n\n/g, '</p><p>')}</p>`,
        content_markdown: artText,
        content_text: artText,
        byline: (cardDataObj.author as { name?: string })?.name || null,
        excerpt: metadataResult.description || null,
        word_count: words,
        reading_time_minutes: readingTime,
      };
    }

    const isArticle = Boolean(extractedArticle);

    // Merge server extraction with client-provided data (e.g. from Mindspace browser extension)
    const effectiveCardData = clientCardData && Object.keys(clientCardData).length > 0
      ? { ...cardDataObj, ...clientCardData }
      : cardDataObj;

    if ('metrics' in effectiveCardData || 'metrics' in cardDataObj) {
      effectiveCardData.metrics = sanitizeMetrics(effectiveCardData.metrics as Record<string, unknown>);
    }

    const effectiveMediaList = Array.isArray(effectiveCardData.media) ? (effectiveCardData.media as Array<{ url?: string }>) : [];
    const snapshotUrl =
      clientSnapshot ||
      (typeof effectiveCardData.snapshot === 'string' ? effectiveCardData.snapshot : null) ||
      (typeof effectiveCardData.video_thumbnail === 'string' ? effectiveCardData.video_thumbnail : null) ||
      (effectiveMediaList[0]?.url || null);

    const effectiveTitle = clientTitle || metadataResult.title || trimmedUrl;
    const effectiveDescription = clientDescription || (metadataResult.description && metadataResult.description.trim() ? metadataResult.description.trim() : null);

    // Initial ai_status is pending_manual; AI context is decoupled and triggered via /bookmarks/:id/ai-context
    const aiStatus = 'pending_manual';

    // 3. Insert into bookmarks table with CANONICAL URL
    const { data: bookmarkRow, error: bmError } = await supabase
      .from('bookmarks')
      .insert({
        user_id: userId,
        url: canonicalUrl,
        title: effectiveTitle,
        description: effectiveDescription,
        snapshot_url: snapshotUrl,
        logo_url: metadataResult.logo || null,
        site_name: siteName,
        type: platform,
        card_data: effectiveCardData && Object.keys(effectiveCardData).length > 0 ? effectiveCardData : null,
        is_article: isArticle,
        ai_status: aiStatus,
      })
      .select()
      .single();

    if (bmError || !bookmarkRow) {
      logger.error('BookmarkController', 'Failed to insert bookmark into Supabase:', bmError?.message);
      res.status(500).json({ error: 'Failed to save bookmark.' });
      return;
    }

    // 4. Insert into articles table if article was extracted
    if (isArticle && extractedArticle) {
      const { error: articleError } = await supabase
        .from('articles')
        .insert({
          bookmark_id: bookmarkRow.id,
          user_id: userId,
          content_html: extractedArticle.content_html,
          content_markdown: extractedArticle.content_markdown || null,
          word_count: extractedArticle.word_count,
          reading_time_minutes: extractedArticle.reading_time_minutes,
        });

      if (articleError) {
        logger.error('BookmarkController', 'Failed to insert article into Supabase:', articleError.message);
      }
    }

    const finalResponse = mapBookmarkRow(bookmarkRow as BookmarkDbRow);
    res.status(201).json(finalResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error creating bookmark:', message);
    res.status(500).json({ error: 'Internal server error while creating bookmark.' });
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
            ai_category: existingGlobal.aiContext.ai_category || [],
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
        ...(updatedBm as BookmarkDbRow),
        ai_context: aiContextRow as AiContextDbRow,
      });

      res.status(200).json(response);
      return;
    }

    // 3. Atomically reserve 1 credit before invoking Gemini to eliminate TOCTOU race conditions
    const reservation = await reserveUserCredit(supabase, userId);

    if (!reservation.success) {
      // Free limit reached or reservation failed -> Update bookmark status and return 402 Payment Required
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

    // 4. Run Gemini AI
    try {
      let parsedCardData: Record<string, unknown> = {};
      if (bookmark.card_data) {
        if (typeof bookmark.card_data === 'string') {
          try {
            parsedCardData = JSON.parse(bookmark.card_data);
          } catch {}
        } else if (typeof bookmark.card_data === 'object' && bookmark.card_data !== null) {
          parsedCardData = bookmark.card_data as Record<string, unknown>;
        }
      }

      const mediaList = Array.isArray(parsedCardData.media) ? (parsedCardData.media as Array<{ url?: string }>) : [];
      const candidateSnapshot =
        bookmark.snapshot_url ||
        (typeof parsedCardData.snapshot === 'string' ? parsedCardData.snapshot : null) ||
        (mediaList[0]?.url || null);

      let articleContent = typeof parsedCardData.article_content === 'string' ? parsedCardData.article_content : null;
      if (!articleContent && bookmark.is_article) {
        try {
          const { data: art } = await supabase
            .from('articles')
            .select('content_html')
            .eq('bookmark_id', bookmarkId)
            .maybeSingle();
          if (art?.content_html) {
            articleContent = art.content_html.replace(/<[^>]*>/g, ' ').slice(0, 5000);
          }
        } catch {}
      }

      const aiAnalysis = await analyzeVisualContext({
        url: bookmark.url,
        title: bookmark.title || '',
        description: bookmark.description || '',
        snapshot: candidateSnapshot,
        site_name: bookmark.site_name,
        type: bookmark.type,
        card_data: parsedCardData,
        article_content: articleContent,
        page_intent: typeof parsedCardData.page_intent === 'string' ? parsedCardData.page_intent : null,
      });

      // Save/upsert to ai_context (Credit was already atomically reserved)
      const { data: aiContextRow, error: aiError } = await supabase
        .from('ai_context')
        .upsert(
          {
            bookmark_id: bookmarkId,
            user_id: userId,
            context: aiAnalysis.ai_context,
            ai_category: aiAnalysis.ai_category || [],
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
        ...(updatedBm as BookmarkDbRow),
        ai_context: aiContextRow as AiContextDbRow,
      });

      res.status(200).json(response);
    } catch (aiErr: unknown) {
      // Refund the reserved credit since AI generation failed
      await refundUserCredit(supabase, userId);

      const message = aiErr instanceof Error ? aiErr.message : String(aiErr);
      logger.warn('BookmarkController', 'Manual AI generation failed. Refunded reserved credit:', message);
      await supabase
        .from('bookmarks')
        .update({ ai_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', bookmarkId);

      res.status(500).json({ error: 'AI generation failed. Your credit was not deducted.', ai_status: 'failed' });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error in generateAiForBookmark:', message);
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
      logger.error('BookmarkController', 'Failed to delete bookmark from Supabase:', error.message);
      res.status(500).json({ error: 'Failed to delete bookmark.' });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error deleting bookmark:', message);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error fetching user plan:', message);
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
      logger.error('BookmarkController', 'Failed to update user settings in Supabase:', error.message);
      res.status(500).json({ error: 'Failed to update user settings.' });
      return;
    }

    res.status(200).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error updating user settings:', message);
    res.status(500).json({ error: 'Failed to update user settings.' });
  }
}

/**
 * GET /api/v1/bookmarks/:id/article
 * Returns full reader-mode article content for a specific bookmark.
 */
export async function getBookmarkArticleController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const supabase = req.supabase!;
    const userId = req.user!.id;
    const bookmarkId = req.params.id;

    if (!bookmarkId) {
      res.status(400).json({ error: 'Missing bookmark ID in URL params.' });
      return;
    }

    const { data: article, error } = await supabase
      .from('articles')
      .select('bookmark_id, content_html, content_markdown, word_count, reading_time_minutes, created_at, bookmarks(id, title, url, site_name, description, logo_url)')
      .eq('bookmark_id', bookmarkId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      logger.error('BookmarkController', `Failed to fetch article for bookmark ${bookmarkId}:`, error.message);
      res.status(500).json({ error: 'Failed to retrieve article content.' });
      return;
    }

    if (!article) {
      res.status(404).json({ error: 'Article not found for this bookmark.' });
      return;
    }

    const bm = (Array.isArray(article.bookmarks) ? article.bookmarks[0] : article.bookmarks) as {
      id?: string;
      title?: string | null;
      url?: string | null;
      site_name?: string | null;
      description?: string | null;
      logo_url?: string | null;
    } | null;

    res.status(200).json({
      bookmark_id: article.bookmark_id,
      content_html: article.content_html,
      content_markdown: (article as any).content_markdown || null,
      word_count: article.word_count,
      reading_time_minutes: article.reading_time_minutes,
      created_at: article.created_at,
      title: bm?.title || null,
      url: bm?.url || null,
      site_name: bm?.site_name || null,
      description: bm?.description || null,
      logo_url: bm?.logo_url || null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('BookmarkController', 'Error in getBookmarkArticle:', message);
    res.status(500).json({ error: 'Internal server error while fetching article.' });
  }
}
