const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

async function testVideoAnalysis() {
  const videoUrl = "https://www.w3schools.com/html/mov_bbb.mp4";
  console.log("Downloading video sample:", videoUrl);

  try {
    const res = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }
    });

    const base64Video = Buffer.from(res.data).toString('base64');
    console.log("Video downloaded! Size in bytes:", res.data.length);

    console.log("Sending video/mp4 to Gemini gemini-3.5-flash...");
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'video/mp4',
            data: base64Video
          }
        },
        {
          text: 'Describe what happens in this video. Return JSON: { "ai_context": "...", "ai_tags": ["tag1", "tag2"] }'
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    console.log("✅ VIDEO GEMINI SUCCESS!");
    console.log("Response:", response.text);

  } catch (err) {
    console.error("❌ VIDEO GEMINI FAILED:", err?.message || err);
  }
}

testVideoAnalysis();
