import { chromium, Browser } from 'playwright';
import { resolveUrl } from '../utils/urlFormatter';
import { cleanTitle, cleanDescription } from '../utils/textCleaner';

export interface PlaywrightExtractionResult {
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
}

export interface PlaywrightScrapeOptions {
  containerSelectors?: string[];
  waitSelector?: string;
  waitTimeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  viewportOnly?: boolean;
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
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-translate',
            '--disable-sync',
            '--metrics-recording-only',
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
      viewport: options.viewport || { width: 1280, height: 720 },
      userAgent:
        options.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    try {
      // Abort heavy resource types and analytics/ad trackers
      await page.route('**/*', (route) => {
        const reqUrl = route.request().url().toLowerCase();
        const resourceType = route.request().resourceType();

        if (
          resourceType === 'media' ||
          resourceType === 'font' ||
          reqUrl.includes('google-analytics.com') ||
          reqUrl.includes('googletagmanager.com') ||
          reqUrl.includes('connect.facebook.net') ||
          reqUrl.includes('doubleclick.net')
        ) {
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

      // Automatically dismiss modal popups, login overlays, and cookie banners before screenshotting
      await page.evaluate(() => {
        const dialogSelectors = [
          '[role="dialog"]',
          '#login_popup_cta',
          'div[aria-label="Close"]',
          'div[aria-label="Decline"]',
          'div[aria-label="Dismiss"]',
          'div[aria-label="Log In"]',
          'div[aria-label="Log in"]',
          'div[data-testid="cookie-policy-dialog"]',
          'div[id^="mount_0_0"] div[role="dialog"]',
        ];

        dialogSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((element) => {
            element.remove();
          });
        });

        // Restore body/html scrolling and clear blur/overflow locks
        document.body.style.overflow = 'auto';
        document.body.style.position = 'static';
        document.documentElement.style.overflow = 'auto';
      }).catch(() => {});

      // -------------------------------------------------------------
      // Element-Level Container Cropping vs Viewport Fallback
      // -------------------------------------------------------------
      let imageBuffer: Buffer | null = null;

      if (!options.viewportOnly) {
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
      }

      // Fallback or explicit viewport screenshot (no fullPage scrolling)
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

        // Title resolution order: twitter -> meta -> og -> document.title
        const twitterTitle = getMeta('twitter:title');
        const metaTitle = getMeta('title');
        const ogTitle = getMeta('og:title');
        const docTitle = document.title ? document.title.trim() : null;
        const title = twitterTitle || metaTitle || ogTitle || docTitle;

        // Description resolution order: twitter -> meta -> og
        const twitterDesc = getMeta('twitter:description');
        const metaDesc = getMeta('description');
        const ogDesc = getMeta('og:description');
        const description = twitterDesc || metaDesc || ogDesc;

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
          ogSiteName,
          logo,
          author,
          publishedAt,
          type
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
        author: metaData.author,
        authorAvatar: null,
        publishedAt: metaData.publishedAt,
        type: metaData.type,
        html: await page.content().catch(() => null),
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
