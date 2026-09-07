import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, LinkedInCardData, MediaItem } from './types';
import { playwrightEngine } from '../playwrightEngine';
import { cleanDescription } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

const LINKEDIN_LOGO_URL = 'https://static.licdn.com/aero-v1/sc/h/al2o9zrvru7aqj8e1x2rzsrca';

function cleanLinkedInText(text: string | null): string {
  if (!text) return '';
  return text
    .replace(/\s*\|\s*[\d,.]+[KMBkmb]?\s*comments(?:\s+on\s+LinkedIn)?/gi, '')
    .replace(/\s*\|\s*LinkedIn\s*$/i, '')
    .trim();
}

function extractNameFromUrlSlug(url: string): string | null {
  const match = url.match(/\/posts\/([a-zA-Z0-9-]+)_/i);
  if (match && match[1]) {
    const raw = match[1].replace(/-/g, ' ').trim();
    if (raw) {
      return raw.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

function isGhostAvatar(url: string | null): boolean {
  if (!url) return true;
  const l = url.toLowerCase();
  return (
    l.includes('ghost_person') ||
    l.includes('ghost_profile') ||
    l.includes('ghost-avatar') ||
    l.includes('aero-v1') ||
    l.includes('9c8pery4andzj6ohjkjp54ma2') ||
    l.includes('profile-displaybackgroundimage') ||
    l.includes('cover-image')
  );
}

function isExcludedPostMedia(url: string | null): boolean {
  if (!url) return true;
  const l = url.toLowerCase();
  return (
    isGhostAvatar(url) ||
    l.includes('profile-displayphoto') ||
    l.includes('profile-displaybackgroundimage') ||
    l.includes('company-logo')
  );
}

function parseLinkedInJsonLd(html: string): {
  authorName: string | null;
  authorAvatar: string | null;
  description: string | null;
  snapshot: string | null;
  images: string[];
  videoUrl: string | null;
  publishedAt: string | null;
  reactions: number;
  comments: number;
  reposts: number;
} {
  let authorName: string | null = null;
  let authorAvatar: string | null = null;
  let description: string | null = null;
  let snapshot: string | null = null;
  const rawImages: string[] = [];
  let videoUrl: string | null = null;
  let publishedAt: string | null = null;
  let reactions = 0;
  let comments = 0;
  let reposts = 0;

  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const json = JSON.parse($(s).text() || '{}');
        const type = json['@type'] || '';
        if (
          type === 'SocialMediaPosting' ||
          type === 'VideoObject' ||
          type === 'Article' ||
          type === 'DiscussionForumPosting'
        ) {
          if (json.creator?.name || json.author?.name) {
            authorName = json.creator?.name || json.author?.name;
          }

          // Author Avatar parsing
          const imgObj = json.creator?.image || json.author?.image;
          if (typeof imgObj === 'string') {
            authorAvatar = imgObj;
          } else if (imgObj && typeof imgObj === 'object') {
            authorAvatar = imgObj.url || imgObj.contentUrl || null;
          }

          if (json.datePublished || json.uploadDate) {
            publishedAt = json.datePublished || json.uploadDate;
          }
          if (json.description || json.articleBody || json.text) {
            description = json.description || json.articleBody || json.text;
          }

          // Extract multiple images from JSON-LD
          if (Array.isArray(json.image)) {
            json.image.forEach((img: any) => {
              if (typeof img === 'string') {
                rawImages.push(img);
              } else if (img && typeof img === 'object') {
                const u = img.url || img.contentUrl;
                if (u && typeof u === 'string') rawImages.push(u);
              }
            });
          } else if (typeof json.image === 'string') {
            rawImages.push(json.image);
          } else if (json.image && typeof json.image === 'object') {
            const u = json.image.url || json.image.contentUrl;
            if (u && typeof u === 'string') rawImages.push(u);
          }

          if (json.thumbnailUrl && typeof json.thumbnailUrl === 'string') {
            rawImages.push(json.thumbnailUrl);
          }

          if (type === 'VideoObject' && json.contentUrl) {
            videoUrl = json.contentUrl;
            if (!snapshot && json.thumbnailUrl) {
              snapshot = json.thumbnailUrl;
            }
          }

          if (typeof json.commentCount === 'number') {
            comments = json.commentCount;
          }
          if (Array.isArray(json.interactionStatistic)) {
            json.interactionStatistic.forEach((stat: any) => {
              const statType = stat.interactionType || '';
              const count = parseInt(stat.userInteractionCount || 0, 10);
              if (statType.includes('LikeAction') || statType.includes('ReactAction')) reactions = count;
              else if (statType.includes('CommentAction')) comments = count;
              else if (statType.includes('ShareAction')) reposts = count;
            });
          }
        }
      } catch {}
    });

    // Extract post images from HTML DOM (feedshare images)
    $('img[data-delayed-url*="feedshare-image"], img[src*="feedshare-image"]').each((_, el) => {
      const src = $(el).attr('data-delayed-url') || $(el).attr('src');
      if (src && !isExcludedPostMedia(src)) {
        rawImages.push(src);
      }
    });

    const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    if (ogImg && !isExcludedPostMedia(ogImg)) {
      rawImages.push(ogImg);
    }

    // Author Avatar: extract strictly from post author containers, NEVER from commenters or global selectors
    if (!authorAvatar || isGhostAvatar(authorAvatar)) {
      const lockup = $('[data-test-id="main-feed-activity-card__entity-lockup"], .feed-shared-actor, .update-components-actor');
      if (lockup.length > 0) {
        const img = lockup.find('img').first();
        const url = img.attr('data-delayed-url') || img.attr('src');
        if (url && !isGhostAvatar(url)) {
          authorAvatar = url;
        }
      }

      if (!authorAvatar || isGhostAvatar(authorAvatar)) {
        const authorCard = $('.public-post-author-card');
        if (authorCard.length > 0) {
          const entity = authorCard.find('img[src*="profile-displayphoto"], [data-delayed-url*="profile-displayphoto"], [role="img"]').first();
          const url = entity.attr('data-delayed-url') || entity.attr('src');
          if (url && !isGhostAvatar(url)) {
            authorAvatar = url;
          }
        }
      }
    }
  } catch {}

  // Deduplicate and filter post images
  const images: string[] = [];
  const seenKeys = new Set<string>();
  for (const img of rawImages) {
    if (!img || isExcludedPostMedia(img)) continue;
    const cleanUrl = img.replace(/&amp;/g, '&').trim();
    const idMatch = cleanUrl.match(/\/feedshare-image[^\/]*\/([^\/?]+)/);
    const key = idMatch ? idMatch[1] : cleanUrl.split('?')[0];
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      images.push(cleanUrl);
    }
  }

  if (images.length > 0) {
    snapshot = images[0];
  }

  return {
    authorName,
    authorAvatar,
    description,
    snapshot,
    images,
    videoUrl,
    publishedAt,
    reactions,
    comments,
    reposts,
  };
}

