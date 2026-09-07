const { playwrightEngine } = require('../dist/services/playwrightEngine');

(async () => {
  const url = 'https://www.reddit.com/r/TeluguFashion/s/O3oMEFuMzi';
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const sp = document.querySelector('shreddit-post');
        if (!sp) return { error: 'no shreddit-post' };

        const allImgs = Array.from(sp.querySelectorAll('img')).map(img => ({
          id: img.id,
          className: img.className,
          src: img.src,
          srcset: img.srcset,
          alt: img.alt,
          parentTag: img.parentElement?.tagName,
          parentClass: img.parentElement?.className,
          isPrimary: img.hasAttribute('data-post-media-primary'),
        }));

        const postType = sp.getAttribute('post-type');
        const contentHref = sp.getAttribute('content-href');

        return {
          postType,
          contentHref,
          allImgs,
        };
      });
    }
  });

  console.log('Inspection result:', JSON.stringify(res.customData, null, 2));
  process.exit(0);
})();
