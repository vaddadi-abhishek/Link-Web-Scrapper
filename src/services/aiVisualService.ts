import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

export interface AIVisualAnalysisInput {
  url: string;
  title?: string;
  description?: string;
  snapshot?: string | null;
  site_name?: string;
  type?: string;
  card_data?: any;
}

export interface AIVisualAnalysisResult {
  ai_context: string | null;
  ai_tags: string[];
  visual_entities?: string[];
  ocr_text?: string;
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
 * Downloads image from URL and converts it to base64 with mimeType
 */
async function fetchImageAsInlineData(imageUrl: string): Promise<{ mimeType: string; data: string } | null> {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http') || isVideoUrl(imageUrl)) {
    return null;
  }

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    const rawContentType = response.headers['content-type'];
    const contentType = typeof rawContentType === 'string' ? rawContentType : 'image/jpeg';
    const mimeType = contentType.split(';')[0].trim();

    // Reject non-image content types (e.g. video/mp4, text/html)
    if (!mimeType.startsWith('image/')) {
      console.warn(`[AIVisualService] Skipping non-image response mimeType (${mimeType}) for ${imageUrl}`);
      return null;
    }

    const base64Data = Buffer.from(response.data).toString('base64');

    return {
      mimeType,
      data: base64Data,
    };
  } catch (error) {
    console.warn(`[AIVisualService] Failed to fetch image ${imageUrl.substring(0, 80)}...:`, (error as Error).message);
    return null;
  }
}

/**
 * Downloads video from URL and converts it to base64 with video/mp4 mimeType
 */
async function fetchVideoAsInlineData(videoUrl: string): Promise<{ mimeType: string; data: string } | null> {
  if (!videoUrl || typeof videoUrl !== 'string' || !videoUrl.startsWith('http')) {
    return null;
  }

  try {
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 12000,
      maxContentLength: 15 * 1024 * 1024, // Limit to 15MB for fast inline processing
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    const rawContentType = response.headers['content-type'];
    const contentType = typeof rawContentType === 'string' ? rawContentType : 'video/mp4';
    let mimeType = contentType.split(';')[0].trim();
    if (!mimeType.startsWith('video/')) {
      mimeType = 'video/mp4';
    }

    const base64Data = Buffer.from(response.data).toString('base64');
    return {
      mimeType,
      data: base64Data,
    };
  } catch (error) {
    console.warn(`[AIVisualService] Failed to fetch video ${videoUrl.substring(0, 80)}...:`, (error as Error).message);
    return null;
  }
}

/**
 * Heuristic fallback when GEMINI_API_KEY is absent, invalid, or API call fails
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
    ? `Visual & Content Context: ${parts.join(' | ')}.${reason ? ` (${reason})` : ''}`
    : `Saved bookmark from ${input.site_name || input.url}.`;

  return {
    ai_context: fallbackContext,
    ai_tags: Array.from(tagsSet).slice(0, 8),
  };
}

const CANDIDATE_MODELS = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-flash-latest', 'gemini-3.8-flash'];

/**
 * Main AI Visual & Video Intelligence Analyzer using Google Gemini Multimodal Vision API
 */
