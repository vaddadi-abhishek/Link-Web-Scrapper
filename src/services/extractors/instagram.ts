import axios from 'axios';
import * as cheerio from 'cheerio';
import { PlatformExtractor, ExtractionResult, InstagramCardData, MediaItem, sanitizeMetrics } from './types';
import { scrapeWithCheerio, GOOGLEBOT_UA, BINGBOT_UA, TWITTERBOT_UA, FACEBOOK_UA } from '../cheerioScraper';
import { playwrightEngine } from '../playwrightEngine';
import { resolveUrl } from '../../utils/urlFormatter';
import {
  cleanTitle,
  normalizeParagraphs,
  unescapeHtml,
  stripEngagementHeader,
  stripOuterQuotes,
  isInstagramBlockedOrAuthWall,
} from '../../utils/textCleaner';
import { parseFormattedNumber } from '../../utils/numberParser';
import { logger } from '../../utils/logger';

const INSTAGRAM_LOGO_URL = 'https://www.instagram.com/favicon.ico';

function cleanInstagramText(raw: string | null): string {
  if (!raw) return '';
  let text = String(raw);

  // Convert HTML break and paragraph/block closing tags to newlines before stripping tags
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)>/gi, '\n');

  // Unescape standard escaped unicode characters from JSON or scripts
  text = text
    .replace(/\\u0026/g, '&')
    .replace(/\\u0027/g, "'")
    .replace(/\\u0022/g, '"')
    .replace(/\\u003[cC]/g, '<')
    .replace(/\\u003[eE]/g, '>')
    .replace(/\\u000[aA]/g, '\n');

  // Convert literal escaped newlines and carriage returns to actual newlines
  text = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Remove remaining backslashes
  text = text.replace(/\\/g, '');

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Unescape HTML entities (&quot;, &#064;, &amp;, etc.)
  text = unescapeHtml(text);

  return text.trim();
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

  // 1. Strip outer quotes and platform engagement headers if present
  desc = stripOuterQuotes(desc);
  desc = stripEngagementHeader(desc);

  // 2. If crawler format: "... on [Date]: "caption text"" or "... on Instagram: "caption text""
  const crawlerQuoteMatch =
    desc.match(/(?:.*?)\s+on\s+[A-Za-z]+\s+\d{1,2},?\s*\d{4}:\s*["“]([\s\S]*?)["”][.\s]*$/i) ||
    desc.match(/on Instagram:\s*["“]([\s\S]*?)["”][.\s]*$/i) ||
    desc.match(/:\s*["“]([\s\S]{3,})["”][.\s]*$/);
  if (crawlerQuoteMatch && crawlerQuoteMatch[1]) {
    desc = crawlerQuoteMatch[1].trim();
  }

  // 3. Remove trailing "View all ... comments" or "View more on Instagram"
  desc = desc.replace(/\s*View all [\d,.]+[KMBkmb]? comments.*$/is, '').trim();
  desc = desc.replace(/\s*View more on Instagram.*$/is, '').trim();

  // 4. If it starts with username directly attached (e.g. "rajshamaniTomorrow 9:09 PM" or "rajshamani Tomorrow")
  if (username && username !== 'unknown') {
    const userRegex = new RegExp(`^@?${username}[:\\s-]*`, 'i');
    desc = desc.replace(userRegex, '').trim();
  }

  desc = cleanInstagramText(desc);
  desc = normalizeParagraphs(desc);

  return desc;
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

function isInstagramProfileUrl(targetUrl: string): boolean {
  const clean = targetUrl.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').split(/[?#]/)[0].trim();
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 1) {
    const slug = segments[0].toLowerCase();
    const systemSlugs = [
      'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'direct',
      'accounts', 'developer', 'about', 'legal', 'help', 'privacy',
      'emails', 'graphql', 'api'
    ];
    return !systemSlugs.includes(slug);
  }
  return false;
}

function extractInstagramUsernameFromProfileUrl(targetUrl: string): string | null {
  const clean = targetUrl.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').split(/[?#]/)[0].trim();
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 1) {
    const slug = segments[0];
    const systemSlugs = [
      'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'direct',
      'accounts', 'developer', 'about', 'legal', 'help', 'privacy',
      'emails', 'graphql', 'api'
    ];
    if (!systemSlugs.includes(slug.toLowerCase())) {
      return slug;
    }
  }
  return null;
}

