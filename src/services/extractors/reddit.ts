import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, RedditCardData, MediaItem } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

const GENERIC_REDDIT_DESC_PATTERNS = [
  'explore this post and more from',
  'reddit gives you the best',
  'dive into anything',
  'the front page of the internet',
];

function extractSubreddit(targetUrl: string, rawTitle?: string | null): string {
  const match = targetUrl.match(/\/r\/([a-zA-Z0-9_]+)/i);
  if (match && match[1]) {
    return `r/${match[1]}`;
  }

  if (rawTitle) {
    const titleMatch = rawTitle.match(/From the ([a-zA-Z0-9_]+) community on Reddit/i);
    if (titleMatch && titleMatch[1]) {
      return `r/${titleMatch[1]}`;
    }
  }

  return 'r/unknown';
}

async function fetchSubredditIcon(cleanSub: string): Promise<string | null> {
  if (!cleanSub || cleanSub === 'unknown') return null;

  try {
    const res = await axios.get(`https://www.reddit.com/r/${cleanSub}/`, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
      },
      timeout: 3000,
    });

    const html = String(res.data || '');
    const $ = cheerio.load(html);

    const iconSrc =
      $('img.shreddit-subreddit-icon__icon').attr('src') ||
      $('img[src*="communityIcon"]').attr('src') ||
      $('img[src*="styles.redditmedia.com/t5_"]').attr('src') ||
      $('shreddit-subreddit-icon img').attr('src') ||
      $('span.avatar img').attr('src');

    if (iconSrc) {
      return iconSrc.replace(/&amp;/g, '&');
    }
  } catch {
    // Ignore icon fetch errors
  }

  return null;
}

