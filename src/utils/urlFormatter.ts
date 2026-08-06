/**
 * Normalizes a raw input URL by adding scheme if missing and validating format.
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  let formatted = rawUrl.trim();
  if (!/^https?:\/\//i.test(formatted)) {
    formatted = `https://${formatted}`;
  }

  try {
    const parsed = new URL(formatted);
    return parsed.toString();
  } catch (err) {
    throw new Error(`Invalid URL format: ${rawUrl}`);
  }
}

/**
 * Resolves relative URLs (e.g. /favicon.ico) against a base URL.
 */
export function resolveUrl(relativeOrAbsolute: string | null | undefined, baseUrl: string): string | null {
  if (!relativeOrAbsolute) return null;
  const trimmed = relativeOrAbsolute.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch (err) {
    return null;
  }
}

/**
 * Determines whether a URL is a generic homepage rather than a deep resource link.
 */
export function isHomepage(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return pathname === '' || pathname === '/index.html' || pathname === '/index.php';
  } catch (err) {
    return false;
  }
}
