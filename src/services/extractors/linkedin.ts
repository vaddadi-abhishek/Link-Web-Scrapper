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

function isGhostOrProfileAvatar(url: string | null): boolean {
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

function parseLinkedInJsonLd(html: string): {
  authorName: string | null;
  authorAvatar: string | null;
  authorHeadline: string | null;
  description: string | null;
  snapshot: string | null;
  videoUrl: string | null;
  publishedAt: string | null;
  reactions: number;
  comments: number;
  reposts: number;
} {
  let authorName: string | null = null;
  let authorAvatar: string | null = null;
  let authorHeadline: string | null = null;
  let description: string | null = null;
  let snapshot: string | null = null;
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

          // Author Headline/Title
          if (json.creator?.jobTitle || json.author?.jobTitle) {
            authorHeadline = json.creator?.jobTitle || json.author?.jobTitle;
          } else if (json.creator?.description || json.author?.description) {
            authorHeadline = json.creator?.description || json.author?.description;
          } else if (json.creator?.interactionStatistic?.userInteractionCount) {
            authorHeadline = `${json.creator.interactionStatistic.userInteractionCount} followers`;
          }

          if (json.datePublished || json.uploadDate) {
            publishedAt = json.datePublished || json.uploadDate;
          }
          if (json.description || json.articleBody || json.text) {
            description = json.description || json.articleBody || json.text;
          }
          if (json.thumbnailUrl || (typeof json.image === 'string' ? json.image : json.image?.url)) {
            snapshot = json.thumbnailUrl || (typeof json.image === 'string' ? json.image : json.image?.url);
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

    // Fallback author avatar and headline from Cheerio HTML selectors
    if (!authorAvatar || isGhostOrProfileAvatar(authorAvatar)) {
      const delayedImg =
        $('[data-delayed-url*="profile-displayphoto"]').attr('data-delayed-url') ||
        $('.public-post-author-card img[src*="profile-displayphoto"]').attr('src') ||
        $('.hue-web-entity__image[data-delayed-url]').attr('data-delayed-url') ||
        null;
      if (delayedImg && !isGhostOrProfileAvatar(delayedImg)) {
        authorAvatar = delayedImg;
      }
    }

    if (!authorHeadline) {
      const followersText = $('.public-post-author-card__followers').text().trim();
      const subtitle = $('.public-post-author-card__subtitle, .feed-shared-actor__description, .update-components-actor__description').text().trim();
      authorHeadline = subtitle || followersText || null;
    }
  } catch {}

  return {
    authorName,
    authorAvatar,
    authorHeadline,
    description,
    snapshot,
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
    let authorHeadline: string | null = null;
    let description: string | null = null;
    let snapshot: string | null = null;
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
        authorHeadline = parsed.authorHeadline;
        description = parsed.description;
        snapshot = parsed.snapshot;
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
              return {
                html: document.documentElement.outerHTML,
                title: document.title,
              };
            });
          },
        });

        if (pwResult.customData?.html) {
          const parsed = parseLinkedInJsonLd(pwResult.customData.html);
          if (parsed.authorName) authorName = parsed.authorName;
          if (parsed.authorAvatar) authorAvatar = parsed.authorAvatar;
          if (parsed.authorHeadline) authorHeadline = parsed.authorHeadline;
          if (parsed.description) description = parsed.description;
          if (parsed.snapshot) snapshot = parsed.snapshot;
          if (parsed.videoUrl) videoUrl = parsed.videoUrl;
          if (parsed.publishedAt) publishedAt = parsed.publishedAt;
          if (parsed.reactions) reactions = parsed.reactions;
          if (parsed.comments) comments = parsed.comments;
          if (parsed.reposts) reposts = parsed.reposts;
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
    if (!authorAvatar || isGhostOrProfileAvatar(authorAvatar)) {
      authorAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=0a66c2&color=fff&size=200&bold=true`;
    }

    // Fallback headline if not found
    if (!authorHeadline) {
      authorHeadline = 'Professional on LinkedIn';
    }

    // Assemble clean media list (Strictly post media: video or post snapshot, NO profile avatars or banners)
    if (videoUrl) {
      mediaList.push({ type: 'video', url: videoUrl });
    }
    if (snapshot && !mediaList.some((m) => m.url === snapshot) && !isGhostOrProfileAvatar(snapshot)) {
      mediaList.push({ type: 'image', url: snapshot });
    }

    const finalDescription = description ? cleanLinkedInText(cleanDescription(description)) : '';

    return {
      title: null, // Always keep title as null for LinkedIn
      description: finalDescription,
      snapshot: snapshot || (mediaList[0] ? mediaList[0].url : null),
      logo: LINKEDIN_LOGO_URL,
      ogSiteName: 'LinkedIn',
      card_data: {
        author: {
          name: authorName,
          headline: authorHeadline,
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
