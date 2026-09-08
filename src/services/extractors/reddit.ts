import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, RedditCardData, MediaItem } from './types';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';
import { playwrightEngine } from '../playwrightEngine';

const REDDIT_LOGO_URL = 'https://www.redditstatic.com/shreddit/assets/favicon/192x192.png';

const REDDIT_IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|gif|webp|heic|avif)(\?.*)?$/i;

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

  return 'r/reddit';
}

function extractPostId(url: string): string | null {
  const match = url.match(/\/comments\/([a-zA-Z0-9]+)/i);
  return match && match[1] ? match[1] : null;
}

function getSubredditIcon(subredditName: string, customIcon?: string | null): string {
  if (customIcon && customIcon.startsWith('http') && !customIcon.includes('default')) {
    return customIcon;
  }
  const clean = subredditName.replace(/^r\//i, '').trim();
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(clean || 'Reddit')}&background=ff4500&color=fff&size=128&bold=true`;
}

export function isValidRedditPostImage(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase().trim();

  // Exclude Reddit web page URLs
  if (
    lower.includes('reddit.com/gallery') ||
    lower.includes('reddit.com/r/') ||
    lower.includes('reddit.com/comments/') ||
    lower.includes('reddit.com/user/') ||
    lower.includes('reddit.com/u/')
  ) {
    return false;
  }

  // Exclude Reddit video, share banners, avatars, icons
  if (
    lower.includes('share.redd.it') ||
    lower.includes('v.redd.it') ||
    lower.includes('packaged-media.redd.it') ||
    lower.includes('redditstatic.com') ||
    lower.includes('reddit_logo') ||
    lower.includes('favicon') ||
    lower.includes('communityicon') ||
    lower.includes('avatar') ||
    lower.includes('snoovatar') ||
    lower.includes('.mp4') ||
    lower.includes('.m3u8')
  ) {
    return false;
  }

  // Must either be from a known Reddit image host or have a valid image file extension
  const isRedditImageHost =
    lower.includes('i.redd.it') ||
    lower.includes('preview.redd.it') ||
    lower.includes('external-preview.redd.it');

  const hasImageExtension = REDDIT_IMAGE_EXT_REGEX.test(lower);

  return isRedditImageHost || hasImageExtension;
}

export function extractRedditMediaId(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/(?:i\.redd\.it\/|preview\.redd\.it\/(?:[^\/]+-)?(?:v\d+-)?)([a-zA-Z0-9]{8,})/i);
  return match ? match[1] : null;
}

export function addOrUpgradeImage(mediaList: MediaItem[], imgUrl: string | null | undefined): void {
  if (!imgUrl || !isValidRedditPostImage(imgUrl)) return;
  const mediaId = extractRedditMediaId(imgUrl);
  if (mediaId) {
    const existingIndex = mediaList.findIndex((m) => {
      const existingId = extractRedditMediaId(m.url);
      return existingId === mediaId;
    });

    if (existingIndex !== -1) {
      if (imgUrl.includes('i.redd.it') && !mediaList[existingIndex].url.includes('i.redd.it')) {
        mediaList[existingIndex].url = imgUrl;
      }
      return;
    }
  } else {
    if (mediaList.some((m) => m.url === imgUrl)) return;
  }
  mediaList.push({ type: 'image', url: imgUrl });
}

// -------------------------------------------------------------
// Tier 1: PullPush Open API for Reddit (<500ms, Full Untruncated Data)
// -------------------------------------------------------------
async function tryPullPushReddit(postId: string): Promise<ExtractionResult<RedditCardData> | null> {
  try {
    const res = await axios.get(`https://api.pullpush.io/reddit/search/submission/?ids=${postId}`, {
      timeout: 2500,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TaggerApp/1.0',
      },
      validateStatus: (status) => status === 200,
    });

    const post = res.data?.data?.[0];
    if (!post || !post.title) {
      return null;
    }

    const title = cleanTitle(post.title) || 'Reddit Post';
    const description = post.selftext && post.selftext.trim() ? cleanDescription(post.selftext) || '' : '';

    let author = 'u/reddit_user';
    if (post.author && post.author !== '[deleted]' && post.author !== '[removed]') {
      author = post.author.startsWith('u/') ? post.author : `u/${post.author}`;
    }

    const subredditName = post.subreddit
      ? post.subreddit.startsWith('r/')
        ? post.subreddit
        : `r/${post.subreddit}`
      : 'r/reddit';

    const upvotes = post.score ?? post.ups ?? 0;
    const comments = post.num_comments ?? 0;

    const mediaList: MediaItem[] = [];
    const postUrl = post.url || post.url_overridden_by_dest || '';

    // Check direct image url
    if (postUrl && (/\.(jpg|jpeg|png|gif|webp)$/i.test(postUrl) || postUrl.includes('i.redd.it'))) {
      if (isValidRedditPostImage(postUrl)) {
        addOrUpgradeImage(mediaList, postUrl);
      }
    } else if (post.is_video || postUrl.includes('v.redd.it')) {
      const vidUrl = post.media?.reddit_video?.fallback_url || postUrl;
      mediaList.push({ type: 'video', url: vidUrl });
    }

    // Check gallery data (e.g. multi-image posts)
    if (Array.isArray(post.gallery_data?.items)) {
      post.gallery_data.items.forEach((gItem: any) => {
        if (gItem?.media_id) {
          const galleryUrl = `https://i.redd.it/${gItem.media_id}.jpg`;
          addOrUpgradeImage(mediaList, galleryUrl);
        }
      });
    }

    // Check preview image if no direct media link found
    if (mediaList.length === 0 && post.preview?.images?.[0]?.source?.url) {
      const previewUrl = post.preview.images[0].source.url.replace(/&amp;/g, '&');
      addOrUpgradeImage(mediaList, previewUrl);
    }

    const snapshot =
      mediaList[0]?.url ||
      (post.thumbnail && post.thumbnail.startsWith('http') && !post.thumbnail.includes('default') && !post.thumbnail.includes('nsfw')
        ? post.thumbnail
        : null);

    const iconUrl = getSubredditIcon(subredditName, post.sr_detail?.community_icon || post.sr_detail?.icon_img);

    return {
      title,
      description,
      logo: REDDIT_LOGO_URL,
      ogSiteName: 'Reddit',
      card_data: {
        subreddit: {
          name: subredditName,
          icon_url: iconUrl,
        },
        author,
        metrics: {
          upvotes,
          comments,
        },
        posted_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : new Date().toISOString(),
        media: mediaList,
      },
    };
  } catch {
    return null;
  }
}

function cleanRedditTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (/^From the .* community on Reddit$/i.test(trimmed)) {
    return '';
  }
  return trimmed
    .replace(/^From the [^:]+ community on Reddit:\s*/i, '')
    .replace(/\s*:\s*r\/[a-zA-Z0-9_]+$/i, '')
    .trim();
}

// -------------------------------------------------------------
// Reddit Extractor with Multi-Tier Architecture
// -------------------------------------------------------------
export const redditExtractor: PlatformExtractor<RedditCardData> = {
  platformKey: 'reddit',
  async extract(targetUrl: string): Promise<ExtractionResult<RedditCardData>> {
    let canonicalUrl = targetUrl;
    let title: string | null = null;
    let author: string | null = null;
    let upvotes = 0;
    let comments = 0;
    let snapshot: string | null = null;
    let description: string | null = null;
    let subredditName = extractSubreddit(targetUrl);
    let subredditIcon: string | null = null;
    const mediaList: MediaItem[] = [];

    // -----------------------------------------------------------
    // Tier 1: Fast HTTP Shortlink Resolution & Metadata (Twitterbot UA)
    // -----------------------------------------------------------
    try {
      const res = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'Twitterbot/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 5,
        timeout: 3500,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      if (res && res.data) {
        const finalUrl = res.request?.res?.responseUrl || res.config.url;
        const $ = cheerio.load(String(res.data));
        const ogUrl = $('meta[property="og:url"]').attr('content');
        if (ogUrl && ogUrl.includes('/comments/')) {
          canonicalUrl = ogUrl;
        } else if (finalUrl && finalUrl.includes('/comments/')) {
          canonicalUrl = finalUrl;
        }

        const h1Title = $('h1[slot="title"], h1[id^="post-title"]').first().text().trim();
        if (h1Title) {
          title = cleanTitle(cleanRedditTitle(h1Title));
        } else {
          const ogTitle = cleanRedditTitle($('meta[property="og:title"]').attr('content'));
          const docTitle = cleanRedditTitle($('title').text());
          const rawTitle = ogTitle || docTitle || '';
          if (rawTitle && rawTitle !== 'Reddit' && rawTitle !== 'Reddit Post') {
            title = cleanTitle(rawTitle);
          }
        }

        const articleBodyEl = $('shreddit-post-text-body [property="schema:articleBody"]').first();
        if (articleBodyEl.length > 0) {
          const ps: string[] = [];
          articleBodyEl.find('p').each((_, el) => {
            const pText = $(el).text().trim();
            if (pText) ps.push(pText);
          });
          description = ps.length > 0 ? ps.join('\n\n') : articleBodyEl.text().trim();
        } else {
          const fallbackBody = $('shreddit-post-text-body [data-post-click-location="text-body"]').first().text().trim() ||
                               $('shreddit-post-text-body').first().text().trim();
          if (fallbackBody) description = fallbackBody;
        }
        if (description) {
          description = cleanDescription(description);
        }

        const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        if (ogImage && isValidRedditPostImage(ogImage)) {
          snapshot = ogImage;
        }

        const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
        const votesMatch = metaDesc.match(/([\d,.]+[KMBkmb]?)\s*votes?/i);
        if (votesMatch) upvotes = parseFormattedNumber(votesMatch[1]);
        const commentsMatch = metaDesc.match(/([\d,.]+[KMBkmb]?)\s*comments?/i);
        if (commentsMatch) comments = parseFormattedNumber(commentsMatch[1]);

        subredditName = extractSubreddit(canonicalUrl, h1Title || $('title').text());
      }
    } catch {
      // Fall through to next tiers
    }

    // -----------------------------------------------------------
    // Tier 2: Official Reddit oEmbed API (<300ms)
    // -----------------------------------------------------------
    const postId = extractPostId(canonicalUrl);
    if (canonicalUrl.includes('/comments/')) {
      try {
        const oembedRes = await axios.get(`https://www.reddit.com/oembed?url=${encodeURIComponent(canonicalUrl)}`, {
          headers: { 'User-Agent': 'TaggerApp/1.0' },
          timeout: 2500,
        });
        if (oembedRes.data) {
          if (oembedRes.data.author_name) {
            author = `u/${oembedRes.data.author_name}`;
          }
          if (!title && oembedRes.data.title) {
            title = cleanTitle(cleanRedditTitle(oembedRes.data.title));
          }
        }
      } catch {
        // Fall through
      }
    }

    // -----------------------------------------------------------
    // Tier 3: PullPush Open API (if postId exists and data is missing)
    // -----------------------------------------------------------
    if (postId && (!author || mediaList.length === 0)) {
      const pullPushResult = await tryPullPushReddit(postId);
      if (pullPushResult) {
        if (!title) title = pullPushResult.title;
        if (!author || author.includes('_user')) author = pullPushResult.card_data.author;
        if (pullPushResult.description && !description) description = pullPushResult.description;
        if (pullPushResult.card_data.metrics.upvotes && !upvotes) upvotes = pullPushResult.card_data.metrics.upvotes;
        if (pullPushResult.card_data.metrics.comments && !comments) comments = pullPushResult.card_data.metrics.comments;
        if (pullPushResult.card_data.media.length > 0) {
          pullPushResult.card_data.media.forEach((m) => {
            if (m.type === 'image') {
              addOrUpgradeImage(mediaList, m.url);
            } else if (!mediaList.some((existing) => existing.url === m.url)) {
              mediaList.push(m);
            }
          });
        }
        if (pullPushResult.snapshot && !snapshot) snapshot = pullPushResult.snapshot;
        if (pullPushResult.card_data.subreddit.icon_url && !pullPushResult.card_data.subreddit.icon_url.includes('ui-avatars')) {
          subredditIcon = pullPushResult.card_data.subreddit.icon_url;
        }
      }
    }

    let postedAt: string | null = null;

    // -----------------------------------------------------------
    // Tier 4: Playwright Hydration (shreddit-post, shreddit-player, community icon)
    // -----------------------------------------------------------
    if (!author || mediaList.length === 0 || !subredditIcon) {
      try {
        const pwResult = await playwrightEngine.scrape<any>(canonicalUrl, {
          waitSelector: 'shreddit-post',
          waitTimeout: 4000,
          customEvaluator: async (page) => {
            return await page.evaluate(() => {
              const sp = document.querySelector('shreddit-post');
              if (!sp) return null;

              // Title: Target specifically <h1 id="post-title-..." slot="title">
              const titleEl = sp.querySelector('h1[slot="title"], h1[id^="post-title"]') || document.querySelector('h1[slot="title"], h1[id^="post-title"]');
              const postTitle = titleEl ? (titleEl.textContent || '').trim() : (sp.getAttribute('post-title') || document.title);

              const postAuthor = sp.getAttribute('author');
              const postScore = sp.getAttribute('score');
              const postCommentCount = sp.getAttribute('comment-count');
              const postSubreddit = sp.getAttribute('subreddit-prefixed-name');
              const postType = sp.getAttribute('post-type');
              const createdAt = sp.getAttribute('created-timestamp');

              // Description: Target specifically <shreddit-post-text-body slot="text-body">
              const bodyCustomEl = sp.querySelector('shreddit-post-text-body[slot="text-body"], shreddit-post-text-body') || document.querySelector('shreddit-post-text-body');
              let textBody = '';
              if (bodyCustomEl) {
                const articleBody = bodyCustomEl.querySelector('[property="schema:articleBody"]');
                if (articleBody) {
                  const ps = Array.from(articleBody.querySelectorAll('p'));
                  if (ps.length > 0) {
                    textBody = ps.map((p: any) => (p.innerText || p.textContent || '').trim()).filter(Boolean).join('\n\n');
                  } else {
                    textBody = (articleBody as HTMLElement).innerText || articleBody.textContent || '';
                  }
                } else {
                  const fallbackEl = bodyCustomEl.querySelector('[data-post-click-location="text-body"], [slot="text-body"]') || bodyCustomEl;
                  textBody = (fallbackEl as HTMLElement).innerText || fallbackEl.textContent || '';
                }
                textBody = textBody.trim();
              }

              // Player / Video
              const player = sp.querySelector('shreddit-player');
              let videoUrl: string | null = null;
              let videoPoster: string | null = null;
              if (player) {
                // Check packaged media JSON for direct high quality MP4
                const packagedJsonStr = player.getAttribute('packaged-media-json');
                if (packagedJsonStr) {
                  try {
                    const parsed = JSON.parse(packagedJsonStr);
                    const permutations = parsed?.playbackMp4s?.permutations;
                    if (Array.isArray(permutations) && permutations.length > 0) {
                      const sorted = [...permutations].sort((a: any, b: any) => {
                        const hA = a?.source?.dimensions?.height || 0;
                        const hB = b?.source?.dimensions?.height || 0;
                        return hB - hA;
                      });
                      if (sorted[0]?.source?.url) {
                        videoUrl = sorted[0].source.url;
                      }
                    }
                  } catch {}
                }

                if (!videoUrl) {
                  videoUrl = player.getAttribute('src') || player.querySelector('source')?.getAttribute('src') || null;
                }

                const previewAttr = player.getAttribute('preview');
                const posterAttr = player.getAttribute('poster');
                const imgPoster = player.querySelector('img')?.getAttribute('src');

                if (posterAttr && !posterAttr.includes('.mp4') && !posterAttr.includes('.m3u8')) {
                  videoPoster = posterAttr;
                } else if (imgPoster) {
                  videoPoster = imgPoster;
                } else if (previewAttr && !previewAttr.includes('.mp4') && !previewAttr.includes('.m3u8')) {
                  videoPoster = previewAttr;
                }
              }

              // Images / Gallery: Target .media-lightbox-img, zoomable-img, and gallery-carousel
              const images: string[] = [];
              const contentHref = sp.getAttribute('content-href');
              if (
                contentHref &&
                (contentHref.includes('i.redd.it') ||
                 contentHref.includes('preview.redd.it') ||
                 /\.(jpg|jpeg|png|gif|webp|heic|avif)(\?.*)?$/i.test(contentHref)) &&
                !contentHref.includes('reddit.com/gallery') &&
                !contentHref.includes('reddit.com/r/') &&
                !contentHref.includes('reddit.com/comments/')
              ) {
                images.push(contentHref);
              }

              // 1. Zoomable images (highest resolution original)
              const zoomables = Array.from(sp.querySelectorAll('zoomable-img img'));
              zoomables.forEach((img: any) => {
                if (img.src) images.push(img.src);
              });

              // 2. Targeted .media-lightbox-img containers (excluding background filter images)
              const mediaLightboxContainers = Array.from(sp.querySelectorAll('div.media-lightbox-img, gallery-carousel li, [slot="post-media-container"]'));
              mediaLightboxContainers.forEach((container: any) => {
                const primaryImgs = Array.from(container.querySelectorAll('img#post-image, img[data-post-media-primary], img.preview-img'));
                primaryImgs.forEach((img: any) => {
                  if (img.src && !img.classList.contains('post-background-image-filter')) {
                    images.push(img.src);
                  }
                });
              });

              // 3. Carousel slides
              const carouselImgs = Array.from(sp.querySelectorAll('gallery-carousel figure img, gallery-carousel ul li img'));
              carouselImgs.forEach((img: any) => {
                if (img.src && !img.classList.contains('post-background-image-filter')) {
                  images.push(img.src);
                }
              });

              // 4. Fallback if no images found yet
              if (images.length === 0) {
                const fallbackImgs = Array.from(sp.querySelectorAll('shreddit-aspect-ratio img, [slot="post-media-container"] img'));
                fallbackImgs.forEach((img: any) => {
                  if (img.src && !img.classList.contains('post-background-image-filter')) {
                    images.push(img.src);
                  }
                });
              }

              // Subreddit Community Icon
              const subIcon =
                document.querySelector('img.shreddit-subreddit-icon__icon, faceplate-img.community-icon, img.community-icon')?.getAttribute('src') ||
                document.querySelector('[data-testid="subreddit-icon"] img')?.getAttribute('src') ||
                null;

              return {
                postTitle,
                postAuthor,
                postScore,
                postCommentCount,
                postSubreddit,
                postType,
                createdAt,
                textBody,
                videoUrl,
                videoPoster,
                images,
                subIcon,
              };
            });
          },
        });

        const c = pwResult.customData;
        if (c) {
          if (c.postTitle && (!title || title === 'Reddit Post' || title === 'Reddit' || title.includes('community on Reddit'))) {
            title = cleanTitle(cleanRedditTitle(c.postTitle));
          }
          if (c.postAuthor && (!author || author.includes('_user'))) {
            author = `u/${c.postAuthor}`;
          }
          if (c.postScore) upvotes = parseInt(c.postScore, 10) || upvotes;
          if (c.postCommentCount) comments = parseInt(c.postCommentCount, 10) || comments;
          if (c.postSubreddit) subredditName = c.postSubreddit;
          if (c.createdAt) postedAt = c.createdAt;

          if (c.textBody) {
            const cleanBody = cleanDescription(c.textBody);
            if (
              cleanBody &&
              cleanBody.toLowerCase() !== subredditName.toLowerCase() &&
              cleanBody.toLowerCase() !== (c.postAuthor || '').toLowerCase() &&
              !cleanBody.startsWith('r/')
            ) {
              description = cleanBody;
            }
          }

          if (c.subIcon) subredditIcon = c.subIcon;

          if (c.videoUrl) {
            if (!mediaList.some((m) => m.type === 'video')) {
              mediaList.unshift({ type: 'video', url: c.videoUrl });
            }
            if (c.videoPoster) snapshot = c.videoPoster;
          }

          if (Array.isArray(c.images)) {
            c.images.forEach((img: string) => {
              addOrUpgradeImage(mediaList, img);
            });
            if (!snapshot && mediaList.length > 0) {
              snapshot = mediaList[0].url;
            }
          }
        }
      } catch {
        // Ignore Playwright error
      }
    }

    if (!author) {
      author = `u/${subredditName.replace(/^r\//, '')}_user`;
    }
    if (!title) {
      title = 'Reddit Post';
    }
    if (!subredditIcon) {
      subredditIcon = getSubredditIcon(subredditName);
    }
    if (snapshot && isValidRedditPostImage(snapshot)) {
      if (!mediaList.some((m) => m.type === 'video') && mediaList.length === 0) {
        addOrUpgradeImage(mediaList, snapshot);
      }
    }

    return {
      title,
      description: description || null,
      logo: REDDIT_LOGO_URL,
      ogSiteName: 'Reddit',
      card_data: {
        subreddit: {
          name: subredditName,
          icon_url: subredditIcon,
        },
        author,
        metrics: {
          upvotes,
          comments,
        },
        posted_at: postedAt || new Date().toISOString(),
        media: mediaList,
      },
    };
  },
};
