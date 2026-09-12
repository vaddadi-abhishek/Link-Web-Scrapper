import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, InstagramCardData, MediaItem } from './types';
import { scrapeWithCheerio } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';
import { cleanTitle } from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';

const INSTAGRAM_LOGO_URL = 'https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png';

function cleanInstagramText(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\u0027/g, "'")
    .replace(/\\u0022/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\/g, '')
    .replace(/&#064;/g, '@')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function cleanMediaUrl(raw: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/[\\"]+$/, '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\/g, '')
    .replace(/\\?u00253D/gi, '%3D')
    .replace(/\\?u003C.*$/gi, '')
    .trim();
}

function sanitizeDescription(raw: string | null, username?: string): string {
  if (!raw) return '';
  let desc = String(raw).trim();

  // 1. If crawler format: "... on [Date]: "caption text"" or "... on Instagram: "caption text""
  const crawlerQuoteMatch =
    desc.match(/(?:.*?)\s+on\s+[A-Za-z]+\s+\d{1,2},?\s*\d{4}:\s*["“]([\s\S]*?)["”][.\s]*$/i) ||
    desc.match(/on Instagram:\s*["“]([\s\S]*?)["”][.\s]*$/i) ||
    desc.match(/:\s*["“]([\s\S]{3,})["”][.\s]*$/);
  if (crawlerQuoteMatch && crawlerQuoteMatch[1]) {
    desc = crawlerQuoteMatch[1].trim();
  }

  // 2. Remove trailing "View all ... comments" or "View more on Instagram"
  desc = desc.replace(/\s*View all [\d,.]+[KMBkmb]? comments.*$/is, '').trim();
  desc = desc.replace(/\s*View more on Instagram.*$/is, '').trim();

  // 3. If it starts with username directly attached (e.g. "rajshamaniTomorrow 9:09 PM" or "rajshamani Tomorrow")
  if (username && username !== 'unknown') {
    const userRegex = new RegExp(`^@?${username}[:\\s-]*`, 'i');
    desc = desc.replace(userRegex, '').trim();
  }

  return cleanInstagramText(desc);
}

