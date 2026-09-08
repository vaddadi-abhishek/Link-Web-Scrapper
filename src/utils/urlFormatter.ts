/**
 * URL normalization and resolution utilities.
 */

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
  } catch {
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
  } catch {
    return null;
  }
}
