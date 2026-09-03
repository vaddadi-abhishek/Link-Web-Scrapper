const dotenv = require('dotenv');
dotenv.config();

const { instagramExtractor } = require('../dist/services/extractors/instagram');
const { analyzeVisualContext } = require('../dist/services/aiVisualService');

async function testExtraction() {
  const url = 'https://www.instagram.com/reels/DcyaZzQTqTB/';
  console.log("Extracting Restricted Reel URL:", url);

  const result = await instagramExtractor.extract(url);
  console.log("=== EXTACTED METADATA ===");
  console.log("Title:", result.title);
  console.log("Description:", result.description);
  console.log("Snapshot Image:", result.snapshot);
  console.log("Author Username:", result.card_data.author.username);

  console.log("\n=== RUNNING AI VISUAL INTELLIGENCE ===");
  const aiResult = await analyzeVisualContext({
    url,
    title: result.title,
    description: result.description,
    snapshot: result.snapshot,
    site_name: result.ogSiteName,
    type: 'instagram',
    card_data: result.card_data
  });

  console.log("AI Context:", aiResult.ai_context);
  console.log("AI Tags:", aiResult.ai_tags);
}

testExtraction();
