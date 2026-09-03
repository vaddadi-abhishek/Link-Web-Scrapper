const axios = require('axios');

async function testReelScrape() {
  const shortcode = 'DcyaZzQTqTB';
  console.log("Testing shortcode:", shortcode);

  const urlsToTest = [
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/p/${shortcode}/embed/`,
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/graphql/query/?query_hash=b30374742744f6007321ee360d9be4f7&variables=%7B%22shortcode%22%3A%22${shortcode}%22%7D`
  ];

  const userAgents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0'
  ];

  for (const url of urlsToTest) {
    console.log(`\n--- Testing URL: ${url} ---`);
    for (const ua of userAgents) {
      try {
        const res = await axios.get(url, {
          headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' },
          timeout: 4000
        });
        const html = String(res.data || '');
        const isLogin = html.includes('Welcome back to Instagram') || html.includes('<title>Login') || html.includes('title>Instagram');
        console.log(`UA [${ua.substring(0, 20)}...]: Status 200, Length: ${html.length}, isLogin: ${isLogin}`);

        if (!isLogin) {
          const displayMatch = html.match(/"display_url"\s*:\s*"([^"]+)"/) || html.match(/display_url\\":\s*\\?"([^"]+)\\?"/);
          console.log(`  -> SUCCESS! display_url:`, displayMatch ? displayMatch[1].substring(0, 60) : "NO DISPLAY MATCH");
        }
      } catch (err) {
        console.log(`UA [${ua.substring(0, 20)}...]: FAILED - ${err?.message}`);
      }
    }
  }
}

testReelScrape();