export async function analyzeVisualContext(input: AIVisualAnalysisInput): Promise<AIVisualAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_free_gemini_api_key')) {
    console.log('[AIVisualService] GEMINI_API_KEY is missing or placeholder in .env. Please set a valid Google AI Studio API key.');
    return buildFallbackAnalysis(input, 'AI Key not configured in .env');
  }

  // Platform Detection
  const siteLower = (input.site_name || '').toLowerCase();
  const typeLower = (input.type || '').toLowerCase();
  const urlLower = (input.url || '').toLowerCase();
  const isInstagram = typeLower === 'instagram' || siteLower.includes('instagram') || urlLower.includes('instagram.com');

  // Pre-Validation: Detect Login Wall or Missing Media/Content
  const titleText = (input.title || '').trim();
  const descText = (input.description || '').trim();
  const combinedMeta = `${titleText} ${descText}`.toLowerCase();

  const isExplicitLoginWall =
    combinedMeta.includes('login • instagram') ||
    combinedMeta.includes('welcome back to instagram') ||
    combinedMeta.includes('log in to instagram')

  const hasNoMedia = !input.snapshot && (!input.card_data || !Array.isArray(input.card_data.media) || input.card_data.media.length === 0);

  // Instagram Constraint: Instagram is 100% media-based. If Instagram has no media OR is an explicit login wall, skip Gemini API call.
  if (isInstagram && (isExplicitLoginWall || hasNoMedia)) {
    console.log(`[AIVisualService] Instagram login wall / restricted media detected for "${input.url}". Skipping AI API call.`);
    return {
      ai_context: null,
      ai_tags: ['instagram'],
    };
  }

  // Non-Instagram Explicit Login Wall check (e.g. if explicitly redirected to a login page with 0 content text)
  if (isExplicitLoginWall && !descText) {
    console.log(`[AIVisualService] Login wall detected for "${input.url}". Skipping AI API call.`);
    return {
      ai_context: null,
      ai_tags: [input.site_name?.toLowerCase().replace(/[^a-z0-9]/g, '') || input.type || 'bookmark'].filter(Boolean),
    };
  }

  try {
    // 1. Identify Candidate Video & Image URLs
    let videoUrlCandidate: string | null = null;

    if (input.snapshot && isVideoUrl(input.snapshot)) {
      videoUrlCandidate = input.snapshot;
    }

    if (input.card_data && Array.isArray(input.card_data.media)) {
      const vItem = input.card_data.media.find((m: any) => m && m.url && typeof m.url === 'string' && (m.type === 'video' || isVideoUrl(m.url)));
      if (vItem) {
        videoUrlCandidate = vItem.url;
      }
    }

    const imageMediaUrls: string[] = [];
    if (input.snapshot && !isVideoUrl(input.snapshot)) {
      imageMediaUrls.push(input.snapshot);
    }

    if (input.card_data && Array.isArray(input.card_data.media)) {
      input.card_data.media.forEach((m: any) => {
        if (m && m.url && typeof m.url === 'string' && m.type !== 'video' && !isVideoUrl(m.url) && !imageMediaUrls.includes(m.url)) {
          imageMediaUrls.push(m.url);
        }
      });
    }

    // Limit image candidates to top 4
    const targetImageUrls = imageMediaUrls.slice(0, 4);

    // 2. Fetch Video Part & Image Parts asynchronously
    const videoPartProm = videoUrlCandidate ? fetchVideoAsInlineData(videoUrlCandidate) : Promise.resolve(null);
    const imagePartsProm = Promise.all(targetImageUrls.map((u) => fetchImageAsInlineData(u)));

    const [videoPart, rawImageParts] = await Promise.all([videoPartProm, imagePartsProm]);
    const validImageParts = rawImageParts.filter((p): p is { mimeType: string; data: string } => p !== null);

    console.log(`[AIVisualService] Starting Gemini Multimodal Analysis: video=${!!videoPart}, images=${validImageParts.length} for "${input.title || input.url}"`);

    // 3. Construct prompt for Gemini Multimodal Video & Visual Intelligence
    const promptText = `
You are an advanced AI Multimodal Visual & Video Intelligence system for a smart bookmarking platform.
Your job is to analyze the attached video(s) and image(s) alongside textual metadata.

Bookmark Title: "${input.title || ''}"
Bookmark Description: "${input.description || ''}"
Platform/Source: "${input.site_name || input.type || ''}"
URL: "${input.url}"

CRITICAL ANTI-HALLUCINATION RULES:
- Rely strictly on the attached video, image(s), and verified textual metadata.
- IF NO VALID VIDEO OR IMAGE IS ATTACHED and metadata is generic or missing (e.g. login wall or restricted page), DO NOT invent, guess, or hallucinate specific TV shows, movies, actors (e.g. Friends, Jennifer Aniston, Gucci), or fictional events based on URL shortcodes.
- If visual media is unavailable or restricted, state clearly that the bookmark is a saved link from ${input.site_name || 'the platform'} where media content was restricted by login, and generate relevant generic tags.

Requirements (When visual/video media IS provided):
1. **Video & Visual Entity Recognition**: Watch the attached video and examine any photo(s) carefully. Identify any famous individuals, actors, public figures, podcasters, logos, landmarks, or visual scenes.
2. **Video Action & Spoken Audio / OCR Context**: Synthesize what happens in the video (actions, scene, spoken topic, captions, on-screen text, job notifications).
3. **Synthesize Rich AI Context**: Write a detailed, highly informative, 2-4 sentence context paragraph blending video insights, visual entities, company/person names, job roles, and background knowledge. Ensure key search terms are naturally included.
4. **Auto-Tagging**: Return a clean array of 4-10 concise tags (lowercase, hyphenated for multi-words, no # prefix).

Return strictly valid JSON in this exact structure:
{
  "ai_context": "Rich detailed synthesis paragraph...",
  "ai_tags": ["tag1", "tag2", "tag3"],
  "visual_entities": ["Entity 1", "Entity 2"],
  "ocr_text": "Extracted text..."
}
`.trim();

    // 4. Invoke Gemini Model with candidate model fallback
    const ai = new GoogleGenAI({ apiKey });

    // Prepare contents array for @google/genai SDK
    const contents: any[] = [];

    // Add video part first if present
    if (videoPart) {
      contents.push({
        inlineData: {
          mimeType: videoPart.mimeType,
          data: videoPart.data,
        },
      });
    }

    // Add image parts next
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

    for (const modelName of CANDIDATE_MODELS) {
      try {
        console.log(`[AIVisualService] Attempting generation with model: ${modelName}...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            responseMimeType: 'application/json',
          },
        });

        if (response.text) {
          responseText = response.text;
          console.log(`[AIVisualService] Successfully received response from ${modelName}!`);
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AIVisualService] Model ${modelName} failed:`, err?.message || err);
      }
    }

    if (!responseText) {
      throw lastError || new Error('All Gemini candidate models failed to return content.');
    }

    // Clean JSON response if wrapped in markdown code blocks
    const cleanedJsonStr = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedJsonStr);

    return {
      ai_context: parsed.ai_context || buildFallbackAnalysis(input).ai_context,
      ai_tags: Array.isArray(parsed.ai_tags) && parsed.ai_tags.length > 0
        ? parsed.ai_tags
        : buildFallbackAnalysis(input).ai_tags,
      visual_entities: Array.isArray(parsed.visual_entities) ? parsed.visual_entities : [],
      ocr_text: typeof parsed.ocr_text === 'string' ? parsed.ocr_text : '',
    };
  } catch (err: any) {
    console.error('[AIVisualService] Error during Gemini visual analysis:', err?.message || err);
    return buildFallbackAnalysis(input, `API Error: ${err?.message || 'Gemini processing failed'}`);
  }
}