function extractInstagramProfileMediaFromHtml(html: string): MediaItem[] {
  if (!html) return [];
  const media: MediaItem[] = [];
  const seen = new Set<string>();

  // 1. Script tag: polaris_ordered_timeline_connection or polaris_timeline_connection
  const scriptMatches = [...html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const s of scriptMatches) {
    if (s[1].includes('polaris_ordered_timeline_connection') || s[1].includes('polaris_timeline_connection')) {
      try {
        const json = JSON.parse(s[1]);
        const findConnection = (obj: any): any => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.polaris_ordered_timeline_connection) return obj.polaris_ordered_timeline_connection;
          if (obj.polaris_timeline_connection) return obj.polaris_timeline_connection;
          for (const k of Object.keys(obj)) {
            const res = findConnection(obj[k]);
            if (res) return res;
          }
          return null;
        };
        const conn = findConnection(json);
        if (conn && Array.isArray(conn.edges)) {
          for (const edge of conn.edges) {
            const uri = edge.node?.display_uri || edge.node?.image_versions2?.candidates?.[0]?.url;
            if (uri) {
              const cleaned = cleanMediaUrl(uri);
              if (cleaned && !seen.has(cleaned) && !isAvatarUrl(cleaned)) {
                seen.add(cleaned);
                media.push({ type: 'image', url: cleaned });
                if (media.length >= 6) return media;
              }
            }
          }
        }
      } catch {
        // Continue if parsing fails
      }
    }
  }

  // 2. DOM Cheerio Extraction: Post links and grid containers in visual order
  const $ = cheerio.load(html);
  const profileGridSelectors = [
    'a[href*="/p/"] img',
    'a[href*="/reel/"] img',
    'div._aagu img',
    'div._aagv img',
    'div.xg7h5cd img',
    'div._ac7v img',
    'div.x1i5p2am img',
    'div._a6hd img',
    'article img',
    'main img',
  ];

  $(profileGridSelectors.join(', ')).each((_, el) => {
    if (media.length >= 6) return;
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src) return;
    const cleaned = cleanMediaUrl(src);
    if (!cleaned || seen.has(cleaned) || isAvatarUrl(cleaned)) return;
    seen.add(cleaned);
    media.push({ type: 'image', url: cleaned });
  });

  // 3. Fallback for any img tag in provided HTML snippet
  if (media.length < 6) {
    $('img').each((_, el) => {
      if (media.length >= 6) return;
      const src = $(el).attr('src') || $(el).attr('data-src');
      const alt = $(el).attr('alt') || '';
      if (!src || alt.toLowerCase().includes('profile picture') || isAvatarUrl(src)) return;
      const cleaned = cleanMediaUrl(src);
      if (!cleaned || seen.has(cleaned)) return;
      seen.add(cleaned);
      media.push({ type: 'image', url: cleaned });
    });
  }

  return media;
}

