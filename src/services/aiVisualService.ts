import axios from 'axios';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { aiCache } from '../utils/cache';
import { canonicalizeUrl } from '../utils/urlFormatter';
import { logger } from '../utils/logger';

export interface AIVisualAnalysisInput {
  url: string;
  title?: string;
  description?: string;
  snapshot?: string | null;
  site_name?: string;
  type?: string;
  card_data?: any;
  forceRefresh?: boolean;
  article_content?: string | null;
  page_intent?: 'article' | 'tool_or_resource' | 'auth_or_portal' | 'general_website' | string | null;
}

export interface AIVisualAnalysisResult {
  ai_context: string | null;
  ai_tags: string[];
  visual_entities?: string[];
  ocr_text?: string;
}

// Cached GoogleGenAI SDK client instance
let cachedAiClient: { key: string; client: GoogleGenAI } | null = null;
function getGenAIClient(apiKey: string): GoogleGenAI {
  if (!cachedAiClient || cachedAiClient.key !== apiKey) {
    cachedAiClient = { key: apiKey, client: new GoogleGenAI({ apiKey }) };
  }
  return cachedAiClient.client;
}

function isVideoUrl(url: string): boolean {
  if (!url) return false;
  const clean = url.toLowerCase().split('?')[0];
  return (
    clean.endsWith('.mp4') ||
    clean.endsWith('.mov') ||
    clean.endsWith('.avi') ||
    clean.endsWith('.webm') ||
    clean.endsWith('.m3u8')
  );
}

/**
 * Downloads image from URL, resizes/downscales to max 768px using sharp,
 * and converts to compressed JPEG (quality 70%) base64.
 * Drastically cuts token usage (1 tile, ~258 tokens) and payload size (down to 20-50KB).
 */
async function fetchImageAsInlineData(imageUrl: string): Promise<{ mimeType: string; data: string } | null> {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http') || isVideoUrl(imageUrl)) {
    return null;
  }

  try {
    const isFacebookOrMeta = imageUrl.includes('fbsbx.com') || imageUrl.includes('facebook.com') || imageUrl.includes('fbcdn.net');
    const userAgent = isFacebookOrMeta
      ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    const rawContentType = response.headers['content-type'];
    const contentType = typeof rawContentType === 'string' ? rawContentType : 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();

    // Reject non-image content types (e.g. video/mp4, text/html)
    if (!mimeType.startsWith('image/')) {
      logger.warn('AIVisualService', `Skipping non-image response mimeType (${mimeType}) for ${imageUrl}`);
      return null;
    }

    // Downscale to max 768px (Gemini's native single tile size) and compress with JPEG quality 70%
    const compressedBuffer = await sharp(response.data)
      .resize({
        width: 768,
        height: 768,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70, progressive: true })
      .toBuffer();

    const originalKb = (response.data.length / 1024).toFixed(1);
    const compressedKb = (compressedBuffer.length / 1024).toFixed(1);
    logger.debug('AIVisualService', `Compressed image from ${originalKb}KB -> ${compressedKb}KB for ${imageUrl.substring(0, 50)}...`);

    const base64Data = compressedBuffer.toString('base64');

    return {
      mimeType: 'image/jpeg',
      data: base64Data,
    };
  } catch (error) {
    logger.warn('AIVisualService', `Failed to fetch/compress image ${imageUrl.substring(0, 80)}...:`, (error as Error).message);
    return null;
  }
}

/**
 * Helper to detect target social media platforms (X/Twitter, Instagram, LinkedIn, Reddit).
 */
