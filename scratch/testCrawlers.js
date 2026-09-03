const axios = require('axios');
const cheerio = require('cheerio');

async function testCrawlers() {
  const shortcode = 'DcyaZzQTqTB';
  const urls = [
    `https://www.instagram.com/reels/${shortcode}/`,
    `https://www.instagram.com/p/${shortcode}/`,
  ];

  const userAgents = {
    'facebookexternalhit': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'twitterbot': 'Twitterbot/1.0',
    'googlebot': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'meta-crawler': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };

  for (const url of urls) {
    console.log(`\n=== Testing Target URL: ${url} ===`);
    for (const [name, ua] of Object.entries(userAgents)) {
      try {
        const res = await axios.get(url, {
          headers: {
            'User-Agent': ua,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          },
          timeout: 5000,
        });

        const html = res.data;
        const $ = cheerio.load(html);
        const title = $('title').text() || $('meta[property="og:title"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content');
        const ogDesc = $('meta[property="og:description"]').attr('content');

        console.log(`[${name}]:`);
        console.log(`  Title:`, title);
        console.log(`  og:image:`, ogImage ? ogImage.substring(0, 80) + '...' : 'NULL');
        console.log(`  og:description:`, ogDesc ? ogDesc.substring(0, 80) + '...' : 'NULL');
      } catch (err) {
        console.log(`[${name}]: FAILED - ${err?.message}`);
      }
    }
  }
}

testCrawlers();
