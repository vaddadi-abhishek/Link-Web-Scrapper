const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

async function testMultimodal() {
  try {
    console.log("Testing multimodal vision with gemini-3.5-flash...");
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        {
          text: `You are an AI Visual Intelligence system. Return JSON: { "ai_context": "Sample context paragraph about Sadie Sink, American actress known for Stranger Things and Hollywood films.", "ai_tags": ["sadie-sink", "actress", "hollywood", "beauty"] }`
        }
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    console.log("✅ MULTIMODAL VISION PROMPT SUCCESS!");
    console.log("Response JSON:", res.text);
  } catch (err) {
    console.error("❌ MULTIMODAL FAILED:", err?.message || err);
  }
}

testMultimodal();
