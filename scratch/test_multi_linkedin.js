const fs = require('fs');
const cheerio = require('cheerio');

function isGhostOrProfileAvatar(url) {
  if (!url) return true;
  const l = url.toLowerCase();
  return (
    l.includes('ghost_person') ||
    l.includes('ghost_profile') ||
    l.includes('ghost-avatar') ||
    l.includes('aero-v1') ||
    l.includes('9c8pery4andzj6ohjkjp54ma2') ||
    l.includes('profile-displayphoto') ||
    l.includes('profile-displaybackgroundimage') ||
    l.includes('cover-image')
  );
}

function extractLinkedInImages(html) {
  const images = [];
  const $ = cheerio.load(html);

  // 1. Extract from JSON-LD
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
        if (Array.isArray(json.image)) {
          json.image.forEach(img => {
            if (typeof img === 'string') {
              images.push(img);
            } else if (img && typeof img === 'object' && img.url) {
              images.push(img.url);
            }
          });
        } else if (typeof json.image === 'string') {
          images.push(json.image);
        } else if (json.image && typeof json.image === 'object' && json.image.url) {
          images.push(json.image.url);
        }

        if (json.thumbnailUrl && typeof json.thumbnailUrl === 'string') {
          images.push(json.thumbnailUrl);
        }
      }
    } catch {}
  });

  // 2. Extract from DOM: feedshare images
  $('img[data-delayed-url*="feedshare-image"], img[src*="feedshare-image"]').each((_, el) => {
    const src = $(el).attr('data-delayed-url') || $(el).attr('src');
    if (src && !isGhostOrProfileAvatar(src)) {
      images.push(src);
    }
  });

  // Also check og:image
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg && !isGhostOrProfileAvatar(ogImg)) {
    images.push(ogImg);
  }

  // Deduplicate and filter
  const cleanImages = [];
  const seenIds = new Set();
  for (const img of images) {
    if (!img || isGhostOrProfileAvatar(img)) continue;
    // Clean URL
    const cleanUrl = img.replace(/&amp;/g, '&');
    // Deduplicate by media ID or base path
    const idMatch = cleanUrl.match(/\/feedshare-image[^\/]*\/([^\/?]+)/);
    const key = idMatch ? idMatch[1] : cleanUrl.split('?')[0];
    if (!seenIds.has(key)) {
      seenIds.add(key);
      cleanImages.push(cleanUrl);
    }
  }

  return cleanImages;
}

const html = fs.readFileSync('./scratch/linkedin_bot.html', 'utf8');
const result = extractLinkedInImages(html);
console.log('Extracted LinkedIn Images Count:', result.length);
result.forEach((url, i) => {
  console.log(`  [Image ${i}] ${url}`);
});
