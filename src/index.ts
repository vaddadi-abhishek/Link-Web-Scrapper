import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import extractRouter from './routes/extract';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1', extractRouter);

// Global 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Server Initialization
app.listen(PORT, () => {
  console.log(`Bookmark Extractor API listening on port ${PORT}`);
});

export default app;
