const { playwrightEngine } = require('../dist/services/playwrightEngine');

(async () => {
  const url = 'https://www.reddit.com/r/cats/comments/1vnwvcv/saying_goodbye_to_our_24_year_old_baby/';
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const sp = document.querySelector('shreddit-post');
        if (!sp) return null;

        const galleryCarousel = sp.querySelector('gallery-carousel');
        const allImgsInPost = Array.from(sp.querySelectorAll('gallery-carousel img, .media-lightbox-img img, zoomable-img img')).map(img => ({
          src: img.src,
          className: img.className,
          id: img.id,
          parentTag: img.parentElement?.tagName,
          isPrimary: img.hasAttribute('data-post-media-primary')
        }));

        const items = Array.from(sp.querySelectorAll('gallery-carousel ul li, gallery-carousel figure, [slot="post-media-container"] figure, .media-lightbox-img')).map(el => ({
          tag: el.tagName,
          className: el.className,
          imgs: Array.from(el.querySelectorAll('img')).map(i => i.src)
        }));

        return {
          hasGalleryCarousel: !!galleryCarousel,
          allImgsInPost,
          itemsCount: items.length,
          items
        };
      });
    }
  });

  console.log('Gallery inspection:', JSON.stringify(res.customData, null, 2));
  process.exit(0);
})();
