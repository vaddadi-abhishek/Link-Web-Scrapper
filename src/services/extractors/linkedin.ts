import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, LinkedInCardData } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

function isGhostAvatar(url: string | null): boolean {
  if (!url) return true;
  const l = url.toLowerCase();
  return (
    l.includes('ghost_person') ||
    l.includes('ghost_profile') ||
    l.includes('ghost-avatar') ||
    l.includes('aero-v1') ||
    l.includes('9c8pery4andzj6ohjkjp54ma2')
  );
}

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

export const linkedInExtractor: PlatformExtractor<LinkedInCardData> = {
  platformKey: 'linkedin',
  async extract(targetUrl: string): Promise<ExtractionResult<LinkedInCardData>> {
    let title: string | null = null;
    let description: string | null = null;
    let snapshot: string | null = null;
    let authorName: string | null = null;
    let authorHeadline: string = '';
    let authorAvatar: string | null = null;
    let reactions = 0;
    let comments = 0;
    let reposts = 0;
    let publishedAt: string | null = null;
    let ogSiteName: string | null = 'LinkedIn';

    // 1. Fetch page HTML using LinkedInBot User-Agent (~200ms)
    try {
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 5000,
        maxRedirects: 5,
      });

      const html = String(res.data || '');
      const $ = cheerio.load(html);

      // Extract JSON-LD payload
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html() || '{}');
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
            if (json.creator?.jobTitle || json.creator?.description || json.creator?.headline) {
              authorHeadline = json.creator.jobTitle || json.creator.description || json.creator.headline || '';
            }
            if (json.creator?.image?.contentUrl || json.creator?.image) {
              const imgCandidate = typeof json.creator.image === 'string' ? json.creator.image : json.creator.image.contentUrl;
              if (imgCandidate && !isGhostAvatar(imgCandidate)) {
                authorAvatar = imgCandidate;
              }
            }

            if (json.datePublished || json.uploadDate) {
              publishedAt = json.datePublished || json.uploadDate;
            }

            if (json.headline || json.name) {
              title = json.headline || json.name;
            }
            if (json.description || json.articleBody) {
              description = json.description || json.articleBody;
            }
            if (json.thumbnailUrl || json.contentUrl || json.image?.url || json.image) {
              const imgCandidate = typeof json.image === 'string' ? json.image : json.image?.url;
              snapshot = json.thumbnailUrl || json.contentUrl || imgCandidate || null;
            }

            // Direct commentCount on JSON-LD object (e.g. DiscussionForumPosting)
            if (typeof json.commentCount === 'number') {
              comments = json.commentCount;
            }

            // Extract engagement statistics from interactionStatistic array
            if (Array.isArray(json.interactionStatistic)) {
              json.interactionStatistic.forEach((stat: any) => {
                const statType = stat.interactionType || '';
                const count = parseInt(stat.userInteractionCount || 0, 10);
                if (statType.includes('LikeAction') || statType.includes('ReactAction')) {
                  reactions = count;
                } else if (statType.includes('CommentAction')) {
                  comments = count;
                } else if (statType.includes('ShareAction')) {
                  reposts = count;
                }
              });
            }
          }
        } catch {
          // ignore parsing error
        }
      });

      // Open-Graph & DOM Fallbacks
      const rawOgTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || null;
      const rawOgDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;

      if (!title) {
        title = rawOgTitle;
      }
      if (!description) {
        description = rawOgDesc;
      }
      if (!snapshot) {
        snapshot = $('meta[property="og:image"]').attr('content') || null;
      }
      ogSiteName = $('meta[property="og:site_name"]').attr('content') || 'LinkedIn';

      // Fallback comment count parsing from metadata string ("| 10 comments on LinkedIn")
      const combinedMetaText = `${rawOgTitle || ''} ${rawOgDesc || ''} ${$.text()}`;
      if (comments === 0) {
        const commentMatch = combinedMetaText.match(/([\d,.]+[KMBkmb]?)\s*comments/i);
        if (commentMatch) {
          comments = parseFormattedNumber(commentMatch[1]);
        }
      }

      if (reactions === 0) {
        const reactionMatch = combinedMetaText.match(/([\d,.]+[KMBkmb]?)\s*(?:reactions|likes)/i);
        if (reactionMatch) {
          reactions = parseFormattedNumber(reactionMatch[1]);
        }
      }

      // Parse author name fallbacks: 1. rawOgTitle suffix, 2. URL slug
      if (!authorName || authorName === 'LinkedIn User') {
        if (rawOgTitle) {
          const match = rawOgTitle.match(/\|\s*([^|]+)$/);
          if (match && match[1]) {
            const candidate = match[1].trim();
            if (!candidate.toLowerCase().includes('linkedin') && !candidate.toLowerCase().includes('comments')) {
              authorName = candidate;
            }
          }
        }

        if (!authorName || authorName === 'LinkedIn User') {
          authorName = extractNameFromUrlSlug(targetUrl) || 'LinkedIn User';
        }
      }

      // Parse profile avatar image URL (strictly excluding comments DOM section to prevent picking commenters' avatars!)
      if (isGhostAvatar(authorAvatar)) {
        const $main = cheerio.load(html);
        $main('.comments, .comment, [class*="comment"]').remove();

        $main('img').each((_, el) => {
          const src = $main(el).attr('src') || $main(el).attr('data-delayed-url');
          const alt = $main(el).attr('alt') || '';
          const className = $main(el).attr('class') || '';

          if (
            src &&
            !isGhostAvatar(src) &&
            (src.includes('profile-displayphoto') ||
              className.includes('actor') ||
              (authorName && alt.toLowerCase().includes(authorName.toLowerCase())))
          ) {
            authorAvatar = src;
          }
        });

        if (isGhostAvatar(authorAvatar)) {
          authorAvatar = null;
        }
      }

      // Parse author headline from DOM elements
      if (!authorHeadline) {
        $('[class*="headline"], [class*="actor__description"], [class*="author-card__headline"]').each((_, el) => {
          const text = $(el).text().trim();
          if (
            text &&
            !authorHeadline &&
            text.length < 150 &&
            !text.toLowerCase().includes('comments') &&
            !text.toLowerCase().includes('view profile') &&
            !text.toLowerCase().includes('follow')
          ) {
            authorHeadline = text;
          }
        });
      }
    } catch {
      // Ignore network errors
    }

    // Clean title and description
    let finalTitle = title ? cleanTitle(cleanLinkedInText(title)) : 'LinkedIn Post';
    let finalDescription = description ? cleanLinkedInText(description) : '';

    const logo = resolveUrl('/favicon.ico', targetUrl) || 'https://static.licdn.com/aero-v1/sc/h/al2o9zrvru7aqj8e1x2rzsrca';

    const card_data: LinkedInCardData = {
      author: {
        name: authorName || 'LinkedIn User',
        headline: authorHeadline,
        avatar_url: authorAvatar,
      },
      metrics: {
        reactions,
        comments,
        reposts,
      },
      posted_at: publishedAt || new Date().toISOString(),
    };

    return {
      title: finalTitle,
      description: finalDescription,
      snapshot,
      logo,
      ogSiteName,
      card_data,
    };
  },
};