function detectSocialPlatform(input: AIVisualAnalysisInput): { isSocialMedia: boolean; platform: string | null } {
  const siteLower = (input.site_name || '').toLowerCase();
  const typeLower = (input.type || '').toLowerCase();
  const urlLower = (input.url || '').toLowerCase();

  if (
    typeLower === 'twitter' ||
    siteLower.includes('twitter') ||
    siteLower.includes('x.com') ||
    urlLower.includes('twitter.com') ||
    urlLower.includes('x.com')
  ) {
    return { isSocialMedia: true, platform: 'twitter' };
  }
  if (
    typeLower === 'instagram' ||
    siteLower.includes('instagram') ||
    urlLower.includes('instagram.com')
  ) {
    return { isSocialMedia: true, platform: 'instagram' };
  }
  if (
    typeLower === 'linkedin' ||
    siteLower.includes('linkedin') ||
    urlLower.includes('linkedin.com')
  ) {
    return { isSocialMedia: true, platform: 'linkedin' };
  }
  if (
    typeLower === 'reddit' ||
    siteLower.includes('reddit') ||
    urlLower.includes('reddit.com') ||
    urlLower.includes('redd.it')
  ) {
    return { isSocialMedia: true, platform: 'reddit' };
  }

  return { isSocialMedia: false, platform: null };
}

/**
 * Heuristic fallback when GEMINI_API_KEY is absent, invalid, or API call fails.
 */
