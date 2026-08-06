import { chromium, Browser } from 'playwright';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';

export interface PlaywrightExtractionResult {
  title: string | null;
  description: string | null;
  snapshot: string | null; // data:image/jpeg;base64,...
  logo: string | null;
  ogSiteName: string | null;
}

export interface PlaywrightScrapeOptions {
  containerSelectors?: string[];
  waitSelector?: string;
  waitTimeout?: number;
  userAgent?: string;
}

const DEFAULT_CONTAINER_SELECTORS = [
  'shreddit-post',
  'article[role="article"]',
  'article',
  '[role="main"]',
  'main',
  '#content',
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

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
          ],
        })
        .catch((err) => {
          this.browserPromise = null;
          throw err;
        });
    }
    return this.browserPromise;
  }

  public async scrape(
    targetUrl: string,
    options: PlaywrightScrapeOptions = {}
  ): Promise<PlaywrightExtractionResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        options.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
      // Abort heavy resource types: media, font
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (resourceType === 'media' || resourceType === 'font') {
          return route.abort();
        }
        return route.continue();
      });

      // Navigate to target URL
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      // Wait for target selector if specified
      if (options.waitSelector) {
        await page
          .waitForSelector(options.waitSelector, {
            state: 'attached',
            timeout: options.waitTimeout || 5000,
          })
          .catch(() => {});
      }

      // Brief hydration pause
      await page.waitForTimeout(500);

      // -------------------------------------------------------------
      // Element-Level Container Cropping vs Viewport Fallback
      // -------------------------------------------------------------
      let imageBuffer: Buffer | null = null;
      const containerSelectors = options.containerSelectors || DEFAULT_CONTAINER_SELECTORS;

      for (const selector of containerSelectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isVisible().catch(() => false);
            const box = await element.boundingBox().catch(() => null);

            // Bounding box checks to ensure element is valid and not empty
            if (isVisible && box && box.width > 0 && box.height > 0) {
              imageBuffer = await element.screenshot({
                type: 'jpeg',
                quality: 80,
              });
              break;
            }
          }
        } catch {
          // Continue to next selector if check or screenshot fails
        }
      }

      // Fallback to standard 1280x720 viewport screenshot if no container element matched or is visible
      if (!imageBuffer) {
        imageBuffer = await page.screenshot({
          type: 'jpeg',
          quality: 75,
          fullPage: false,
        });
      }

      const snapshot = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

      // -------------------------------------------------------------
      // DOM Metadata Extraction
      // -------------------------------------------------------------
      const metaData = await page.evaluate(() => {
        const getMeta = (propertyOrName: string) => {
          const el =
            document.querySelector(`meta[property="${propertyOrName}"]`) ||
            document.querySelector(`meta[name="${propertyOrName}"]`);
          return el ? el.getAttribute('content') : null;
        };

        const ogTitle = getMeta('og:title');
        const twitterTitle = getMeta('twitter:title');
        const docTitle = document.title;
        const title = (ogTitle || twitterTitle || docTitle || '').trim() || null;

        const ogDesc = getMeta('og:description');
        const twitterDesc = getMeta('twitter:description');
        const metaDesc = getMeta('description');
        const description = (ogDesc || twitterDesc || metaDesc || '').trim() || null;

        const ogSiteName = getMeta('og:site_name');

        const appleIcon = document.querySelector('link[rel~="apple-touch-icon"]')?.getAttribute('href');
        const icon = document.querySelector('link[rel~="icon"]')?.getAttribute('href');
        const shortcutIcon = document.querySelector('link[rel~="shortcut icon"]')?.getAttribute('href');
        const logo = appleIcon || icon || shortcutIcon || null;

        return {
          title,
          description,
          ogSiteName,
          logo,
        };
      });

      const domain = new URL(targetUrl).hostname;
      const fallbackLogo = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
      const logo = resolveUrl(metaData.logo, targetUrl) || fallbackLogo;

      return {
        title: cleanTitle(metaData.title),
        description: cleanDescription(metaData.description),
        snapshot,
        logo,
        ogSiteName: metaData.ogSiteName,
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
