/**
 * Centralized utility for parsing formatted metric number strings into integers.
 * E.g., "1.5K" -> 1500, "2.3M" -> 2300000, "500" -> 500
 */
export function parseFormattedNumber(str: string | null | undefined): number {
  if (!str) return 0;
  const cleaned = str.toUpperCase().replace(/,/g, '').trim();
  let num = parseFloat(cleaned);
  if (isNaN(num)) return 0;

  if (cleaned.includes('K')) num *= 1000;
  else if (cleaned.includes('M')) num *= 1000000;
  else if (cleaned.includes('B')) num *= 1000000000;

  return Math.floor(num);
}
