import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import extractRouter from './routes/extract';
import proxyRouter from './routes/proxy';
import bookmarkRouter from './routes/bookmarks';
import authRouter from './routes/auth';
import { initializeHttpClient } from './utils/httpClient';
import { logger } from './utils/logger';
import { playwrightEngine } from './services/playwrightEngine';
import { apiRateLimiter } from './middleware/rateLimiter';

dotenv.config();

// Initialize global HTTP/HTTPS connection pooling for Axios
initializeHttpClient();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Render, Vercel, Cloudflare) for accurate client IP resolution and rate limiting
app.set('trust proxy', 1);

// Security: Helmet HTTP Headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows image proxy to stream across origins
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

app.disable('x-powered-by');

// Allowed Origins Whitelist
const rawAllowedOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://usemindspace.vercel.app',
  'https://mindspace.vercel.app',
  'https://mindspace-link-web-scrapper.onrender.com',
  'https://mindspace-node-backend.onrender.com',
];

const allowedOrigins = rawAllowedOrigins
  .flat()
  .filter(Boolean)
  .map((o) => (o as string).trim().replace(/\/+$/, ''));

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Normalize origin: strip trailing slashes
    const cleanOrigin = origin.trim().replace(/\/+$/, '');

    // Check if origin matches allowed list, local LAN, Vercel deployments, or Chrome extension
    const isAllowed =
      allowedOrigins.includes(cleanOrigin) ||
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(cleanOrigin) ||
      /^http:\/\/localhost(:\d+)?$/.test(cleanOrigin) ||
      /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(cleanOrigin) ||
      cleanOrigin === 'https://usemindspace.vercel.app' ||
      cleanOrigin === 'https://mindspace.vercel.app' ||
      cleanOrigin.endsWith('.vercel.app') ||
      cleanOrigin.startsWith('chrome-extension://');

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn('CORS', `Blocked request from untrusted origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auto-AI-Context', 'Prefer'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Apply general API rate limiter to all /api/v1 routes
app.use('/api/v1', apiRateLimiter);

// API Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1', bookmarkRouter);
app.use('/api/v1', extractRouter);
app.use('/api/v1', proxyRouter);

// Global 404 Handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized JSON Error Handler Middleware (Enforcing Generic Client-Side Error Messages)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;

  // Always log the full technical error details internally
  logger.error('App', `Server error [${status}]:`, message);

  // Security standard: Never leak internal stack traces or database errors to the client on 500s
  const clientResponse =
    status >= 500
      ? 'An unexpected error occurred. Please try again later.'
      : message || 'Request failed';

  res.status(status).json({
    error: clientResponse,
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
