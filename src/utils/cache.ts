/**
 * High-performance, zero-dependency in-memory LRU cache with TTL expiration.
 * Uses JavaScript Map's guaranteed insertion-order iteration for O(1) eviction.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(defaultTtlSeconds = 900, maxEntries = 1000) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU order: delete and re-set moves it to the most recently used position
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds?: number): void {
    const ttlMs = (ttlSeconds ?? (this.defaultTtlMs / 1000)) * 1000;

    // If key already exists, delete it first to maintain LRU position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// -------------------------------------------------------------
// Pre-configured Singleton Caches
// -------------------------------------------------------------

/**
 * Extraction Cache: Caches full extracted metadata responses by normalized URL.
 * TTL: 30 minutes (1800s), Max: 1,000 entries (~1-2MB RAM).
 */
export const extractionCache = new MemoryCache<any>(1800, 1000);

/**
 * Avatar & Entity Cache: Caches external author/channel avatars.
 * TTL: 2 hours (7200s), Max: 500 entries.
 */
export const avatarCache = new MemoryCache<string>(7200, 500);

/**
 * AI Visual Analysis Cache: Caches Gemini visual intelligence results.
 * TTL: 1 hour (3600s), Max: 500 entries.
 */
export const aiCache = new MemoryCache<any>(3600, 500);

/**
 * DNS Resolution Cache: Caches validated clean hostnames for SSRF checks.
 * TTL: 5 minutes (300s), Max: 500 entries.
 */
export const dnsCache = new MemoryCache<boolean>(300, 500);
