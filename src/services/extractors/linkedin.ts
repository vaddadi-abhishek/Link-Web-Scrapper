import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, LinkedInCardData, MediaItem } from './types';
import { playwrightEngine } from '../playwrightEngine';
import { cleanTitle, cleanDescription } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';
import { extractArticleContent } from '../cheerioScraper';

const LINKEDIN_LOGO_URL = 'https://static.licdn.com/aero-v1/sc/h/al2o9zrvru7aqj8e1x2rzsrca';

export function isLinkedInArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.includes('/pulse/') || path.includes('/article/');
  } catch {
    return false;
  }
}

export function isLinkedInTopicCollectionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.includes('/top-content/') || path.includes('/topic/');
  } catch {
    return false;
  }
}

export function isLinkedInNewsStoryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.includes('/news/story/') || path.includes('/news/');
  } catch {
    return false;
  }
}

export function isLinkedInNewsletterUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return path.includes('/newsletters/') || path.includes('/newsletter/');
  } catch {
    return false;
  }
}

function cleanLinkedInText(text: string | null): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/^[\s\r\n"\\]+|[\s\r\n"}\\]+$/g, '')
    .replace(/\s*\|\s*[\d,.]+[KMBkmb]?\s*comments(?:\s+on\s+LinkedIn)?/gi, '')
    .replace(/\s*\|\s*LinkedIn\s*$/i, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cleanLinkedInTitle(title: string | null): string {
  if (!title) return '';
  return title
    .replace(/\s*\|\s*[^|]*?(?:posted|on LinkedIn|LinkedIn).*$/gi, '')
    .replace(/\s*\|\s*LinkedIn.*$/gi, '')
    .trim();
}

function extractNameFromUrlSlug(url: string): string | null {
  const match = url.match(/\/(?:posts|pulse)\/([a-zA-Z0-9-]+?)(?:_[a-z0-9]+|-activity|-vanderburg|-9vkfc|\/|$)/i);
  if (match && match[1]) {
    const raw = match[1].replace(/-/g, ' ').trim();
    if (raw && raw.length > 2 && raw.length < 50) {
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

export function getMainPostElement($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  // 1. Primary post article in public view (explicitly NOT related posts / crosslinks)
  const primaryArticle = $('article:not(.related-posts__crosslink):not([class*="related-posts"])').first();
  if (primaryArticle.length > 0) return primaryArticle;

  // 2. Activity card with comments (top post container)
  const activityCard = $(
    '.main-feed-activity-card-with-comments, .main-feed-activity-card:not(.related-posts__crosslink):not([class*="related-posts"])'
  ).first();
  if (activityCard.length > 0) return activityCard;

  // 3. Feed shared update container
  const feedShared = $('.feed-shared-update-v2').first();
  if (feedShared.length > 0) return feedShared;

  // 4. Fallback to first article or main
  const firstArticle = $('article').first();
  if (firstArticle.length > 0) return firstArticle;

  return $('main').first().length > 0 ? $('main').first() : $('body');
}

export function isInsideRelatedPosts($el: cheerio.Cheerio<any>): boolean {
  return (
    $el.closest('.related-posts, .related-posts__crosslink, [class*="related-posts"], [data-test-id*="related"]').length > 0
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
  isArticleType: boolean;
  isTopicCollection: boolean;
  isNewsStory: boolean;
  isNewsletter: boolean;
  headline: string | null;
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
  let isArticleType = false;
  let isTopicCollection = false;
  let isNewsStory = false;
  let isNewsletter = false;
  let headline: string | null = null;

  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const json = JSON.parse($(s).text() || '{}');
        const type = json['@type'] || '';
        const isArticleSchema = type === 'Article' || type === 'BlogPosting';
        if (isArticleSchema) {
          isArticleType = true;
          if (json.headline && typeof json.headline === 'string') {
            headline = json.headline.trim();
          }
        }
        if (type === 'CollectionPage') {
          isTopicCollection = true;
          if (json.name && typeof json.name === 'string') {
            headline = json.name.trim();
          }
        }
        if (type === 'NewsArticle') {
          isNewsStory = true;
          if (json.headline && typeof json.headline === 'string') {
            headline = json.headline.trim();
          }
        }
        if (type === 'Periodical' || type === 'Series') {
          isNewsletter = true;
          if (json.name && typeof json.name === 'string') {
            headline = json.name.trim();
          }
        }

        if (
          type === 'SocialMediaPosting' ||
          type === 'VideoObject' ||
          type === 'Article' ||
          type === 'BlogPosting' ||
          type === 'NewsArticle' ||
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
            json.image.forEach((img: unknown) => {
              if (typeof img === 'string') {
                rawImages.push(img);
              } else if (img && typeof img === 'object') {
                const imgObj = img as Record<string, unknown>;
                const u = imgObj.url || imgObj.contentUrl;
                if (typeof u === 'string') rawImages.push(u);
              }
            });
          } else if (typeof json.image === 'string') {
            rawImages.push(json.image);
          } else if (json.image && typeof json.image === 'object') {
            const u = json.image.url || json.image.contentUrl;
            if (typeof u === 'string') rawImages.push(u);
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
            json.interactionStatistic.forEach((statItem: unknown) => {
              if (!statItem || typeof statItem !== 'object') return;
              const stat = statItem as Record<string, unknown>;
              const statType = typeof stat.interactionType === 'string' ? stat.interactionType : '';
              const count = parseInt(String(stat.userInteractionCount || 0), 10);
              if (statType.includes('LikeAction') || statType.includes('ReactAction')) reactions = count;
              else if (statType.includes('CommentAction')) comments = count;
              else if (statType.includes('ShareAction')) reposts = count;
            });
          }
        }
      } catch {}
    });

    // Extract post images strictly from the primary post container, ignoring related/recommended posts
    const $mainPost = getMainPostElement($);
    $mainPost
      .find(
        'img[data-delayed-url*="feedshare-"], img[src*="feedshare-"], img[data-src*="feedshare-"], ' +
        'img[srcset*="image-shrink_"], img[src*="image-shrink_"], img[data-delayed-url*="image-shrink_"], ' +
        'img[srcset*="/dms/image/"], img[src*="/dms/image/"], img[data-delayed-url*="/dms/image/"], ' +
        'img[alt="View image"], figure img, div[style*="aspect-ratio"] img, [style*="aspect-ratio"] img'
      )
      .each((_, el) => {
        const $img = $(el);
        if (isInsideRelatedPosts($img)) return;
        const srcset = $img.attr('srcset');
        let src = $img.attr('data-delayed-url') || $img.attr('data-src') || $img.attr('src');
        if (srcset) {
          const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
          const partsWithWidth = parts.map((p) => {
            const wMatch = p[1] ? p[1].match(/^(\d+)w$/) : null;
            return { url: p[0], width: wMatch ? parseInt(wMatch[1], 10) : 0 };
          });
          const hasWidths = partsWithWidth.some((p) => p.width > 0);
          if (hasWidths) {
            partsWithWidth.sort((a, b) => b.width - a.width);
            src = partsWithWidth[0].url.replace(/&amp;/g, '&');
          } else if (parts.length > 0) {
            const highRes = parts.find((p) => p[0].includes('shrink_1280') || p[0].includes('shrink_800') || p[0].includes('high-res'));
            src = (highRes ? highRes[0] : parts[parts.length - 1][0]).replace(/&amp;/g, '&');
          }
        }
        if (src && !isExcludedPostMedia(src)) {
          rawImages.push(src);
        }
      });

    const ogImg = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    if (ogImg && !isExcludedPostMedia(ogImg)) {
      rawImages.push(ogImg);
    }

    // Author Avatar: extract strictly from primary post author containers, NEVER from commenters or related posts
    if (!authorAvatar || isGhostAvatar(authorAvatar)) {
      const lockup = $mainPost.find('[data-test-id="main-feed-activity-card__entity-lockup"], .feed-shared-actor, .update-components-actor');
      if (lockup.length > 0) {
        const img = lockup.find('img').first();
        const url = img.attr('data-delayed-url') || img.attr('src');
        if (url && !isGhostAvatar(url)) {
          authorAvatar = url;
        }
      }

      if (!authorAvatar || isGhostAvatar(authorAvatar)) {
        const authorCard = $mainPost.find('.public-post-author-card');
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
    const dmsMatch = cleanUrl.match(/\/dms\/(?:image|document)\/(?:v2\/)?([^/?#]+)/i);
    const idMatch = cleanUrl.match(/\/feedshare-image[^\/]*\/([^\/?]+)/);
    const key = dmsMatch ? dmsMatch[1] : (idMatch ? idMatch[1] : cleanUrl.split('?')[0]);
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
    isArticleType,
    isTopicCollection,
    isNewsStory,
    isNewsletter,
    headline,
  };
}

interface LinkedInDocResult {
  slides: string[];
  pdfUrl: string | null;
  title: string | null;
  pageCount: number | null;
}

async function extractLinkedInDocumentSlides(
  $: cheerio.CheerioAPI,
  $container?: cheerio.Cheerio<any>
): Promise<LinkedInDocResult> {
  const slides: string[] = [];
  let pdfUrl: string | null = null;
  let title: string | null = null;
  let pageCount: number | null = null;

  const $scope = $container && $container.length > 0 ? $container : getMainPostElement($);

  // 1. Check iframe[data-native-document-config] or any element with data-native-document-config
  const configAttr =
    $scope.find('iframe[data-native-document-config]').attr('data-native-document-config') ||
    $scope.find('*[data-native-document-config]').attr('data-native-document-config') ||
    $('iframe[data-native-document-config]').attr('data-native-document-config') ||
    $('*[data-native-document-config]').attr('data-native-document-config');

  if (configAttr) {
    try {
      const config = JSON.parse(configAttr);
      const doc = config.doc || {};
      if (doc.title) title = doc.title;
      if (doc.totalPageCount) {
        pageCount = typeof doc.totalPageCount === 'number' ? doc.totalPageCount : parseInt(doc.totalPageCount, 10);
      }

      // Cover pages fallback
      if (Array.isArray(doc.coverPages)) {
        for (const cp of doc.coverPages) {
          const src = cp?.config?.src || cp?.imageManifestUrl;
          if (src && typeof src === 'string' && !slides.includes(src)) {
            slides.push(src);
          }
        }
      }

      // If manifestUrl is present, fetch it for full resolution slides & pdfUrl
      if (doc.manifestUrl) {
        try {
          const mRes = await axios.get(doc.manifestUrl, {
            headers: { 'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)' },
            timeout: 4000,
          });
          if (mRes.data) {
            if (mRes.data.transcribedDocumentUrl) {
              pdfUrl = mRes.data.transcribedDocumentUrl;
            }
            const resolutions: Array<{ width: number; height: number; imageManifestUrl: string }> =
              mRes.data.perResolutions || [];
            // Prefer 800px or 1280px width, else first resolution
            const bestRes =
              resolutions.find((r) => r.width >= 700 && r.width <= 1000) ||
              resolutions.find((r) => r.width > 1000) ||
              resolutions[resolutions.length - 1] ||
              resolutions[0];

            if (bestRes?.imageManifestUrl) {
              const imgRes = await axios.get(bestRes.imageManifestUrl, {
                headers: { 'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)' },
                timeout: 4000,
              });
              if (Array.isArray(imgRes.data?.pages)) {
                slides.length = 0; // Replace cover pages with full deck of pages
                for (const pageUrl of imgRes.data.pages) {
                  if (typeof pageUrl === 'string' && !slides.includes(pageUrl)) {
                    slides.push(pageUrl);
                  }
                }
              }
            }
          }
        } catch {
          // ignore manifest error
        }
      }
    } catch {
      // ignore json parse error
    }
  }

  // 2. Fallback: Parse carousel slides directly from DOM (e.g. from container or user HTML)
  $scope
    .find(
      '.carousel-slide img, .native-document-container img, li[data-ssplayer-slide-index] img, img[data-src*="feedshare-document"], img[src*="feedshare-document"]'
    )
    .each((_, el) => {
      const $img = $(el);
      if (isInsideRelatedPosts($img)) return;
      const src = $img.attr('data-src') || $img.attr('src') || $img.attr('data-delayed-url');
      if (src && !slides.includes(src)) {
        slides.push(src);
      }
    });

  // Check download button for PDF URL
  const downloadLink =
    $scope.find('a[href*="feedshare-document-pdf"], .ssplayer-virus-scan-container__download-button, a.ssplayer-topbar-action-download').attr('href') ||
    $('a[href*="feedshare-document-pdf"], .ssplayer-virus-scan-container__download-button, a.ssplayer-topbar-action-download').attr('href');
  if (downloadLink && !pdfUrl) {
    pdfUrl = downloadLink;
  }

  // Check title in player
  const topbarTitle =
    $scope.find('.ssplayer-topbar-title-text').text().trim() ||
    $('.ssplayer-topbar-title-text').text().trim();
  if (topbarTitle && !title) {
    title = topbarTitle;
  }

  // Check page count in player
  if (!pageCount) {
    const pageLengthText =
      $scope.find('span[data-pagination-length], .ssplayer-pagination-length').text().trim() ||
      $('span[data-pagination-length], .ssplayer-pagination-length').text().trim();
    if (pageLengthText) {
      const match = pageLengthText.match(/(\d+)/);
      if (match) pageCount = parseInt(match[1], 10);
    }
    if (!pageCount) {
      const previewPages =
        $scope.find('.ssplayer-topbar-details').first().text().trim() ||
        $('.ssplayer-topbar-details').first().text().trim();
      const m = previewPages.match(/(\d+)\s*pages?/i);
      if (m) pageCount = parseInt(m[1], 10);
    }
    if (!pageCount && slides.length > 0) {
      pageCount = slides.length;
    }
  }

  return { slides, pdfUrl, title, pageCount };
}

export const linkedInExtractor: PlatformExtractor<LinkedInCardData> = {
  platformKey: 'linkedin',
  async extract(targetUrl: string, html?: string): Promise<ExtractionResult<LinkedInCardData>> {
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
    let documentInfo: {
      title?: string | null;
      page_count?: number | null;
      pdf_url?: string | null;
    } | null = null;

    let isTopicCollection = isLinkedInTopicCollectionUrl(targetUrl);
    let isNewsStory = isLinkedInNewsStoryUrl(targetUrl);
    let isNewsletter = isLinkedInNewsletterUrl(targetUrl);
    let isArticle = isLinkedInArticleUrl(targetUrl);
    let pageTitle: string | null = null;
    let articleTitle: string | null = null;
    let articleContent: string | null = null;
    let wordCount: number | null = null;
    let readingTimeMinutes: number | null = null;

    let rawHtml = html || '';

    // -------------------------------------------------------------
    // Tier 1: Fast-Path Axios & Cheerio with LinkedInBot Headers (~250ms)
    // -------------------------------------------------------------
    if (!rawHtml) {
      try {
        const res = await axios.get(targetUrl, {
          headers: {
            'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          maxRedirects: 5,
          timeout: 4000,
        });

        if (res && res.data) {
          rawHtml = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        }
      } catch {
        // Fallback to Playwright if Axios fails
      }
    }

    if (rawHtml) {
      const parsed = parseLinkedInJsonLd(rawHtml);
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

      if (parsed.isTopicCollection) isTopicCollection = true;
      if (parsed.isNewsStory && !isArticle) isNewsStory = true;
      if (parsed.isNewsletter) isNewsletter = true;
      if (parsed.isArticleType && !isNewsStory && !isTopicCollection) isArticle = true;

      const $ = cheerio.load(rawHtml);

      // Top priority: twitter tags first, followed by meta tags, followed by og tags
      const twitterTitle = $('meta[name="twitter:title"]').attr('content');
      const metaTitle = $('meta[name="title"]').attr('content') || $('title').text();
      const ogTitle = $('meta[property="og:title"]').attr('content');
      const rawTitle = twitterTitle || metaTitle || ogTitle || parsed.headline || null;
      if (rawTitle) {
        pageTitle = cleanLinkedInTitle(rawTitle);
      }

      const twitterDesc = $('meta[name="twitter:description"]').attr('content');
      const metaDesc = $('meta[name="description"]').attr('content');
      const ogDesc = $('meta[property="og:description"]').attr('content');
      const metaSnippet = twitterDesc || metaDesc || ogDesc || null;
      const rawDesc = (parsed.description && metaSnippet && parsed.description.length > metaSnippet.length)
        ? parsed.description
        : (metaSnippet || parsed.description || null);
      if (rawDesc) {
        description = rawDesc;
      }

      if (!isNewsStory && !isTopicCollection) {
        const twitterImage = $('meta[name="twitter:image"]').attr('content');
        const metaImage = $('meta[name="image"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content');
        const candidateImage = twitterImage || metaImage || ogImage || null;
        if (!snapshot && candidateImage && !isExcludedPostMedia(candidateImage)) {
          snapshot = candidateImage;
        }
      }

      if (isArticle) {
        articleTitle = pageTitle;
        const articleRes = extractArticleContent($);
        articleContent = articleRes.content;
        wordCount = articleRes.wordCount;
        readingTimeMinutes = articleRes.readingTimeMinutes;
      }

      if (!authorName) {
        const titleForAuthor = ogTitle || twitterTitle || metaTitle || '';
        const match = titleForAuthor.match(/\|\s*([^|]+?)(?:\s+posted|\s+on LinkedIn|$)/i);
        if (match && match[1] && !match[1].toLowerCase().includes('linkedin')) {
          authorName = match[1].trim();
        }
      }

      // Check for LinkedIn native document / PDF presentation
      // Only do this for individual posts (not for collection/topic hubs that aggregate multiple posts)
      if (!isTopicCollection && !isNewsStory) {
        const docResult = await extractLinkedInDocumentSlides($);
        if (docResult.slides.length > 0 || docResult.pdfUrl || docResult.title) {
          documentInfo = {
            title: docResult.title || null,
            page_count: docResult.pageCount || (docResult.slides.length > 0 ? docResult.slides.length : null),
            pdf_url: docResult.pdfUrl || null,
          };
          if (docResult.slides.length > 0) {
            extractedImages = [...docResult.slides];
            snapshot = docResult.slides[0];
          }
        }
      }
    }

    // -------------------------------------------------------------
    // Tier 2: Playwright Fallback (<2s)
    // -------------------------------------------------------------
    if (!description && !snapshot && !authorName) {
      try {
        const pwResult = await playwrightEngine.scrape<any>(targetUrl, {
          waitSelector: 'article, main, .feed-shared-update-v2, .native-document-container',
          waitTimeout: 1500,
          userAgent: 'LinkedInBot/1.0 (sdk@linkedin.com)',
          customEvaluator: async (page) => {
            return await page.evaluate(() => {
              const domImages: string[] = [];
              const mainContainer =
                document.querySelector(
                  'article:not(.related-posts__crosslink):not([class*="related-posts"]), .main-feed-activity-card:not(.related-posts__crosslink), .feed-shared-update-v2, article'
                ) || document;

              mainContainer
                .querySelectorAll<HTMLImageElement>(
                  'img[src*="feedshare-image"], img[data-delayed-url*="feedshare-image"], ' +
                  'img[src*="image-shrink_"], img[srcset*="image-shrink_"], img[data-delayed-url*="image-shrink_"], ' +
                  'img[src*="/dms/image/"], img[srcset*="/dms/image/"], img[data-delayed-url*="/dms/image/"], ' +
                  'img[src*="feedshare-document"], img[data-src*="feedshare-document"], ' +
                  'img[alt="View image"], figure img, div[style*="aspect-ratio"] img'
                )
                .forEach((img) => {
                  if (img.closest('.related-posts, .related-posts__crosslink, [class*="related-posts"]')) return;
                  const srcset = img.getAttribute('srcset');
                  let src = img.getAttribute('data-delayed-url') || img.getAttribute('data-src') || img.src;
                  if (srcset) {
                    const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
                    const highRes = parts.find((p) => p[0].includes('shrink_1280') || p[0].includes('shrink_800') || p[0].includes('high-res'));
                    src = highRes ? highRes[0] : (parts.length > 0 ? parts[parts.length - 1][0] : src);
                  }
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
          if (parsed.isTopicCollection) isTopicCollection = true;
          if (parsed.isNewsStory && !isArticle) isNewsStory = true;
          if (parsed.isNewsletter) isNewsletter = true;
          if (parsed.isArticleType && !isNewsStory && !isTopicCollection) isArticle = true;

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

          const $pw = cheerio.load(pwResult.customData.html);
          const twitterTitle = $pw('meta[name="twitter:title"]').attr('content');
          const metaTitle = $pw('meta[name="title"]').attr('content') || $pw('title').text();
          const ogTitle = $pw('meta[property="og:title"]').attr('content');
          const rawTitle = twitterTitle || metaTitle || ogTitle || parsed.headline || null;
          if (rawTitle && !pageTitle) {
            pageTitle = cleanLinkedInTitle(rawTitle);
          }

          const twitterDesc = $pw('meta[name="twitter:description"]').attr('content');
          const metaDesc = $pw('meta[name="description"]').attr('content');
          const ogDesc = $pw('meta[property="og:description"]').attr('content');
          const metaSnippet = twitterDesc || metaDesc || ogDesc || null;
          const rawDesc = (parsed.description && metaSnippet && parsed.description.length > metaSnippet.length)
            ? parsed.description
            : (metaSnippet || parsed.description || null);
          if (rawDesc && !description) {
            description = rawDesc;
          }

          if (isArticle && !articleContent) {
            if (!articleTitle) articleTitle = pageTitle;
            const articleRes = extractArticleContent($pw);
            articleContent = articleRes.content;
            wordCount = articleRes.wordCount;
            readingTimeMinutes = articleRes.readingTimeMinutes;
          }

          if (!documentInfo && !isTopicCollection && !isNewsStory) {
            const docResult = await extractLinkedInDocumentSlides($pw);
            if (docResult.slides.length > 0 || docResult.pdfUrl || docResult.title) {
              documentInfo = {
                title: docResult.title || null,
                page_count: docResult.pageCount || (docResult.slides.length > 0 ? docResult.slides.length : null),
                pdf_url: docResult.pdfUrl || null,
              };
              if (docResult.slides.length > 0) {
                extractedImages = [...docResult.slides];
                snapshot = docResult.slides[0];
              }
            }
          }
        }

        if (Array.isArray(pwResult.customData?.images) && extractedImages.length === 0 && !isNewsStory && !isTopicCollection) {
          extractedImages = pwResult.customData.images;
        }

        if (!description) description = pwResult.description || null;
        if (!snapshot && !isNewsStory && !isTopicCollection) snapshot = pwResult.snapshot || null;
        if (!authorName) authorName = pwResult.author || null;
      } catch {
        // Ignore playwright fallback error
      }
    }

    // Resolve specific type and site name
    let resolvedType = 'linkedin';
    let resolvedSiteName = 'LinkedIn';

    if (isTopicCollection) {
      resolvedType = 'linkedin_topic_collection';
      resolvedSiteName = 'LinkedIn Top Content';
    } else if (isNewsStory) {
      resolvedType = 'linkedin_news_story';
      resolvedSiteName = 'LinkedIn News';
    } else if (isNewsletter) {
      resolvedType = 'linkedin_newsletter';
      resolvedSiteName = 'LinkedIn Newsletter';
    } else if (isArticle) {
      resolvedType = 'linkedin_article';
      resolvedSiteName = 'LinkedIn Article';
    } else {
      resolvedType = 'linkedin_post';
      resolvedSiteName = 'LinkedIn';
    }

    // Resolve author name fallback
    if (!authorName || authorName === 'LinkedIn User' || authorName.toLowerCase().includes('linkedin')) {
      if (isTopicCollection) {
        authorName = 'LinkedIn Top Content';
        authorAvatar = LINKEDIN_LOGO_URL;
      } else if (isNewsStory) {
        authorName = 'LinkedIn News';
        authorAvatar = LINKEDIN_LOGO_URL;
      } else if (isNewsletter) {
        authorName = 'LinkedIn Newsletter';
        authorAvatar = LINKEDIN_LOGO_URL;
      } else {
        authorName = extractNameFromUrlSlug(targetUrl) || (isArticle ? 'LinkedIn Author' : 'LinkedIn Member');
      }
    }

    // Fallback avatar if still not found
    if (!authorAvatar || isGhostAvatar(authorAvatar)) {
      authorAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=0a66c2&color=fff&size=200&bold=true`;
    }

    // Assemble clean media list (Strictly post/article media: video or snapshot, NO profile avatars or banners)
    // User requirement: DO NOT scrape any images for news and topic_collection
    if (isNewsStory || isTopicCollection) {
      extractedImages = [];
      snapshot = null;
      videoUrl = null;
    }

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

    if (isNewsStory || isTopicCollection) {
      mediaList.length = 0;
    }

    const primarySnapshot = (!isNewsStory && !isTopicCollection)
      ? ((mediaList.find((m) => m.type === 'image')?.url || mediaList[0]?.url || snapshot) || null)
      : null;

    let resolvedDesc = description;
    if (!isArticle && !isTopicCollection && !isNewsStory && pageTitle) {
      if (!resolvedDesc || pageTitle.length > resolvedDesc.length) {
        resolvedDesc = pageTitle;
      }
    }
    const finalDescription = resolvedDesc ? cleanLinkedInText(cleanDescription(resolvedDesc)) : '';

    const hasVideo = Boolean(!isNewsStory && !isTopicCollection && (videoUrl || mediaList.some((m) => m.type === 'video')));
    const videoThumbnail = hasVideo ? (primarySnapshot || snapshot || null) : null;

    let finalTitle: string | null = null;
    if (isArticle) {
      finalTitle = articleTitle ? cleanTitle(articleTitle) : (pageTitle ? cleanTitle(pageTitle) : null);
    } else if (documentInfo?.title) {
      finalTitle = cleanTitle(documentInfo.title);
    } else if (isNewsStory || isTopicCollection || isNewsletter) {
      finalTitle = pageTitle ? cleanTitle(pageTitle) : null;
    } else {
      // Regular LinkedIn posts do not have titles. Use clean attribution so the post body is not stored as title.
      finalTitle = authorName ? `${authorName} on LinkedIn` : 'LinkedIn Post';
    }

    return {
      title: finalTitle,
      description: finalDescription,
      logo: LINKEDIN_LOGO_URL,
      ogSiteName: resolvedSiteName,
      type: resolvedType,
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
        video_thumbnail: videoThumbnail,
        type: resolvedType,
        page_intent: resolvedType,
        ...(documentInfo ? { document: documentInfo } : {}),
        ...(isArticle
          ? {
              type: 'article',
              page_intent: 'article',
              article_content: articleContent,
              word_count: wordCount,
              reading_time_minutes: readingTimeMinutes,
            }
          : {}),
      },
    };
  },
};