export const instagramExtractor: PlatformExtractor<InstagramCardData> = {
  platformKey: 'instagram',
  async extract(targetUrl: string, requestHtml?: string): Promise<ExtractionResult<InstagramCardData>> {
    // Normalize /reels/ to /reel/ for consistent crawler and embed resolution
    const normalizedUrl = targetUrl.replace(/\/reels\//i, '/reel/');

    // Fast-Path using Axios & Cheerio with Meta Crawler User-Agent (~200ms)
    const cheerioData = await scrapeWithCheerio(normalizedUrl);

    let title = cheerioData?.title || null;
    let description = cheerioData?.description || null;
    let image = cheerioData?.image || null;
    const ogSiteName = cheerioData?.ogSiteName || 'Instagram';
    let publishedAt: string | null = cheerioData?.publishedAt || null;
    const logo = cheerioData?.logo || INSTAGRAM_LOGO_URL;
    let isVerified = false;

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

    const profileUsername = extractInstagramUsernameFromProfileUrl(targetUrl);
    if (profileUsername) {
      username = profileUsername;
    }

    const handleMatch = title?.match(/@([a-zA-Z0-9._]+)/) || combinedText.match(/@([a-zA-Z0-9._]+)/);
    if (handleMatch && handleMatch[1]) {
      username = handleMatch[1].trim();
    } else if (username === 'unknown') {
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
    const isProfile = !shortcode && isInstagramProfileUrl(targetUrl);
    const mediaList: MediaItem[] = [];
    let embedAvatar: string | null = null;
    let embedHtml = '';
    let crawlerHtml: string | null = cheerioData?.rawHtml || null;

    // Resilient fallback: If crawler HTML was not captured by scrapeWithCheerio or was an auth wall, fetch directly
    if (!crawlerHtml || crawlerHtml.length < 5000 || isInstagramBlockedOrAuthWall(crawlerHtml)) {
      const candidateUas = [GOOGLEBOT_UA, BINGBOT_UA, TWITTERBOT_UA, FACEBOOK_UA];
      for (const ua of candidateUas) {
        try {
          const crawlerRes = await axios.get(normalizedUrl, {
            headers: {
              'User-Agent': ua,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 4500,
            maxRedirects: 4,
            validateStatus: (status) => status >= 200 && status < 400,
          });
          if (typeof crawlerRes.data === 'string' && !isInstagramBlockedOrAuthWall(crawlerRes.data, crawlerRes.request?.res?.responseUrl)) {
            crawlerHtml = crawlerRes.data;
            break;
          }
        } catch {
          // Continue to next crawler UA
        }
      }
    }

    // Recover title, description, and avatar from crawlerHtml if initial scrape was sparse
    if (crawlerHtml) {
      const $c = cheerio.load(crawlerHtml);
      const cOgTitle = $c('meta[property="og:title"]').attr('content') || $c('title').text();
      if (cOgTitle && (!title || title === 'Instagram' || title === 'Instagram Post')) {
        title = cleanTitle(cOgTitle);
      }
      const cOgDesc = $c('meta[property="og:description"]').attr('content');
      if (cOgDesc && (!description || description.trim() === '')) {
        description = cOgDesc.trim();
      }
      const cOgImg = $c('meta[property="og:image"]').attr('content') || $c('img[alt*="profile picture"]').attr('src');
      if (cOgImg && !image) {
        image = cleanMediaUrl(cOgImg);
      }
      if ((!displayName || displayName === 'Instagram User') && title) {
        const nameMatch = title.match(/^(.*?)\s*\(@/);
        if (nameMatch && nameMatch[1]) {
          displayName = nameMatch[1].trim();
        }
      }
    }

    // Profile Extraction: Scrape first 6 recent images on profile in exact visual grid order
    if (isProfile) {
      // 1. If client provided requestHtml, parse directly
      if (requestHtml) {
        const fromRequestHtml = extractInstagramProfileMediaFromHtml(requestHtml);
        for (const m of fromRequestHtml) {
          if (mediaList.length >= 6) break;
          if (!mediaList.some((existing) => existing.url === m.url)) {
            mediaList.push(m);
          }
        }
      }

      // 2. Headless browser extraction (Playwright) to capture desktop ordered timeline (polaris_ordered_timeline_connection)
      if (mediaList.length < 6) {
        try {
          const pwData = await playwrightEngine.scrape<string[]>(normalizedUrl, {
            waitSelector: 'a[href*="/p/"], a[href*="/reel/"], div._aagu, div._aagv, main',
            waitTimeout: 2000,
            timeout: 8000,
            includeHtml: true,
            customEvaluator: async (page) => {
              return await page.evaluate(() => {
                // 1. Script tag check for polaris_ordered_timeline_connection
                const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
                for (const s of scripts) {
                  if (s.textContent && s.textContent.includes('polaris_ordered_timeline_connection')) {
                    try {
                      const json = JSON.parse(s.textContent);
                      const findConn = (obj: any): any => {
                        if (!obj || typeof obj !== 'object') return null;
                        if (obj.polaris_ordered_timeline_connection) return obj.polaris_ordered_timeline_connection;
                        for (const k of Object.keys(obj)) {
                          const res = findConn(obj[k]);
                          if (res) return res;
                        }
                        return null;
                      };
                      const conn = findConn(json);
                      if (conn && Array.isArray(conn.edges) && conn.edges.length > 0) {
                        const list: string[] = [];
                        for (const edge of conn.edges) {
                          const uri = edge.node?.display_uri || edge.node?.image_versions2?.candidates?.[0]?.url;
                          if (uri) {
                            list.push(uri);
                            if (list.length >= 6) return list;
                          }
                        }
                        if (list.length > 0) return list;
                      }
                    } catch {}
                  }
                }

                // 2. Post / reel link anchor images in visual grid order
                const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
                const domImgs: string[] = [];
                const seen = new Set<string>();
                for (const a of links) {
                  const img = a.querySelector('img');
                  const src = img ? img.getAttribute('src') : null;
                  if (src && !seen.has(src)) {
                    seen.add(src);
                    domImgs.push(src);
                    if (domImgs.length >= 6) return domImgs;
                  }
                }

                // 3. Grid container image wrappers
                const selectors = 'div._aagu img, div._aagv img, div._ac7v img, div.xg7h5cd img, div.x1i5p2am img, div._a6hd img';
                const imgs = Array.from(document.querySelectorAll(selectors));
                for (const img of imgs) {
                  const src = (img as HTMLImageElement).src || img.getAttribute('src');
                  if (src && !seen.has(src)) {
                    const l = src.toLowerCase();
                    if (
                      l.includes('150x150') ||
                      l.includes('s150x150') ||
                      l.includes('profile_pic') ||
                      l.includes('avatar') ||
                      l.includes('rsrc.php')
                    ) {
                      continue;
                    }
                    seen.add(src);
                    domImgs.push(src);
                    if (domImgs.length >= 6) return domImgs;
                  }
                }
                return domImgs;
              });
            },
          });

          if (pwData.customData && pwData.customData.length > 0) {
            mediaList.length = 0; // Canonical ordered list from real browser
            for (const u of pwData.customData) {
              if (mediaList.length >= 6) break;
              const cleaned = cleanMediaUrl(u);
              if (cleaned && !mediaList.some((m) => m.url === cleaned) && !isAvatarUrl(cleaned)) {
                mediaList.push({ type: 'image', url: cleaned });
              }
            }
          } else if (pwData.html) {
            const fromPwHtml = extractInstagramProfileMediaFromHtml(pwData.html);
            if (fromPwHtml.length > 0) {
              mediaList.length = 0;
              for (const m of fromPwHtml) {
                if (mediaList.length >= 6) break;
                if (!mediaList.some((existing) => existing.url === m.url)) {
                  mediaList.push(m);
                }
              }
            }
          }

          if (pwData.title && (!title || title === 'Instagram Post')) {
            title = pwData.title;
          }
          if (pwData.description && !description) {
            description = pwData.description;
          }
        } catch (pwErr) {
          logger.warn('InstagramExtractor', `Playwright profile extraction failed, falling back to crawler: ${(pwErr as Error).message}`);
        }
      }

      // 3. Crawler HTML fallback if still incomplete
      if (mediaList.length < 6 && crawlerHtml) {
        const fromCrawler = extractInstagramProfileMediaFromHtml(crawlerHtml);
        for (const m of fromCrawler) {
          if (mediaList.length >= 6) break;
          if (!mediaList.some((existing) => existing.url === m.url)) {
            mediaList.push(m);
          }
        }

        if (mediaList.length < 6) {
          const cdnMatches = [...crawlerHtml.matchAll(/https?:\/\/[^"'\s<>\\]+?(?:fbcdn\.net|cdninstagram\.com)[^"'\s<>\\]+?\.jpg[^"'\s<>\\]*/gi)];
          for (const match of cdnMatches) {
            if (mediaList.length >= 6) break;
            const cleaned = cleanMediaUrl(match[0]);
            if (!cleaned || mediaList.some((m) => m.url === cleaned) || isAvatarUrl(cleaned)) continue;
            mediaList.push({ type: 'image', url: cleaned });
          }
        }
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
          $caption.find('br').replaceWith('\n');
          $caption.find('p, div').each((_, el) => {
            $embed(el).append('\n');
          });
          const cText = $caption.text().trim();
          if (cText) {
            embedCaption = cleanInstagramText(cText);
          }
        }
        if (!embedCaption) {
          const $captionText = $embed('.CaptionText').first().clone();
          if ($captionText.length > 0) {
            $captionText.find('br').replaceWith('\n');
            $captionText.find('p, div').each((_, el) => {
              $embed(el).append('\n');
            });
            const cText = $captionText.text().trim();
            if (cText) {
              embedCaption = cleanInstagramText(cText);
            }
          }
        }

        if (embedCaption) {
          if (!description || embedCaption.includes('\n') || !description.includes('\n') || embedCaption.length > description.length) {
            description = embedCaption;
          }
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

        // 7. Verified Status Extraction from Embed Header DOM & JSON
        const headerVerifiedBadge =
          $embed('.Header .VerifiedSprite, .Header [class*="VerifiedSprite"], .HoverCard .VerifiedSprite').length > 0;
        const embedVerifiedJson =
          /\\?"is_verified\\?"\s*:\s*true/i.test(embedHtml) &&
          (embedHtml.includes('VerifiedSprite') ||
            (username !== 'unknown' &&
              (new RegExp(`"username"\\s*:\\s*"${username}"[\\s\\S]{0,300}?"is_verified"\\s*:\\s*true`, 'i').test(embedHtml) ||
               new RegExp(`"is_verified"\\s*:\\s*true[\\s\\S]{0,300}?"username"\\s*:\\s*"${username}"`, 'i').test(embedHtml))));

        if (headerVerifiedBadge || embedVerifiedJson) {
          isVerified = true;
        }
      } catch {
        // Fallback if embed fetch times out
      }
    }

    // 8. Resilient Fallback for Verified Status from Crawler HTML
    if (!isVerified && crawlerHtml) {
      const crawlerAuthorVerified =
        (username !== 'unknown' &&
          (new RegExp(`"username"\\s*:\\s*"${username}"[\\s\\S]{0,300}?"is_verified"\\s*:\\s*true`, 'i').test(crawlerHtml) ||
           new RegExp(`"is_verified"\\s*:\\s*true[\\s\\S]{0,300}?"username"\\s*:\\s*"${username}"`, 'i').test(crawlerHtml))) ||
        (displayName && displayName !== 'Instagram User' &&
          new RegExp(`"full_name"\\s*:\\s*"${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,150}?"is_verified"\\s*:\\s*true`, 'i').test(crawlerHtml)) ||
        /"is_verified"\s*:\s*true[\s\S]{0,100}?"__typename"\s*:\s*"User"/i.test(crawlerHtml);

      if (crawlerAuthorVerified) {
        isVerified = true;
      }
    }

    // Fallback for Avatar & Verified Status: Fast Profile Fetch using Googlebot
    if ((!embedAvatar || !isVerified) && username && username !== 'unknown') {
      try {
        const uRes = await axios.get(`https://www.instagram.com/${username}/`, {
          headers: {
            'User-Agent': GOOGLEBOT_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: 4000,
        });
        const userHtml = typeof uRes.data === 'string' ? uRes.data : '';
        const $u = cheerio.load(userHtml);
        const userOgImg = $u('meta[property="og:image"]').attr('content');
        const userDomImg = $u('img[alt*="profile picture"]').attr('src');
        if ((userOgImg || userDomImg) && !embedAvatar) {
          embedAvatar = cleanMediaUrl(userOgImg || userDomImg || null);
        }
        if (!isVerified && (/"is_verified"\s*:\s*true/i.test(userHtml) || userHtml.includes('InstagramVerified'))) {
          isVerified = true;
        }
      } catch {
        // Ignore user page fetch error
      }
    }

    if (isProfile && !embedAvatar) {
      if (image) {
        embedAvatar = cleanMediaUrl(image);
      } else if (crawlerHtml) {
        const $c = cheerio.load(crawlerHtml);
        const ogImg = $c('meta[property="og:image"]').attr('content');
        const domImg = $c('img[alt*="profile picture"]').attr('src');
        if (ogImg || domImg) {
          embedAvatar = cleanMediaUrl(ogImg || domImg || null);
        }
      }
    }

    if (!isVerified && crawlerHtml) {
      if (
        /"is_verified"\s*:\s*true/i.test(crawlerHtml) ||
        crawlerHtml.includes('InstagramVerified') ||
        (username !== 'unknown' &&
          (new RegExp(`"username"\\s*:\\s*"${username}"[\\s\\S]{0,300}?"is_verified"\\s*:\\s*true`, 'i').test(crawlerHtml) ||
           new RegExp(`"is_verified"\\s*:\\s*true[\\s\\S]{0,300}?"username"\\s*:\\s*"${username}"`, 'i').test(crawlerHtml)))
      ) {
        isVerified = true;
      }
    }

    // Final clean pass on description to remove any residual prefixes/suffixes
    description = sanitizeDescription(description, username);

    const finalSnapshot =
      (isProfile && mediaList[0]?.url) ||
      image ||
      mediaList.find((m) => m.type === 'image')?.url ||
      mediaList[0]?.url ||
      null;

    const hasVideo = mediaList.some((m) => m.type === 'video');
    const videoThumbnail = hasVideo ? finalSnapshot : null;

    const card_data: InstagramCardData = {
      author: {
        username,
        name: displayName,
        avatar_url: embedAvatar || cheerioData?.authorAvatar || null,
        verified: isVerified,
      },
      metrics: sanitizeMetrics(metrics),
      media: mediaList,
      posted_at: publishedAt || new Date().toISOString(),
      video_thumbnail: videoThumbnail,
      is_profile: isProfile,
    };

    // If Cheerio and embed returned nothing useful (e.g. login wall / blocked), fallback to optimized Playwright
    if (!finalSnapshot && (!description || description.trim() === '') && (title === 'Instagram Post' || !title)) {
      try {
        const pwData = await playwrightEngine.scrape<string[]>(targetUrl, {
          waitSelector: isProfile ? 'div._aagu, div._aagv, div.xg7h5cd, main' : 'article, main',
          waitTimeout: 2500,
          customEvaluator: isProfile
            ? async (page) => {
                return await page.evaluate(() => {
                  const selector =
                    'div._aagu img, div._aagv img, div._ac7v img, div.xg7h5cd img, div.x1i5p2am img, div._a6hd img, a[href*="/p/"] img, a[href*="/reel/"] img';
                  const imgs = Array.from(document.querySelectorAll(selector));
                  const results: string[] = [];
                  const seen = new Set<string>();
                  for (const img of imgs) {
                    const src = (img as HTMLImageElement).src;
                    if (!src || seen.has(src)) continue;
                    const l = src.toLowerCase();
                    if (
                      l.includes('150x150') ||
                      l.includes('s150x150') ||
                      l.includes('profile_pic') ||
                      l.includes('avatar') ||
                      l.includes('rsrc.php')
                    ) {
                      continue;
                    }
                    seen.add(src);
                    results.push(src);
                    if (results.length >= 6) break;
                  }
                  return results;
                });
              }
            : undefined,
        });

        if (pwData.title || pwData.description || pwData.snapshot || (pwData.customData && pwData.customData.length > 0)) {
          let pwMedia: MediaItem[] = mediaList;
          if (pwData.customData && pwData.customData.length > 0) {
            pwMedia = pwData.customData.map((u) => ({ type: 'image', url: cleanMediaUrl(u) }));
          } else if (pwData.snapshot) {
            pwMedia = [{ type: 'image', url: pwData.snapshot }];
          }
          const pwHasVideo = pwMedia.some((m) => m.type === 'video');
          return {
            title:
              pwData.title ||
              (isProfile && username !== 'unknown'
                ? displayName && displayName !== 'Instagram User'
                  ? `${displayName} (@${username})`
                  : `@${username} on Instagram`
                : 'Instagram Post'),
            description: pwData.description || '',
            logo: pwData.logo || logo,
            ogSiteName,
            card_data: {
              author: {
                username,
                name: pwData.author || displayName,
                avatar_url: cheerioData?.authorAvatar || embedAvatar || null,
                verified: isVerified,
              },
              metrics: sanitizeMetrics(metrics),
              media: pwMedia,
              posted_at: pwData.publishedAt || publishedAt || new Date().toISOString(),
              video_thumbnail: pwHasVideo ? (pwData.snapshot || finalSnapshot) : null,
              is_profile: isProfile,
            },
          };
        }
      } catch {
        // Playwright fallback failed, proceed with cheerio data
      }
    }

    return {
      title:
        title && title !== 'Instagram Post' && title !== 'Instagram'
          ? title
          : isProfile && username !== 'unknown'
            ? displayName && displayName !== 'Instagram User'
              ? `${displayName} (@${username})`
              : `@${username} on Instagram`
            : username !== 'unknown'
              ? `Post by @${username} on Instagram`
              : 'Instagram Post',
      description: description || '',
      logo,
      ogSiteName,
      card_data,
    };
  },
};
