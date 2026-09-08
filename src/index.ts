import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import extractRouter from './routes/extract';
import proxyRouter from './routes/proxy';
import { initializeHttpClient } from './utils/httpClient';
import { logger } from './utils/logger';
import { playwrightEngine } from './services/playwrightEngine';

dotenv.config();

// Initialize global HTTP/HTTPS connection pooling for Axios
initializeHttpClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Performance
app.disable('x-powered-by');

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1', extractRouter);
app.use('/api/v1', proxyRouter);

// Global 404 Handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized JSON Error Handler Middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('App', 'Unhandled server error:', err?.message || err);
  res.status(err?.status || 500).json({
    error: err?.message || 'Internal server error',
  });
});

// Server Initialization
const server = app.listen(PORT, () => {
  logger.info('App', `Bookmark Extractor API listening on port ${PORT}`);
});

// Graceful Shutdown Handler
const gracefulShutdown = async (signal: string) => {
  logger.info('App', `Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    try {
      await playwrightEngine.closeBrowser();
      logger.info('App', 'Browser and server closed cleanly.');
      process.exit(0);
    } catch (error) {
      logger.error('App', 'Error during shutdown:', error);
      process.exit(1);
    }
  });

  // Force close if graceful shutdown takes longer than 5 seconds
  setTimeout(() => {
    logger.error('App', 'Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export default app;