function extractInstagramVideo(embedHtml: string, rawHtml?: string | null): string | null {
  if (embedHtml) {
    // 1. Check for video_url in JSON
    const vMatch = embedHtml.match(/video_url["\\]*:\s*["\\]*(https?:[\\/]+[^"\s<>]+)/i);
    if (vMatch && vMatch[1]) {
      return cleanMediaUrl(vMatch[1]);
    }

    // 2. Direct .mp4 in embed (unescape all backslashes first)
    const unescapedEmbed = embedHtml.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
    const mp4Match = unescapedEmbed.match(/https?:\/\/[^"'\s<>]+?\.mp4(?:\?[^"'\s<>]+)?/i);
    if (mp4Match && mp4Match[0]) {
      return cleanMediaUrl(mp4Match[0]);
    }
  }

  // 3. Check crawler HTML (Instagram reels format uses video_versions with progressive .mp4)
  if (rawHtml) {
    // 3a. Parse video_versions JSON array
    const vvMatches = [...rawHtml.matchAll(/"video_versions"\s*:\s*(\[[^\]]+\])/g)];
    for (const m of vvMatches) {
      try {
        const unescaped = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\//g, '/');
        const list = JSON.parse(unescaped);
        if (Array.isArray(list) && list.length > 0 && list[0].url) {
          return cleanMediaUrl(list[0].url);
        }
      } catch {
        // Fallback to regex if JSON parse fails
      }
    }

    // 3b. video_versions url regex
    const vvUrlMatch = rawHtml.match(/"video_versions"\s*:\s*\[\s*\{[^}]*?"url"\s*:\s*"([^"]+)"/i);
    if (vvUrlMatch && vvUrlMatch[1]) {
      return cleanMediaUrl(vvUrlMatch[1]);
    }

    // 3c. Direct video_url in crawler JSON
    const cVMatch = rawHtml.match(/video_url["\\]*:\s*["\\]*(https?:[\\/]+[^"\s<>]+)/i);
    if (cVMatch && cVMatch[1]) {
      return cleanMediaUrl(cVMatch[1]);
    }

    // 3d. Progressive mp4 URL in crawler JSON
    const progMatch = rawHtml.match(/"url"\s*:\s*"(https?:[\\/]+[^"]+?\.mp4[^"]*?)"/i);
    if (progMatch && progMatch[1]) {
      return cleanMediaUrl(progMatch[1]);
    }

    // 3e. General unescaped .mp4 fallback in crawler (ignoring standalone audio streams)
    const unescapedCrawler = rawHtml.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
    const cMp4Matches = [...unescapedCrawler.matchAll(/https?:\/\/[^"'\s<>\\]+?\.mp4(?:\?[^"'\s<>\\]+)?/gi)];
    for (const match of cMp4Matches) {
      const url = match[0];
      // Exclude standalone audio streams (e.g. DASH audio stream segments)
      if (url.includes('dash_ln_heaac') || url.includes('_audio') || url.includes('vbr3_audio')) {
        continue;
      }
      return cleanMediaUrl(url);
    }
  }

  return null;
}

function isAvatarUrl(url: string): boolean {
  const l = url.toLowerCase();
  return (
    l.includes('150x150') ||
    l.includes('s150x150') ||
    l.includes('profile_pic') ||
    l.includes('avatar') ||
    l.includes('rsrc.php')
  );
}

export const instagramExtractor: PlatformExtractor<InstagramCardData> = {
  platformKey: 'instagram',
  async extract(targetUrl: string): Promise<ExtractionResult<InstagramCardData>> {
    // Normalize /reels/ to /reel/ for consistent crawler and embed resolution
    const normalizedUrl = targetUrl.replace(/\/reels\//i, '/reel/');

    // Fast-Path using Axios & Cheerio with Meta Crawler User-Agent (~200ms)
    const cheerioData = await scrapeWithCheerio(normalizedUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const ogSiteName = cheerioData?.ogSiteName || 'Instagram';
    let publishedAt: string | null = cheerioData?.publishedAt || null;

    const twitterTitle = cheerioData?.twitterTitle;
    if (twitterTitle) {
      title = cleanTitle(twitterTitle);
    } else {
      const rawTitle = cheerioData?.rawTitle || '';
      const titleAuthorMatch = rawTitle.match(/^([^:]+)\s+on\s+Instagram:/i);
      if (titleAuthorMatch && titleAuthorMatch[1]) {
        title = titleAuthorMatch[1].trim();
      }
    }

    const rawDesc = cheerioData?.rawDescription || cheerioData?.description || '';
    const combinedText = `${cheerioData?.rawTitle || ''} ${rawDesc} ${title || ''}`;

    // Parse Username & Display Name
    let username = 'unknown';
    let displayName = title || 'Instagram User';

    const handleMatch = title?.match(/@([a-zA-Z0-9._]+)/) || combinedText.match(/@([a-zA-Z0-9._]+)/);
    if (handleMatch && handleMatch[1]) {
      username = handleMatch[1].trim();
    } else {
      const userMatch = combinedText.match(/(?:-\s*|^\s*)([a-zA-Z0-9._]+)\s+on\s+/i);
      if (userMatch && userMatch[1]) {
        username = userMatch[1].trim();
      }
    }

    const nameMatch = title?.match(/^(.*?)\s*\(@/);
    if (nameMatch && nameMatch[1]) {
      displayName = nameMatch[1].trim();
    }

    // Parse Likes & Comments from metadata text strings
    const likesMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s+likes?/i);
    const commentsMatch = combinedText.match(/([\d,.]+[KMBkmb]?)\s+comments?/i);

    const metrics: InstagramCardData['metrics'] = {};
    if (likesMatch && likesMatch[1]) {
      metrics.likes = parseFormattedNumber(likesMatch[1]);
    }
    if (commentsMatch && commentsMatch[1]) {
      metrics.comments = parseFormattedNumber(commentsMatch[1]);
    }

    // Parse Date Posted from text string (e.g. "on August 1, 2026")
    const dateMatch =
      rawDesc.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i) ||
      combinedText.match(/\bon\s+([A-Za-z]+\s+\d{1,2},?\s*\d{4})\b/i);
    if (dateMatch && dateMatch[1]) {
      const parsedDate = new Date(dateMatch[1].trim());
      if (!isNaN(parsedDate.getTime())) {
        publishedAt = parsedDate.toISOString();
      }
    }

    // Extract Reel/Post video & carousel image URLs via Instagram embed fast-path
    const shortcodeMatch = normalizedUrl.match(/\/(?:reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;
    const mediaList: MediaItem[] = [];
    let embedAvatar: string | null = null;
    let embedHtml = '';
    let crawlerHtml: string | null = cheerioData?.rawHtml || null;

    // Resilient fallback: If crawler HTML was not captured by scrapeWithCheerio, fetch directly
    if (!crawlerHtml && shortcode) {
      try {
        const crawlerRes = await axios.get(normalizedUrl, {
          headers: {
            'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          timeout: 4000,
        });
        if (typeof crawlerRes.data === 'string') {
          crawlerHtml = crawlerRes.data;
        }
      } catch {
        // Continue with available data
      }
    }

    if (shortcode) {
      try {
        const embedRes = await axios.get(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
          },
          timeout: 6000,
        });
        embedHtml = String(embedRes.data || '');
        const $embed = cheerio.load(embedHtml);

        // 1. Extract Carousel (edge_sidecar_to_children)
        const sidecarIdx = embedHtml.indexOf('edge_sidecar_to_children');
        if (sidecarIdx !== -1) {
          const edgesIdx = embedHtml.indexOf('edges', sidecarIdx);
          if (edgesIdx !== -1) {
            let depth = 0;
            let startArray = -1;
            let arrayStr = '';
            for (let i = edgesIdx; i < embedHtml.length; i++) {
              if (embedHtml[i] === '[') {
                if (depth === 0) startArray = i;
                depth++;
              } else if (embedHtml[i] === ']') {
                depth--;
                if (depth === 0) {
                  arrayStr = embedHtml.substring(startArray, i + 1);
                  break;
                }
              }
            }
            if (arrayStr) {
              try {
                const unescaped = arrayStr
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\')
                  .replace(/\\\//g, '/');
                const edges = JSON.parse(unescaped);
                for (const edge of edges) {
                  const node = edge.node;
                  if (!node) continue;
                  if (node.is_video && node.video_url) {
                    mediaList.push({ type: 'video', url: cleanMediaUrl(node.video_url) });
                  } else if (node.display_url) {
                    mediaList.push({ type: 'image', url: cleanMediaUrl(node.display_url) });
                  }
                }
              } catch {
                // Regex fallback if JSON parse fails
                const parts = arrayStr.split(/\\?"node\\?"\s*:\s*\{/);
                for (let p = 1; p < parts.length; p++) {
                  const part = parts[p];
                  const isVideo = /"is_video"\s*:\s*true/i.test(part) || /\\"is_video\\"\s*:\s*true/i.test(part);
                  if (isVideo) {
                    const vm = part.match(/(?:video_url)["\\]*:\s*["\\]*(https?:[\\/]+[^"\s<>]+?\.mp4[^"\s<>]*)/i);
                    if (vm) mediaList.push({ type: 'video', url: cleanMediaUrl(vm[1]) });
                  } else {
                    const dm = part.match(/(?:display_url)["\\]*:\s*["\\]*(https?:[\\/]+[^"\s<>]+)/i);
                    if (dm) mediaList.push({ type: 'image', url: cleanMediaUrl(dm[1]) });
                  }
                }
              }
            }
          }
        }

        // 2. If not a carousel, extract Video or Single Image
        if (mediaList.length === 0) {
          const videoUrl = extractInstagramVideo(embedHtml, crawlerHtml);
          if (videoUrl) {
            mediaList.push({ type: 'video', url: videoUrl });
          }

          // Fallback to single post/reel cover image if video is not available or if it's an image post
          if (mediaList.length === 0) {
            const embedImg = $embed('.Content.EmbedFrame img.EmbeddedMediaImage, .Content.EmbedFrame .EmbeddedMedia img').attr('src');
            if (embedImg) {
              mediaList.push({ type: 'image', url: cleanMediaUrl(embedImg) });
            } else if (image) {
              mediaList.push({ type: 'image', url: cleanMediaUrl(image) });
            }
          }
        }

        // 3. Username & Display Name Fallback
        const usernameMatch =
          embedHtml.match(/"username"\s*:\s*"([^"]+)"/) ||
          embedHtml.match(/class="UsernameText"[^>]*>([^<]+)/);
        if (usernameMatch && usernameMatch[1] && username === 'unknown') {
          username = cleanInstagramText(usernameMatch[1]);
          if (displayName === 'Instagram User' || displayName === 'Instagram Post') {
            displayName = username;
          }
        }

        // 4. Clean Caption Extraction from Embed DOM (stripping username & comments links)
        let embedCaption: string | null = null;
        const $caption = $embed('.Caption').first().clone();
        if ($caption.length > 0) {
          $caption.find('.CaptionUsername, .CaptionComments, .HoverCard, [class*="Username"], [class*="Comment"], script, style').remove();
          const cText = $caption.text().trim();
          if (cText) {
            embedCaption = cleanInstagramText(cText);
          }
        }
        if (!embedCaption) {
          const cText = $embed('.CaptionText').text().trim();
          if (cText) {
            embedCaption = cleanInstagramText(cText);
          }
        }

        if (embedCaption) {
          description = embedCaption;
        }

        // 5. Metrics Extraction from Embed JSON & DOM
        const likesCountMatch = embedHtml.match(/(?:edge_liked_by|edge_media_preview_like|like_count)["\\]*:\s*\{?["\\]*(?:count)?["\\]*:\s*(\d+)/i);
        if (likesCountMatch && likesCountMatch[1] && (!metrics.likes || metrics.likes === 0)) {
          metrics.likes = parseInt(likesCountMatch[1], 10);
        }

        const commentsCountMatch =
          embedHtml.match(/(?:edge_media_to_comment|edge_media_to_parent_comment|comment_count)["\\]*:\s*\{?["\\]*(?:count)?["\\]*:\s*(\d+)/i) ||
          $embed('.CaptionComments, .CaptionCommentsExpand').text().match(/([\d,.]+[KMBkmb]?)\s+comments?/i);
        if (commentsCountMatch && commentsCountMatch[1] && (!metrics.comments || metrics.comments === 0)) {
          metrics.comments = parseFormattedNumber(commentsCountMatch[1]);
        }

        // 6. Avatar from Embed Header
        if (username !== 'unknown') {
          const matchingAvatar = $embed(`.Header img[alt="${username}"], .CollabAvatar img[alt="${username}"]`).attr('src');
          if (matchingAvatar) {
            embedAvatar = cleanMediaUrl(matchingAvatar);
          }
        }
        if (!embedAvatar) {
          const headerAvatar = $embed('.Header .Avatar img, .Header a.Avatar img, .Header a.CollabAvatar img').last().attr('src');
          if (headerAvatar) {
            embedAvatar = cleanMediaUrl(headerAvatar);
          }
        }
      } catch {
        // Fallback if embed fetch times out
      }
    }

    // Fallback for Avatar: Fast Profile Fetch using crawler headers
    if (!embedAvatar && username && username !== 'unknown') {
      try {
        const uRes = await axios.get(`https://www.instagram.com/${username}/`, {
          headers: {
            'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: 4000,
        });
        const $u = cheerio.load(uRes.data);
        const userOgImg = $u('meta[property="og:image"]').attr('content');
        if (userOgImg) {
          embedAvatar = cleanMediaUrl(userOgImg);
        }
      } catch {
        // Ignore user page fetch error
      }
    }

    // Final clean pass on description to remove any residual prefixes/suffixes
    description = sanitizeDescription(description, username);

    const finalSnapshot =
      image || mediaList.find((m) => m.type === 'image')?.url || mediaList[0]?.url || null;

    const card_data: InstagramCardData = {
      author: {
        username,
        name: displayName,
        avatar_url: embedAvatar || cheerioData?.authorAvatar || null,
        verified: false,
      },
      metrics,
      media: mediaList,
      posted_at: publishedAt || new Date().toISOString(),
    };

    // If Cheerio and embed returned nothing useful (e.g. login wall / blocked), fallback to optimized Playwright
    if (!finalSnapshot && (!description || description.trim() === '') && (title === 'Instagram Post' || !title)) {
      try {
        const pwData = await playwrightEngine.scrape(targetUrl, {
          waitSelector: 'article, main',
          waitTimeout: 2500,
        });

        if (pwData.title || pwData.description || pwData.snapshot) {
          const pwMedia: MediaItem[] = pwData.snapshot ? [{ type: 'image', url: pwData.snapshot }] : mediaList;
          return {
            title: pwData.title || 'Instagram Post',
            description: pwData.description || '',
            snapshot: pwData.snapshot || finalSnapshot,
            logo: INSTAGRAM_LOGO_URL,
            ogSiteName,
            card_data: {
              author: {
                username,
                name: pwData.author || displayName,
                avatar_url: cheerioData?.authorAvatar || embedAvatar || null,
                verified: false,
              },
              metrics,
              media: pwMedia,
              posted_at: pwData.publishedAt || publishedAt || new Date().toISOString(),
            },
          };
        }
      } catch {
        // Fallback to default return
      }
    }

    return {
      title:
        title && title !== 'Instagram Post'
          ? title
          : username !== 'unknown'
            ? `Post by @${username} on Instagram`
            : 'Instagram Post',
      description: description || '',
      snapshot: finalSnapshot,
      logo: INSTAGRAM_LOGO_URL,
      ogSiteName,
      card_data,
    };
  },
};