function buildFallbackAnalysis(input: AIVisualAnalysisInput, reason?: string): AIVisualAnalysisResult {
  const parts: string[] = [];
  if (input.title) parts.push(`Title: ${input.title}`);
  if (input.description) parts.push(`Description: ${input.description}`);
  if (input.site_name) parts.push(`Source: ${input.site_name}`);

  const tagsSet = new Set<string>();

  // Extract words from title & description
  const combinedText = `${input.title || ''} ${input.description || ''} ${input.site_name || ''}`.toLowerCase();

  if (input.type) tagsSet.add(input.type.toLowerCase());
  if (input.site_name) tagsSet.add(input.site_name.toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Common keywords heuristic
  const keywordMatches = combinedText.match(/\b(actor|actress|movie|job|hiring|role|engineer|developer|tech|design|remote|salaries|career|news)\b/gi);
  if (keywordMatches) {
    keywordMatches.forEach((k) => tagsSet.add(k.toLowerCase().replace(/\s+/g, '-')));
  }

  // Extract hashtag words if present
  const hashtags = combinedText.match(/#([a-zA-Z0-9_]+)/g);
  if (hashtags) {
    hashtags.forEach((h) => tagsSet.add(h.replace('#', '').toLowerCase()));
  }

  const fallbackContext = parts.length > 0
    ? `Content Summary: ${parts.join(' | ')}.`
    : `Saved link from ${input.site_name || input.url}.`;

  return {
    ai_context: fallbackContext,
    ai_tags: Array.from(tagsSet).slice(0, 10),
    visual_entities: [],
    ocr_text: '',
  };
}

const CANDIDATE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

// In-memory circuit breaker for quota-exhausted models (500 RPD vs 20 RPD limits)
const exhaustedModels = new Set<string>();

const DEFAULT_MODEL_TIMEOUT_MS = 7000;

/**
 * Main AI Visual & Video Intelligence Analyzer using Google Gemini Multimodal Vision API.
 * Integrated with in-memory LRU caching to avoid redundant API latency and quota consumption.
 */
export async function analyzeVisualContext(input: AIVisualAnalysisInput): Promise<AIVisualAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_free_gemini_api_key')) {
    logger.info('AIVisualService', 'GEMINI_API_KEY is missing or placeholder in .env. Please set a valid Google AI Studio API key.');
    return buildFallbackAnalysis(input, 'AI Key not configured in .env');
  }

  // Check in-memory AI cache (1 hour TTL) unless forceRefresh is set
  const canonicalUrl = canonicalizeUrl(input.url) || input.url;
  const cacheKey = `${canonicalUrl}::${(input.title || '').trim()}`;
  if (!input.forceRefresh) {
    const cachedResult = aiCache.get(cacheKey);
    if (cachedResult) {
      logger.debug('AIVisualService', `Cache hit for ${canonicalUrl}`);
      return cachedResult;
    }
  }

  // Platform Detection & Social Media Check
  const { isSocialMedia, platform: socialPlatform } = detectSocialPlatform(input);
  const isInstagram = socialPlatform === 'instagram';

  // Pre-Validation: Detect Login Wall or Missing Media/Content
  const titleText = (input.title || '').trim();
  const descText = (input.description || '').trim();
  const combinedMeta = `${titleText} ${descText}`.toLowerCase();

  const isExplicitLoginWall =
    combinedMeta.includes('login • instagram') ||
    combinedMeta.includes('welcome back to instagram') ||
    combinedMeta.includes('log in to instagram');

  const hasNoMedia = !input.snapshot && (!input.card_data || !Array.isArray(input.card_data.media) || input.card_data.media.length === 0);

  // Instagram Constraint: Instagram is 100% media-based. If Instagram has no media OR is an explicit login wall, skip Gemini API call.
  if (isInstagram && (isExplicitLoginWall || hasNoMedia)) {
    logger.info('AIVisualService', `Instagram login wall / restricted media detected for "${input.url}". Skipping AI API call.`);
    const res = {
      ai_context: null,
      ai_tags: ['instagram'],
    };
    aiCache.set(cacheKey, res);
    return res;
  }

  // Non-Instagram Explicit Login Wall check
  if (isExplicitLoginWall && !descText) {
    logger.info('AIVisualService', `Login wall detected for "${input.url}". Skipping AI API call.`);
    const res = {
      ai_context: null,
      ai_tags: [input.site_name?.toLowerCase().replace(/[^a-z0-9]/g, '') || input.type || 'bookmark'].filter(Boolean),
    };
    aiCache.set(cacheKey, res);
    return res;
  }

  try {
    // 1. Determine Page Intent
    const pageIntent =
      input.page_intent ||
      input.card_data?.page_intent ||
      (input.type === 'article' || input.card_data?.type === 'article' ? 'article' : 'general_website');
    const isArticle = pageIntent === 'article';
    const articleContent = input.article_content || input.card_data?.article_content || null;

    // 2. Identify Candidate Visual Assets (Images & Video Posters)
    // CRITICAL: Avoid fetching, compressing, or sending images to AI for articles.
    // Article hero images are decorative banners/metaphors that distract the AI and waste tokens.
    let isVideo = false;
    let validImageParts: { mimeType: string; data: string }[] = [];

    if (!isArticle) {
      const candidateImageUrls: string[] = [];

      if (input.snapshot) {
        if (isVideoUrl(input.snapshot)) {
          isVideo = true;
        } else {
          candidateImageUrls.push(input.snapshot);
        }
      }

      if (input.card_data) {
        if (Array.isArray(input.card_data.media)) {
          input.card_data.media.forEach((m: any) => {
            if (!m) return;
            if (m.type === 'video' || (m.url && isVideoUrl(m.url))) {
              isVideo = true;
              // Capture poster / thumbnail keyframe for the video
              if (m.poster && typeof m.poster === 'string' && !candidateImageUrls.includes(m.poster)) {
                candidateImageUrls.push(m.poster);
              }
              if (m.thumbnail && typeof m.thumbnail === 'string' && !candidateImageUrls.includes(m.thumbnail)) {
                candidateImageUrls.push(m.thumbnail);
              }
            } else if (m.url && typeof m.url === 'string' && !isVideoUrl(m.url) && !candidateImageUrls.includes(m.url)) {
              candidateImageUrls.push(m.url);
            }
          });
        }
      }

      // Limit to top 2 images (e.g. poster keyframe + primary image, or top 2 carousel slides)
      // With 768px Sharp downscaling, this guarantees exactly 258 - 516 image tokens max (~40KB payload).
      const targetImageUrls = candidateImageUrls.slice(0, 2);

      // Fetch and compress candidate images via Sharp
      const rawImageParts = await Promise.all(targetImageUrls.map((u) => fetchImageAsInlineData(u)));
      validImageParts = rawImageParts.filter((p): p is { mimeType: string; data: string } => p !== null);
    }

    logger.info(
      'AIVisualService',
      `Starting Gemini Analysis: isArticle=${isArticle}, isSocialMedia=${isSocialMedia}, platform=${socialPlatform || 'other'}, isVideo=${isVideo}, compressedImages=${validImageParts.length} for "${input.title || input.url}"`
    );

    // 3. Construct prompt for Gemini Intelligence
    let mediaContextDescription = '';
    let intentSpecificRules = '';

    if (isArticle) {
      mediaContextDescription = 'This bookmark is an in-depth article, essay, or blog post. No visual images are attached because article analysis is strictly based on the written text.';
      intentSpecificRules = `
ARTICLE MODE RULES:
- The bookmark is an article or essay. Focus strictly on the written thesis, main arguments, and key insights in the Title, Description, and Article Body Excerpt.
- In 'ai_context', synthesize what the article is about, its core message, author's perspective, and practical takeaways in 2-4 clear sentences.
- In 'ai_tags', provide 4-8 high-signal conceptual tags reflecting the core topics, themes, and domains (e.g. competitiveness, psychology, fomo, career, decision-making).
- In 'visual_entities', return [] (empty array) since no images are analyzed.
- In 'ocr_text', return "" (empty string).
`.trim();
    } else if (isSocialMedia && isVideo) {
      mediaContextDescription = `This bookmark is a ${socialPlatform || 'social media'} video/clip/reel. The attached visual represents the video poster/keyframe thumbnail. Combine this keyframe visual with the post caption, description, and metadata.`;
    } else if (isVideo) {
      mediaContextDescription = 'This bookmark is a video/clip/reel. The attached visual represents the video poster/keyframe thumbnail. Combine this keyframe visual with the post caption, description, and text.';
    } else if (pageIntent === 'auth_or_portal') {
      mediaContextDescription = 'This bookmark is an account login, authentication, or portal dashboard page. The attached visual represents the login interface or dashboard landing.';
      intentSpecificRules = `
PORTAL / LOGIN PAGE MODE:
- Focus on the service, platform, and authentication utility provided (e.g. Adobe Creative Cloud, Cloudflare, AWS).
- Summarize what this portal is for (signing in, account access, authentication) and generate relevant tags (e.g. service-name, login, account, portal).
`.trim();
    } else if (pageIntent === 'tool_or_resource') {
      mediaContextDescription = 'This bookmark is a developer tool, UI component library, utility, or technical resource catalog.';
      intentSpecificRules = `
DEVELOPER TOOL / RESOURCE MODE:
- Focus on the technical capability, components, framework, or utility provided (e.g. UI components, CSS styles, icons, library).
- Highlight key use-cases and developer features.
`.trim();
    } else {
      mediaContextDescription = 'The attached visual(s) represent the content images/snapshots for this bookmark.';
    }

    const articleSection =
      isArticle && articleContent
        ? `\nArticle Body Text:\n"""\n${articleContent.length > 20000 ? articleContent.substring(0, 20000) + '\n...[truncated]' : articleContent}\n"""\n`
        : '';

    const promptText = `
You are an advanced AI Intelligence system for a smart bookmarking platform.
Your job is to analyze the content alongside textual metadata.
${mediaContextDescription}

Bookmark Title: "${input.title || ''}"
Bookmark Description: "${input.description || ''}"
Platform/Source: "${input.site_name || input.type || ''}"
URL: "${input.url}"
${articleSection}
CRITICAL ANTI-HALLUCINATION RULES:
- Rely strictly on the attached metadata and verified text.
- IF NO VALID IMAGE IS ATTACHED and metadata is generic or missing (e.g. login wall or restricted page), DO NOT invent, guess, or hallucinate specific TV shows, movies, actors, or fictional events based on URL shortcodes.
- If visual media is unavailable or restricted, state clearly that the bookmark is a saved link from ${input.site_name || 'the platform'} where media content was restricted by login, and generate relevant generic tags.
${intentSpecificRules ? `\n${intentSpecificRules}\n` : ''}
Requirements:
1. **Content & Entity Recognition**: Examine textual information (and visual media if attached). For articles, prioritize the written thesis and key takeaways. For UI tools, examine the interface components.
2. **Context Synthesis**: Synthesize what is happening (topics, thesis, actions, on-screen text, job notifications, captions, or article arguments).
3. **Synthesize Rich AI Context**: Write a detailed, highly informative, 2-4 sentence context paragraph blending conceptual insights, key arguments, and background knowledge. Ensure key search terms are naturally included.
4. **Auto-Tagging**: Return a clean array of 4-10 concise tags (lowercase, hyphenated for multi-words, no # prefix) capturing the true subject matter.

Return strictly valid JSON in this exact structure:
{
  "ai_context": "Rich detailed synthesis paragraph...",
  "ai_tags": ["tag1", "tag2", "tag3"],
  "visual_entities": ["Entity 1", "Entity 2"],
  "ocr_text": "Extracted text..."
}
`.trim();

    // 4. Invoke Gemini Model with candidate model fallback
    const ai = getGenAIClient(apiKey);

    // Prepare contents array for @google/genai SDK
    const contents: any[] = [];

    // Add compressed image parts
    validImageParts.forEach((img) => {
      contents.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.data,
        },
      });
    });

    // Add text prompt
    contents.push({ text: promptText });

    let responseText: string | null = null;
    let lastError: any = null;

    const modelTimeoutMs = parseInt(
      process.env.AI_MODEL_TIMEOUT_MS || String(DEFAULT_MODEL_TIMEOUT_MS),
      10
    );

    for (const modelName of CANDIDATE_MODELS) {
      if (exhaustedModels.has(modelName)) {
        logger.debug('AIVisualService', `Skipping exhausted model: ${modelName}`);
        continue;
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        logger.debug('AIVisualService', `Attempting generation with model: ${modelName} (timeout: ${modelTimeoutMs}ms)...`);

        const generatePromise = ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Model generation timed out after ${modelTimeoutMs}ms`));
          }, modelTimeoutMs);
        });

        const response = await Promise.race([generatePromise, timeoutPromise]);

        if (response.text) {
          responseText = response.text;
          logger.info('AIVisualService', `Successfully received response from ${modelName}!`);
          break;
        }
      } catch (err: any) {
        lastError = err;
        const errMsg = (err?.message || String(err)).toLowerCase();
        const isQuotaExceeded =
          errMsg.includes('limit: 20') ||
          errMsg.includes('generaterequestsperday') ||
          errMsg.includes('resource_exhausted') ||
          errMsg.includes('quota exceeded') ||
          errMsg.includes('429');

        if (isQuotaExceeded) {
          exhaustedModels.add(modelName);
          logger.warn(
            'AIVisualService',
            `Circuit breaker tripped: Model "${modelName}" marked as exhausted due to quota limit: ${err?.message || err}`
          );
        } else {
          logger.warn('AIVisualService', `Model ${modelName} failed or timed out:`, err?.message || err);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    if (!responseText) {
      throw lastError || new Error('All Gemini candidate models failed to return content.');
    }

    // Clean JSON response if wrapped in markdown code blocks
    const cleanedJsonStr = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedJsonStr);

    const result: AIVisualAnalysisResult = {
      ai_context: parsed.ai_context || buildFallbackAnalysis(input).ai_context,
      ai_tags: Array.isArray(parsed.ai_tags) && parsed.ai_tags.length > 0
        ? parsed.ai_tags
        : buildFallbackAnalysis(input).ai_tags,
      visual_entities: Array.isArray(parsed.visual_entities) ? parsed.visual_entities : [],
      ocr_text: typeof parsed.ocr_text === 'string' ? parsed.ocr_text : '',
    };

    // Store in cache
    aiCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    logger.error('AIVisualService', 'Error during Gemini visual analysis:', err?.message || err);
    return buildFallbackAnalysis(input, `API Error: ${err?.message || 'Gemini processing failed'}`);
  }
}
