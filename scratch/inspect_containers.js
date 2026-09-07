const { playwrightEngine } = require('../dist/services/playwrightEngine');

(async () => {
  // Let's test a subreddit with multi-image posts, e.g. /r/TeluguFashion or search
  const url = 'https://www.reddit.com/r/TeluguFashion/comments/1w80wgy/ft_freshers_day/';
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const sp = document.querySelector('shreddit-post');
        if (!sp) return null;

        const mediaContainers = Array.from(sp.querySelectorAll('gallery-carousel, .media-lightbox-img, [slot="post-media-container"]')).map(el => ({
          tag: el.tagName,
          className: el.className,
          innerImgs: Array.from(el.querySelectorAll('img')).map(i => ({
            src: i.src,
            className: i.className,
            alt: i.alt,
            isPrimary: i.hasAttribute('data-post-media-primary'),
            id: i.id,
            parentTag: i.parentElement?.tagName
          }))
        }));

        return { mediaContainers };
      });
    }
  });

  console.log('Media containers:', JSON.stringify(res.customData, null, 2));
  process.exit(0);
})();
