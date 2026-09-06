/**
 * Centralized utility for parsing formatted metric number strings into integers.
 * E.g., "1.5K" -> 1500, "2.3M" -> 2300000, "500" -> 500
 */
export function parseFormattedNumber(str: string | null | undefined): number {
  if (!str) return 0;
  const raw = str.trim();
  const cleaned = raw.toUpperCase().replace(/,/g, '').trim();
  let num = parseFloat(cleaned);
  if (isNaN(num)) return 0;

  if (cleaned.includes('K') || raw.includes('వే') || raw.includes('हज़ार')) {
    num *= 1000;
  } else if (cleaned.includes('M')) {
    num *= 1000000;
  } else if (cleaned.includes('B')) {
    num *= 1000000000;
  } else if (cleaned.includes('CR') || raw.includes('కోటి') || raw.includes('करोड़')) {
    num *= 10000000;
  } else if (cleaned.includes('L') || raw.includes('లక్ష') || raw.includes('లాఖ్') || raw.includes('लाख')) {
    num *= 100000;
  }

  return Math.floor(num);
}
