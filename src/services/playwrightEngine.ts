import { chromium, Browser } from 'playwright';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';
import { logger } from '../utils/logger';

export interface PlaywrightExtractionResult<T = any> {
  title: string | null;
  description: string | null;
  snapshot: string | null; // data:image/jpeg;base64,...
  logo: string | null;
  ogSiteName: string | null;
  author: string | null;
  authorAvatar: string | null;
  publishedAt: string | null;
  type: string | null;
  html?: string | null;
  customData?: T;
}

export interface PlaywrightScrapeOptions<T = any> {
  containerSelectors?: string[];
  waitSelector?: string;
  waitTimeout?: number;
  timeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  viewportOnly?: boolean;
  includeHtml?: boolean;
  customEvaluator?: (page: import('playwright').Page) => Promise<T>;
}

const BLOCKED_RESOURCE_TYPES = new Set([
  'stylesheet',
  'image',
  'media',
  'font',
  'ping',
  'eventsource',
  'websocket',
  'manifest',
]);

const BLOCKED_TRACKER_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'doubleclick.net',
  'clarity.ms',
  'hotjar.com',
];

class PlaywrightEngine {
  private static instance: PlaywrightEngine;
  private browserPromise: Promise<Browser> | null = null;

  private constructor() {
    this.setupProcessHandlers();
  }

  public static getInstance(): PlaywrightEngine {
    if (!PlaywrightEngine.instance) {
      PlaywrightEngine.instance = new PlaywrightEngine();
    }
    return PlaywrightEngine.instance;
  }

  /**
   * Retrieves or initializes the shared Chromium browser instance.
   * Auto-recovers if the browser disconnected or crashed.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) {
      try {
        const existing = await this.browserPromise;
        if (existing && existing.isConnected()) {
          return existing;
        }
      } catch {
        this.browserPromise = null;
      }
      this.browserPromise = null;
    }

    this.browserPromise = chromium
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-client-side-phishing-detection',
          '--disable-default-apps',
          '--disable-translate',
          '--disable-sync',
          '--metrics-recording-only',
          '--blink-settings=imagesEnabled=false',
          '--disable-extensions',
          '--mute-audio',
        ],
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          logger.warn('PlaywrightEngine', 'Chromium disconnected. Will re-launch on next request.');
          this.browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        this.browserPromise = null;
        throw err;
      });

    return this.browserPromise;
  }

  public async scrape<T = any>(
    targetUrl: string,
    options: PlaywrightScrapeOptions<T> = {}
  ): Promise<PlaywrightExtractionResult<T>> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: options.viewport || { width: 1280, height: 720 },
      userAgent:
        options.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
      // Abort stylesheets, images, fonts, media, websockets, and trackers for ultra-fast rendering
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
          return route.abort().catch(() => {});
        }

        const reqUrl = route.request().url().toLowerCase();
        for (const pattern of BLOCKED_TRACKER_PATTERNS) {
          if (reqUrl.includes(pattern)) {
            return route.abort().catch(() => {});
          }
        }

        return route.continue().catch(() => {});
      });

      // Navigate to target URL with configurable or default timeout
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: options.timeout || 7000,
      });

      // Wait for target selector if specified with strict timeout
      if (options.waitSelector) {
        await page
          .waitForSelector(options.waitSelector, {
            state: 'attached',
            timeout: options.waitTimeout || 2000,
          })
          .catch(() => {});
      }

      // Fast hydration pause
      await page.waitForTimeout(100);

      // -------------------------------------------------------------
      // DOM Metadata Extraction
      // -------------------------------------------------------------
      const metaData = await page.evaluate(() => {
        const getMeta = (...namesOrProperties: string[]) => {
          for (const key of namesOrProperties) {
            const el =
              document.querySelector(`meta[name="${key}"]`) ||
              document.querySelector(`meta[property="${key}"]`);
            if (el) {
              const content = el.getAttribute('content');
              if (content && content.trim()) return content.trim();
            }
          }
          return null;
        };

        // Title resolution order: twitter:title -> og:title -> meta[name="title"] -> document.title -> h1
        const twitterTitle = getMeta('twitter:title');
        const ogTitle = getMeta('og:title');
        const metaTitle = getMeta('title');
        const docTitle = document.title ? document.title.trim() : null;
        const h1Title = document.querySelector('h1')?.textContent?.trim() || null;
        const title = twitterTitle || ogTitle || metaTitle || docTitle || h1Title;

        // Description resolution order: twitter:description -> og:description -> meta[name="description"] -> first readable p
        const twitterDesc = getMeta('twitter:description');
        const ogDesc = getMeta('og:description');
        const metaDesc = getMeta('description');
        let firstP: string | null = null;
        const pEl = document.querySelector('article p, main p, p');
        if (pEl && pEl.textContent) {
          const text = pEl.textContent.trim();
          if (text.length > 20) {
            firstP = text.substring(0, 300);
          }
        }
        const description = twitterDesc || ogDesc || metaDesc || firstP;

        // Snapshot resolution order: og:image -> twitter:image -> meta[name="image"]
        const ogImage = getMeta('og:image', 'og:image:secure_url');
        const twitterImage = getMeta('twitter:image', 'twitter:image:src');
        const metaImage = getMeta('image');
        const image = ogImage || twitterImage || metaImage || null;

        const ogSiteName = getMeta('og:site_name');

        const author = getMeta('twitter:creator', 'author', 'article:author');
        const publishedAt = getMeta('article:published_time', 'pubdate');
        const type = getMeta('og:type') || 'website';

        // Logo resolution order: twitter -> meta -> og -> link icons
        const twitterLogo = getMeta('twitter:logo', 'twitter:app:icon:iphone');
        const metaLogo = getMeta('logo');
        const ogLogo = getMeta('og:logo');
        const appleIcon = document.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href');
        const icon = document.querySelector('link[rel~="icon"]')?.getAttribute('href');
        const shortcutIcon = document.querySelector('link[rel~="shortcut icon"]')?.getAttribute('href');
        const logo = twitterLogo || metaLogo || ogLogo || appleIcon || icon || shortcutIcon || null;

        return {
          title,
          description,
          image,
          ogSiteName,
          logo,
          author,
          publishedAt,
          type,
        };
      });

      const domain = new URL(targetUrl).hostname;
      const fallbackLogo = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
      const logo = resolveUrl(metaData.logo, targetUrl) || fallbackLogo;
      const snapshot = resolveUrl(metaData.image, targetUrl);

      let customData: T | undefined;
      if (options.customEvaluator) {
        try {
          customData = await options.customEvaluator(page);
        } catch {
          // Ignore evaluator error
        }
      }

      // Only serialize HTML if explicitly requested to avoid CPU & memory serialization churn
      const html = options.includeHtml ? await page.content().catch(() => null) : null;

      return {
        title: cleanTitle(metaData.title),
        description: cleanDescription(metaData.description),
        snapshot,
        logo,
        ogSiteName: metaData.ogSiteName,
        author: metaData.author,
        authorAvatar: null,
        publishedAt: metaData.publishedAt,
        type: metaData.type,
        html,
        customData,
      };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  public async closeBrowser(): Promise<void> {
    if (this.browserPromise) {
      const browser = await this.browserPromise;
      await browser.close().catch(() => {});
      this.browserPromise = null;
    }
  }

  private setupProcessHandlers(): void {
    const shutdown = async () => {
      await this.closeBrowser();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

export const playwrightEngine = PlaywrightEngine.getInstance();
