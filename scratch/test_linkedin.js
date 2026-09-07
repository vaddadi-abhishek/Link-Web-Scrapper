const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

async function testLinkedIn() {
  const url = 'https://www.linkedin.com/posts/susmitha-pottipogu-b7256428b_infosys-systemengineer-newbeginnings-activity-7501882720671805440-RxKH';

  console.log('Fetching LinkedIn URL with LinkedInBot UA...');
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'LinkedInBot/1.0 (sdk@linkedin.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000,
    });
    console.log('Status:', res.status, 'HTML len:', res.data.length);
    fs.writeFileSync('./scratch/linkedin_bot.html', res.data);

    const $ = cheerio.load(res.data);
    console.log('\n--- JSON-LD SCRIPTS ---');
    $('script[type="application/ld+json"]').each((i, s) => {
      console.log(`Script ${i}:`);
      try {
        const parsed = JSON.parse($(s).text());
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log('Raw text:', $(s).text().substring(0, 300));
      }
    });

    console.log('\n--- ALL IMAGES IN HTML ---');
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      const delayed = $(el).attr('data-delayed-url');
      const parentClass = $(el).parent().attr('class') || '';
      const className = $(el).attr('class') || '';
      console.log(`[Img ${i}] class="${className}", parent="${parentClass}"\n  src="${src ? src.substring(0, 90) : ''}..."\n  delayed="${delayed ? delayed.substring(0, 90) : ''}..."`);
    });

    console.log('\n--- SEARCHING FOR "feedshare-image" OR "media.licdn.com" IN HTML ---');
    const matches = res.data.match(/https:\/\/[^"'\s<>\\]*media\.licdn\.com\/dms\/image[^"'\s<>\\]*/g);
    console.log('Unique media.licdn.com matches:', Array.from(new Set(matches)));

  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

testLinkedIn();
