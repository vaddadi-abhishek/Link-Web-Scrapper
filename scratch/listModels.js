const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

async function listAllModels() {
  try {
    const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    console.log("=== Available Models for Key ===");
    const models = res.data.models || [];
    models.forEach(m => {
      if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')) {
        console.log(`- ${m.name.replace('models/', '')} (${m.displayName})`);
      }
    });
  } catch (err) {
    console.error("Failed to list models:", err?.response?.data || err?.message || err);
  }
}

listAllModels();
