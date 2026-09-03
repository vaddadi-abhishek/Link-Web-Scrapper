const axios = require('axios');

async function testIgEmbed() {
  const shortcode = 'DaDhibyJrfQ';
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  try {
    const res = await axios.get(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      },
    });

    const html = res.data;
    console.log("HTML Length:", html.length);

    // Video URL
    const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/) || html.match(/video_url\\":\s*\\?"([^"]+)\\?"/);
    console.log("Video Match:", videoMatch ? videoMatch[1].substring(0, 50) + "..." : "NULL");

    // Display / Thumbnail Image URL
    const displayMatch = html.match(/"display_url"\s*:\s*"([^"]+)"/) || 
                         html.match(/display_url\\":\s*\\?"([^"]+)\\?"/) ||
                         html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/) ||
                         html.match(/thumbnail_src\\":\s*\\?"([^"]+)\\?"/) ||
                         html.match(/<img[^>]+src="([^"]+)"/);
    console.log("Display Image Match:", displayMatch ? displayMatch[1].substring(0, 80) + "..." : "NULL");

    // Username
    const usernameMatch = html.match(/"username"\s*:\s*"([^"]+)"/) || html.match(/class="UsernameText"[^>]*>([^<]+)/);
    console.log("Username Match:", usernameMatch ? usernameMatch[1] : "NULL");

    // Caption
    const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/) || 
                         html.match(/class="CaptionText"[^>]*>([\s\S]*?)<\/div>/) ||
                         html.match(/"caption"\s*:\s*\{"text"\s*:\s*"([^"]+)"\}/);
    console.log("Caption Match:", captionMatch ? captionMatch[1].replace(/<[^>]+>/g, '').trim() : "NULL");

  } catch (err) {
    console.error("Embed fetch failed:", err?.message || err);
  }
}

testIgEmbed();
