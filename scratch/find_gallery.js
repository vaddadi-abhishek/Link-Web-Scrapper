const axios = require('axios');

(async () => {
  try {
    const res = await axios.get('https://www.reddit.com/r/TeluguFashion/hot.json?limit=15', {
      headers: { 'User-Agent': 'Twitterbot/1.0' }
    });
    const posts = res.data?.data?.children || [];
    for (const p of posts) {
      const d = p.data;
      if (d.is_gallery || (d.gallery_data && d.gallery_data.items)) {
        console.log('Found gallery post:', d.permalink, 'Items count:', d.gallery_data?.items?.length);
      }
    }
  } catch (err) {
    console.error('Error fetching json:', err.message);
  }
  process.exit(0);
})();
