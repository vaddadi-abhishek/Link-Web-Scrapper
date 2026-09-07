const { playwrightEngine } = require('../dist/services/playwrightEngine');

(async () => {
  const url = 'https://www.reddit.com/r/cats/';
  const res = await playwrightEngine.scrape(url, {
    waitSelector: 'shreddit-post',
    waitTimeout: 5000,
    customEvaluator: async (page) => {
      return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('shreddit-post'));
        return posts.map(p => ({
          permalink: p.getAttribute('permalink'),
          postType: p.getAttribute('post-type'),
          contentHref: p.getAttribute('content-href'),
          hasGallery: !!p.querySelector('gallery-carousel')
        }));
      });
    }
  });

  console.log('Posts:', JSON.stringify(res.customData, null, 2));
  process.exit(0);
})();