export const linkedInExtractor: PlatformExtractor<LinkedInCardData> = {
  platformKey: 'linkedin',
  async extract(targetUrl: string): Promise<ExtractionResult<LinkedInCardData>> {
    let authorName: string | null = null;
    let authorAvatar: string | null = null;
    let description: string | null = null;
    let snapshot: string | null = null;
    let extractedImages: string[] = [];
    let videoUrl: string | null = null;
    let publishedAt: string | null = null;
    let reactions = 0;
    let comments = 0;
    let reposts = 0;
    const mediaList: MediaItem[] = [];

    // -------------------------------------------------------------
    // Tier 1: Fast-Path Axios & Cheerio with LinkedInBot Headers (~250ms)
    // -------------------------------------------------------------
    try {
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 5,
        timeout: 3500,
      });

      if (res && res.data) {
        const parsed = parseLinkedInJsonLd(res.data);
        authorName = parsed.authorName;
        authorAvatar = parsed.authorAvatar;
        description = parsed.description;
        snapshot = parsed.snapshot;
        extractedImages = parsed.images;
        videoUrl = parsed.videoUrl;
        publishedAt = parsed.publishedAt;
        reactions = parsed.reactions;
        comments = parsed.comments;
        reposts = parsed.reposts;

        const $ = cheerio.load(res.data);
        const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        const ogTitle = $('meta[property="og:title"]').attr('content') || '';

        if (!description && ogDesc) description = ogDesc;
        if (!snapshot && ogImage) snapshot = ogImage;

        if (!authorName) {
          const match = ogTitle.match(/\|\s*([^|]+)$/);
          if (match && match[1] && !match[1].toLowerCase().includes('linkedin')) {
            authorName = match[1].trim();
          }
        }
      }
    } catch {
      // Fallback to Playwright if Axios fails
    }

    // -------------------------------------------------------------
    // Tier 2: Playwright Fallback (<2s)
    // -------------------------------------------------------------
    if (!description && !snapshot && !authorName) {
      try {
        const pwResult = await playwrightEngine.scrape<any>(targetUrl, {
          waitSelector: 'article, main, .feed-shared-update-v2',
          waitTimeout: 1500,
          userAgent: 'LinkedInBot/1.0 (sdk@linkedin.com)',
          customEvaluator: async (page) => {
            return await page.evaluate(() => {
              const domImages: string[] = [];
              document.querySelectorAll('img[src*="feedshare-image"], img[data-delayed-url*="feedshare-image"]').forEach((img: any) => {
                const src = img.getAttribute('data-delayed-url') || img.src;
                if (src) domImages.push(src);
              });
              return {
                html: document.documentElement.outerHTML,
                title: document.title,
                images: domImages,
              };
            });
          },
        });

        if (pwResult.customData?.html) {
          const parsed = parseLinkedInJsonLd(pwResult.customData.html);
          if (parsed.authorName) authorName = parsed.authorName;
          if (parsed.authorAvatar) authorAvatar = parsed.authorAvatar;
          if (parsed.description) description = parsed.description;
          if (parsed.snapshot) snapshot = parsed.snapshot;
          if (parsed.images && parsed.images.length > 0) extractedImages = parsed.images;
          if (parsed.videoUrl) videoUrl = parsed.videoUrl;
          if (parsed.publishedAt) publishedAt = parsed.publishedAt;
          if (parsed.reactions) reactions = parsed.reactions;
          if (parsed.comments) comments = parsed.comments;
          if (parsed.reposts) reposts = parsed.reposts;
        }

        if (Array.isArray(pwResult.customData?.images) && extractedImages.length === 0) {
          extractedImages = pwResult.customData.images;
        }

        if (!description) description = pwResult.description || null;
        if (!snapshot) snapshot = pwResult.snapshot || null;
        if (!authorName) authorName = pwResult.author || null;
      } catch {
        // Ignore playwright fallback error
      }
    }

    // Resolve author name fallback
    if (!authorName || authorName === 'LinkedIn User' || authorName.toLowerCase().includes('linkedin')) {
      authorName = extractNameFromUrlSlug(targetUrl) || 'LinkedIn Member';
    }

    // Fallback avatar if still not found
    if (!authorAvatar || isGhostAvatar(authorAvatar)) {
      authorAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=0a66c2&color=fff&size=200&bold=true`;
    }

    // Assemble clean media list (Strictly post media: video or post snapshot, NO profile avatars or banners)
    if (videoUrl) {
      mediaList.push({ type: 'video', url: videoUrl });
    }
    for (const imgUrl of extractedImages) {
      if (!mediaList.some((m) => m.url === imgUrl) && !isExcludedPostMedia(imgUrl)) {
        mediaList.push({ type: 'image', url: imgUrl });
      }
    }
    if (snapshot && !mediaList.some((m) => m.url === snapshot) && !isExcludedPostMedia(snapshot)) {
      mediaList.push({ type: 'image', url: snapshot });
    }

    const primarySnapshot = (mediaList.find((m) => m.type === 'image')?.url || mediaList[0]?.url || snapshot) || null;

    const finalDescription = description ? cleanLinkedInText(cleanDescription(description)) : '';

    return {
      title: null, // Always keep title as null for LinkedIn
      description: finalDescription,
      snapshot: primarySnapshot,
      logo: LINKEDIN_LOGO_URL,
      ogSiteName: 'LinkedIn',
      card_data: {
        author: {
          name: authorName,
          avatar_url: authorAvatar,
        },
        metrics: {
          reactions,
          comments,
          reposts,
        },
        media: mediaList,
        posted_at: publishedAt || new Date().toISOString(),
      },
    };
  },
};
