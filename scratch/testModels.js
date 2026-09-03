const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

console.log("Testing API Key:", apiKey ? `${apiKey.substring(0, 8)}...` : "NONE");

const ai = new GoogleGenAI({ apiKey });

async function run() {
  const modelsToTest = [
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-3.7-flash',
  ];

  for (const m of modelsToTest) {
    try {
      console.log(`Testing model: ${m}...`);
      const res = await ai.models.generateContent({
        model: m,
        contents: [{ text: "Hello! Reply with 'OK'" }]
      });
      console.log(`✅ SUCCESS [${m}]:`, res.text ? res.text.trim() : "No text");
    } catch (err) {
      console.log(`❌ FAILED [${m}]:`, err?.message || err);
    }
  }
}

run();
