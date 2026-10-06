import dns from 'dns';
import { promisify } from 'util';
import { dnsCache } from './cache';

const lookup = promisify(dns.lookup);

export const MAX_URL_LENGTH = 2048;

/**
 * Validates a URL to prevent Server-Side Request Forgery (SSRF).
 * Resolves the hostname and blocks any resolution to private, loopback, or internal IP addresses.
 * Uses an in-memory TTL cache to eliminate redundant DNS lookups and avoid threadpool saturation.
 */
export const validateUrlAgainstSSRF = async (urlString: string): Promise<boolean> => {
  try {
    if (!urlString || typeof urlString !== 'string' || urlString.length > MAX_URL_LENGTH) {
      return false;
    }

    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    // Block obvious internal hosts early
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan') ||
      hostname === '169.254.169.254' ||
      hostname === 'metadata.google.internal'
    ) {
      return false;
    }

    // Disallow raw decimal, hex, or octal IP encodings (e.g., http://2130706433 or http://0x7f000001)
    if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
      return false;
    }

    // Only allow HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // Check cached resolution first and re-verify against private IP rules
    const cachedIp = dnsCache.get(hostname);
    if (cachedIp !== undefined) {
      return !isPrivateIP(cachedIp);
    }

    // Resolve the hostname to an IP address
    const { address } = await lookup(hostname);

    // Check if the resolved IP is an internal/private address
    if (isPrivateIP(address)) {
      return false;
    }

    dnsCache.set(hostname, address);
    return true;
  } catch {
    // If URL is invalid or DNS resolution fails, block the request
    return false;
  }
};

/**
 * Comprehensive check for IPv4 and IPv6 private, loopback, link-local,
 * carrier-grade NAT, cloud metadata, and reserved networks.
 */
export const isPrivateIP = (ip: string): boolean => {
  const cleanIp = ip.trim().toLowerCase();

  // Handle IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
  let normalizedIp = cleanIp;
  if (normalizedIp.startsWith('::ffff:')) {
    normalizedIp = normalizedIp.replace('::ffff:', '');
  }

  // IPv6 Unspecified (::), Loopback (::1), Link-local (fe80::/10), Unique-Local (fc00::/7), Multicast (ff00::/8)
  if (
    normalizedIp === '::' ||
    normalizedIp === '::1' ||
    normalizedIp.startsWith('fe80:') ||
    normalizedIp.startsWith('fe8') ||
    normalizedIp.startsWith('fe9') ||
    normalizedIp.startsWith('fea') ||
    normalizedIp.startsWith('feb') ||
    normalizedIp.startsWith('fc') ||
    normalizedIp.startsWith('fd') ||
    normalizedIp.startsWith('ff') ||
    normalizedIp.startsWith('64:ff9b:')
  ) {
    return true;
  }

  // If it is a valid IPv6 address that passed all private/reserved checks above, it is a safe public IP
  if (normalizedIp.includes(':')) {
    // Check documentation prefix 2001:db8::/32 and discard prefix 100::/64
    if (normalizedIp.startsWith('2001:db8') || normalizedIp.startsWith('100:')) {
      return true;
    }
    // Any remaining valid IPv6 format is a public global unicast IP (e.g. 2606:4700:..., 2a00:...)
    return false;
  }

  const parts = normalizedIp.split('.');
  if (parts.length !== 4) {
    // Any remaining non-IPv4 string that failed IPv6 checks above is treated as invalid/unsafe
    return true;
  }

  const [p1, p2, p3, p4] = parts.map(Number);
  if (
    isNaN(p1) || isNaN(p2) || isNaN(p3) || isNaN(p4) ||
    p1 < 0 || p1 > 255 ||
    p2 < 0 || p2 > 255 ||
    p3 < 0 || p3 > 255 ||
    p4 < 0 || p4 > 255
  ) {
    return true;
  }

  // 0.0.0.0/8 (Current network / "this" network)
  if (p1 === 0) return true;

  // 10.0.0.0/8 (Private network - RFC 1918)
  if (p1 === 10) return true;

  // 100.64.0.0/10 (Shared Address Space / CGNAT - RFC 6598)
  if (p1 === 100 && p2 >= 64 && p2 <= 127) return true;

  // 127.0.0.0/8 (Loopback)
  if (p1 === 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud Metadata - RFC 3927)
  if (p1 === 169 && p2 === 254) return true;

  // 172.16.0.0/12 (Private network - RFC 1918)
  if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (p1 === 192 && p2 === 0 && p3 === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1 documentation)
  if (p1 === 192 && p2 === 0 && p3 === 2) return true;

  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (p1 === 192 && p2 === 88 && p3 === 99) return true;

  // 192.168.0.0/16 (Private network - RFC 1918)
  if (p1 === 192 && p2 === 168) return true;

  // 198.18.0.0/15 (Benchmarking tests)
  if (p1 === 198 && (p2 === 18 || p2 === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2 documentation)
  if (p1 === 198 && p2 === 51 && p3 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 documentation)
  if (p1 === 203 && p2 === 0 && p3 === 113) return true;

  // 224.0.0.0/4 (Multicast - RFC 5771)
  if (p1 >= 224 && p1 <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use - RFC 1112)
  if (p1 >= 240) return true;

  return false;
};
