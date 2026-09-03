const axios = require('axios');

async function inspectEmbed() {
  const shortcode = 'DcyaZzQTqTB';
  const url = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = res.data;
  console.log("HTML length:", html.length);

  // Search for any img tags, poster attributes, src attributes, or json data
  const imgMatches = html.match(/src="([^"]+)"/g);
  console.log("Found img src matches:", imgMatches ? imgMatches.slice(0, 15) : []);

  const posterMatches = html.match(/poster="([^"]+)"/g);
  console.log("Found poster matches:", posterMatches);

  // Check for window.__additionalDataLoaded or _sharedData or Require
  const scriptData = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  console.log("Total script tags:", scriptData ? scriptData.length : 0);

  if (scriptData) {
    scriptData.forEach((s, idx) => {
      if (s.includes('http') && (s.includes('cdninstagram') || s.includes('fbcdn'))) {
        console.log(`Script #${idx} snippet:`, s.substring(0, 300));
      }
    });
  }
}

inspectEmbed();
