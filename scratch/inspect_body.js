const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  await page.goto('https://www.reddit.com/r/developersIndia/comments/1w9igxo/assuming_the_entire_software_engineering_industry/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const data = await page.evaluate(() => {
    const el = document.querySelector('shreddit-post-text-body');
    const articleBody = el?.querySelector('[property="schema:articleBody"]');
    return {
      articleBodyInnerText: articleBody ? (articleBody.innerText || articleBody.textContent) : null,
      paragraphs: Array.from(articleBody ? articleBody.querySelectorAll('p') : []).map(p => (p.innerText || p.textContent).trim())
    };
  });
  console.log(JSON.stringify(data, null, 2));

  await browser.close();
})();