export const redditExtractor: PlatformExtractor<RedditCardData> = {
  platformKey: 'reddit',
  async extract(targetUrl: string): Promise<ExtractionResult<RedditCardData>> {
    let resolvedPermalink = targetUrl;
    let ogTitle: string | null = null;
    let nameDesc: string | null = null;
    let ogDesc: string | null = null;
    let ogSiteName: string | null = 'Reddit';
    let upvotes = 0;
    let comments = 0;

    // 1. Fetch metadata HTML with facebookexternalhit to resolve canonical permalink & extract metrics (~200ms)
    try {
      const metaRes = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 4500,
        maxRedirects: 5,
      });

      const respUrl = metaRes.request?.res?.responseUrl || metaRes.config.url || targetUrl;
      const metaHtml = String(metaRes.data || '');
      const $meta = cheerio.load(metaHtml);

      const canonical = $meta('link[rel="canonical"]').attr('href') || $meta('meta[property="og:url"]').attr('content');
      if (canonical && canonical.includes('/comments/')) {
        resolvedPermalink = canonical;
      } else {
        resolvedPermalink = respUrl;
      }

      ogTitle = $meta('meta[property="og:title"]').attr('content') || $meta('title').text() || null;
      nameDesc = $meta('meta[name="description"]').attr('content') || null;
      ogDesc = $meta('meta[property="og:description"]').attr('content') || null;
      ogSiteName = $meta('meta[property="og:site_name"]').attr('content') || 'Reddit';

      // Parse votes & comments from name="description" or og:description
      const rawDescString = nameDesc || ogDesc || '';
      if (rawDescString) {
        const metricsMatch = rawDescString.match(/([\d,.]+[KMBkmb]?)\s*votes?,\s*([\d,.]+[KMBkmb]?)\s*comments?/i);
        if (metricsMatch) {
          upvotes = parseFormattedNumber(metricsMatch[1]);
          comments = parseFormattedNumber(metricsMatch[2]);
        }
      }
    } catch {
      // Ignore initial metadata fetch errors
    }

    // Clean canonical permalink
    const cleanPermalink = resolvedPermalink.split('?')[0].replace(/\/$/, '');
    const subredditName = extractSubreddit(cleanPermalink, ogTitle);
    const cleanSubredditName = subredditName.replace(/^r\//i, '').trim();

    // 2. Fetch RSS feed & Subreddit Icon in parallel (~250ms)
    const rssUrl = `${cleanPermalink}.rss`;
    let authorName = 'unknown';
    let postedAt = new Date().toISOString();
    let realMediaList: MediaItem[] = [];
    let rssTitle: string | null = null;
    let fullTextDescription = '';
    let iconUrl: string | null = null;

    try {
      const [rssRes, fetchedIcon] = await Promise.all([
        axios.get(rssUrl, {
          headers: {
            'User-Agent': 'Twitterbot/1.0',
          },
          timeout: 4000,
        }).catch(() => null),
        fetchSubredditIcon(cleanSubredditName),
      ]);

      iconUrl = fetchedIcon;

      if (rssRes && rssRes.data) {
        const xml = String(rssRes.data);
        const $xml = cheerio.load(xml, { xmlMode: true });
        const entry = $xml('entry').first();

        if (entry.length > 0) {
          rssTitle = entry.find('title').text().trim() || null;

          const rawAuthor = entry.find('author name').text();
          if (rawAuthor) {
            authorName = rawAuthor.replace(/^\/u\//i, '').replace(/^u\//i, '').trim();
          }

          const rawUpdated = entry.find('updated').text();
          if (rawUpdated) {
            postedAt = new Date(rawUpdated).toISOString();
          }

          const contentHtml = entry.find('content').text();
          if (contentHtml) {
            const $c = cheerio.load(contentHtml);

            // Extract FULL untruncated post body text from div.md
            const mdDiv = $c('div.md');
            if (mdDiv.length > 0) {
              mdDiv.find('br').replaceWith('\n');
              mdDiv.find('p').append('\n\n');
              fullTextDescription = mdDiv.text().trim().replace(/\n{3,}/g, '\n\n');
            }

            // Extract real user media URLs
            const rawUrls: string[] = [];
            $c('a, img').each((_, el) => {
              const href = $c(el).attr('href') || $c(el).attr('src');
              if (!href) return;

              if (
                href.includes('i.redd.it') ||
                href.includes('preview.redd.it') ||
                href.includes('external-preview.redd.it') ||
                href.includes('v.redd.it') ||
                /\.(jpg|jpeg|png|gif|webp)$/i.test(href)
              ) {
                let cleanMediaUrl = href.replace(/&amp;/g, '&');
                const idMatch = cleanMediaUrl.match(/(?:preview\.redd\.it|i\.redd\.it)\/([a-zA-Z0-9_]+\.(?:jpg|jpeg|png|gif|webp))/i);
                if (idMatch && idMatch[1]) {
                  cleanMediaUrl = `https://i.redd.it/${idMatch[1]}`;
                }
                rawUrls.push(cleanMediaUrl);
              }
            });

            // Filter out generic Reddit logos, banners, or icons
            const filteredUrls = Array.from(new Set(rawUrls)).filter((u) => {
              const l = u.toLowerCase();
              return !['redditstatic.com', 'snoo', 'icon', 'avatar', 'reddit_logo'].some((sig) => l.includes(sig));
            });

            realMediaList = filteredUrls.map((url) => ({
              type: url.includes('v.redd.it') || url.endsWith('.mp4') ? 'video' : 'image',
              url,
            }));
          }
        }
      }
    } catch {
      // Ignore RSS fetch errors
    }

    // Determine final title
    let finalTitle = rssTitle || ogTitle || 'Reddit Post';
    finalTitle = finalTitle.replace(/^From the [^:]+ community on Reddit:\s*/i, '').trim();
    finalTitle = cleanTitle(finalTitle) || 'Reddit Post';

    // Fallback description if div.md was not present (e.g. link posts)
    if (!fullTextDescription) {
      let rawDescription = nameDesc || ogDesc || '';
      if (rawDescription.toLowerCase().includes('explore this post') && nameDesc && !nameDesc.toLowerCase().includes('explore this post')) {
        rawDescription = nameDesc;
      }
      if (rawDescription) {
        rawDescription = rawDescription.replace(/^[\d,.]+[KMBkmb]?\s*votes?,\s*[\d,.]+[KMBkmb]?\s*comments?\.\s*/i, '').trim();
        const lowerDesc = rawDescription.toLowerCase();
        if (!GENERIC_REDDIT_DESC_PATTERNS.some((pattern) => lowerDesc.includes(pattern))) {
          fullTextDescription = rawDescription;
        }
      }
    }

    // Real media vs Text-only post differentiation
    const isTextOnlyPost = realMediaList.length === 0;
    const snapshot = isTextOnlyPost ? null : realMediaList[0].url;

    const card_data: RedditCardData = {
      subreddit: {
        name: subredditName,
        icon_url: iconUrl,
      },
      author: `u/${authorName}`,
      metrics: {
        upvotes,
        comments,
      },
      posted_at: postedAt,
      media: realMediaList,
    };

    return {
      title: finalTitle,
      description: fullTextDescription,
      snapshot,
      logo: resolveUrl('/favicon.ico', targetUrl) || 'https://www.reddit.com/favicon.ico',
      ogSiteName,
      card_data,
    };
  },
};
