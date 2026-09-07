const { playwrightEngine } = require('../dist/services/playwrightEngine');

(async () => {
  // Let's test a known Reddit carousel post or test the TeluguFashion post
  const url = 'https://www.reddit.com/r/TeluguFashion/s/O3oMEFuMzi';
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const sp = document.querySelector('shreddit-post');
        if (!sp) return null;

        // Check content-href
        const contentHref = sp.getAttribute('content-href');

        // Check zoomable-img
        const zoomableImgs = Array.from(sp.querySelectorAll('zoomable-img img')).map(i => i.src);

        // Check data-post-media-primary or #post-image
        const primaryImg = sp.querySelector('img[data-post-media-primary], img#post-image');
        const primarySrc = primaryImg?.src;

        // Check gallery items
        const galleryImgs = Array.from(sp.querySelectorAll('gallery-carousel img, shreddit-aspect-ratio img')).map(i => i.src);

        // Check media-lightbox-img
        const lightboxImgs = Array.from(sp.querySelectorAll('.media-lightbox-img img:not(.post-background-image-filter)')).map(i => i.src);

        return {
          contentHref,
          zoomableImgs,
          primarySrc,
          galleryImgs,
          lightboxImgs
        };
      });
    }
  });

  console.log('Result:', JSON.stringify(res.customData, null, 2));
  process.exit(0);
})();
