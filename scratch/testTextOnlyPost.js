const dotenv = require('dotenv');
dotenv.config();

const { analyzeVisualContext } = require('../dist/services/aiVisualService');

async function testTextOnly() {
  console.log("=== Testing Text-Only Reddit Post ===");
  const redditResult = await analyzeVisualContext({
    url: 'https://www.reddit.com/r/reactjs/comments/sample_text_post/',
    title: 'Why React Server Components are great for full stack web development',
    description: 'React Server Components allow rendering UI components on the server without sending large client JS bundles, improving initial load speed and SEO performance significantly.',
    site_name: 'Reddit',
    type: 'reddit',
    card_data: { media: [] }
  });

  console.log("Reddit AI Context:", redditResult.ai_context);
  console.log("Reddit AI Tags:", redditResult.ai_tags);

  console.log("\n=== Testing Instagram Login Wall ===");
  const igResult = await analyzeVisualContext({
    url: 'https://www.instagram.com/reels/DcyaZzQTqTB/',
    title: 'Login',
    description: '',
    site_name: 'Instagram',
    type: 'instagram',
    card_data: { media: [] }
  });

  console.log("Instagram AI Context:", igResult.ai_context);
  console.log("Instagram AI Tags:", igResult.ai_tags);
}

testTextOnly();
