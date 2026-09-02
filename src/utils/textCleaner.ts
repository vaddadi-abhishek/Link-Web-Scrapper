/**
 * Utility for sanitizing and cleaning extracted titles and descriptions.
 */

// Basic HTML Entity Unescaping
export function unescapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\+([^a-zA-Z0-9\s])/g, '$1');
}

// Remove social engagement metrics header from descriptions (Instagram, Facebook, LinkedIn, Twitter)
// e.g. "654K likes, 4,503 comments - srividyakotnala on July 14, 2025: \"This song...\""
export function stripEngagementHeader(text: string): string {
  if (!text) return '';

  let cleaned = text.trim();

  // Pattern 1: Instagram style engagement metrics prefix
  // "654K likes, 4,503 comments - srividyakotnala on July 14, 2025: "
  cleaned = cleaned.replace(
    /^(?:[\d,.\sKMB]+(?:likes|comments|followers|views|posts|reposts|retweets)[^:]*:\s*"?)/i,
    ''
  );

  // Pattern 2: "username on Platform (Date): " or "username on Date: "
  cleaned = cleaned.replace(/^[a-zA-Z0-9._-]+\s+on\s+[a-zA-Z0-9\s,.:]+:\s*"?/i, '');

  return cleaned.trim();
}

// Remove Instagram / X / Platform Title prefix
// e.g. "Srividya Kotnala on Instagram: \"This song...\""
// e.g. "User (@handle) on X: \"...\""
export function stripPlatformTitlePrefix(title: string): string {
  if (!title) return '';

  let cleaned = title.trim();

  // "Author on Platform: " or "Author (@handle) on Platform: "
  cleaned = cleaned.replace(/^[^:]+\s+on\s+(?:Instagram|Twitter|X|Facebook|Reddit|LinkedIn|Pinterest):\s*"?/i, '');

  // Trailing platform site names: " | Instagram", " - YouTube", " • Instagram photos and videos"
  cleaned = cleaned.replace(/\s*[|•-]\s*(?:Instagram(?:\s+photos\s+and\s+videos)?|Twitter|X|Facebook|YouTube|Reddit|LinkedIn)\s*$/i, '');

  return cleaned.trim();
}

// Clean dot line spam used for formatting breaks (e.g. "\n.\n.\n" or " . . . ")
export function removeDotSpam(text: string): string {
  if (!text) return '';

  // Replace lines that contain only a dot, dash, or bullet
  let cleaned = text.replace(/(?:\r?\n\s*[\.\•\-]\s*)+/g, '\n');

  // Replace inline dot spam like " . . . " or " . . "
  cleaned = cleaned.replace(/(?:\s*\.\s*){3,}/g, ' ');

  return cleaned.trim();
}

// Strip outer quotes if enclosed ("title" -> title)
export function stripOuterQuotes(text: string): string {
  if (!text) return '';

  let cleaned = text.trim();

  // Strip leading/trailing quote marks if they wrap the entire string
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('“') && cleaned.endsWith('”')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Remove dangling trailing quote artifacts like '".' or '"' at the end of a string
  cleaned = cleaned.replace(/["”]\.?$/, '').trim();
  cleaned = cleaned.replace(/^["“]/, '').trim();

  return cleaned;
}

/**
 * Cleans extracted title string into an unescaped title, preserving line breaks.
 */
export function cleanTitle(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) return null;

  let title = unescapeHtml(rawTitle);
  title = stripPlatformTitlePrefix(title);
  title = stripOuterQuotes(title);
  title = removeDotSpam(title);

  return title.trim() || null;
}

/**
 * Cleans extracted description string into clean text, preserving line breaks.
 */
export function cleanDescription(rawDescription: string | null | undefined): string | null {
  if (!rawDescription) return null;

  let desc = unescapeHtml(rawDescription);
  desc = stripEngagementHeader(desc);
  desc = stripOuterQuotes(desc);
  desc = removeDotSpam(desc);

  return desc.trim() || null;
}
