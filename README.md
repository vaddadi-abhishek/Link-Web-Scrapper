# Bookmark Extractor & AI Visual Intelligence API

Stateless high-performance REST API for extracting metadata, capturing webpage snapshots, and performing Multimodal AI Visual Intelligence analysis on bookmarked media.

## Environment Setup

Create a `.env` file in `tagger-node-backend/` based on `.env.example`:

```env
PORT=3000
GEMINI_API_KEY=your_free_gemini_api_key_here
```

### How to Get Your Free Google Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com).
2. Sign in with your Google account (or Google One / Pro account).
3. Click **"Get API Key"** and create a key (100% Free tier).
4. Copy the API key and set `GEMINI_API_KEY=AIzaSy...` in `tagger-node-backend/.env`.

## Commands

- `npm run dev`: Start dev server with hot reload
- `npm run build`: Compile TypeScript
- `npm start`: Run compiled server
