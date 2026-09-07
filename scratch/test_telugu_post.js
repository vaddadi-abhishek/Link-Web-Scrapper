const { playwrightEngine } = require('../dist/services/playwrightEngine');

function extractRedditMediaId(url) {
  if (!url) return null;
  const match = url.match(/(?:i\.redd\.it\/|preview\.redd\.it\/(?:[^\/]+-)?v\d+-)([a-zA-Z0-9]+)/i) ||
                url.match(/\/([a-zA-Z0-9]{10,})\.(?:jpe?g|png|webp|gif)/i);
  return match ? match[1] : null;
}

function isValidRedditPostImage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes('share.redd.it')) return false;
  if (lower.includes('communityicon')) return false;
  if (lower.includes('favicon')) return false;
  if (lower.includes('reddit_logo')) return false;
  if (lower.includes('snoovatar')) return false;
  if (lower.includes('avatar')) return false;
  if (lower.includes('.mp4') || lower.includes('.m3u8')) return false;
  return true;
}

async function testUrl(url) {
  console.log('\n--- Testing URL:', url);
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const sp = document.querySelector('shreddit-post');
        if (!sp) return null;

        const rawList = [];

        // 1. Check if post has content-href pointing to direct image
        const contentHref = sp.getAttribute('content-href');
        if (contentHref && (/\.(jpe?g|png|webp|gif)$/i.test(contentHref) || contentHref.includes('i.redd.it'))) {
          rawList.push(contentHref);
        }

        // 2. Check for gallery slides or lightbox containers
        // Target specifically .media-lightbox-img, gallery-carousel, or zoomable-img
        const containers = sp.querySelectorAll('gallery-carousel ul li, .media-lightbox-img, zoomable-img, [data-post-click-location="image"]');
        
        if (containers.length > 0) {
          containers.forEach(container => {
            // Find full-res zoomable-img first
            const zoomableImg = container.querySelector('zoomable-img img');
            if (zoomableImg && zoomableImg.src) {
              rawList.push(zoomableImg.src);
              return;
            }

            // Find primary media img
            const primaryImg = container.querySelector('img[data-post-media-primary], img#post-image');
            if (primaryImg && primaryImg.src) {
              rawList.push(primaryImg.src);
              return;
            }

            // Fallback inside container (excluding background filter)
            const fallbackImg = container.querySelector('img:not(.post-background-image-filter):not(.shreddit-subreddit-icon__icon)');
            if (fallbackImg && fallbackImg.src) {
              rawList.push(fallbackImg.src);
            }
          });
        }

        // 3. If containers didn't find anything, fallback to standalone post-image or zoomable-img
        if (rawList.length === 0) {
          const directImgs = sp.querySelectorAll('zoomable-img img, img#post-image, img[data-post-media-primary]');
          directImgs.forEach(img => {
            if (img.src) rawList.push(img.src);
          });
        }

        return { rawList };
      });
    }
  });

  const rawList = res.customData?.rawList || [];
  console.log('Raw list from DOM:', rawList);

  // Deduplicate and filter
  const mediaMap = new Map(); // mediaId -> bestUrl
  const finalMedia = [];

  for (const itemUrl of rawList) {
    if (!isValidRedditPostImage(itemUrl)) continue;
    const mediaId = extractRedditMediaId(itemUrl);
    if (mediaId) {
      if (!mediaMap.has(mediaId)) {
        mediaMap.set(mediaId, itemUrl);
      } else {
        // If existing is preview and new is i.redd.it, upgrade it
        const existing = mediaMap.get(mediaId);
        if (existing.includes('preview.redd.it') && itemUrl.includes('i.redd.it')) {
          mediaMap.set(mediaId, itemUrl);
        }
      }
    } else {
      if (!finalMedia.some(m => m.url === itemUrl)) {
        finalMedia.push({ type: 'image', url: itemUrl });
      }
    }
  }

  for (const [id, bestUrl] of mediaMap.entries()) {
    finalMedia.push({ type: 'image', url: bestUrl });
  }

  console.log('Final media items:', finalMedia);
}

(async () => {
  await testUrl('https://www.reddit.com/r/TeluguFashion/s/O3oMEFuMzi');
  await testUrl('https://www.reddit.com/r/bollynewsandgossips/s/N4ONsL0IkK');
  process.exit(0);
})();
