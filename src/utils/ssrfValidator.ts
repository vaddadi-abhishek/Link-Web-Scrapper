import dns from 'dns';
import { promisify } from 'util';

const lookup = promisify(dns.lookup);

/**
 * Validates a URL to prevent Server-Side Request Forgery (SSRF)
 * Resolves the hostname and blocks any resolution to private, loopback, or internal IP addresses.
 */
export const validateUrlAgainstSSRF = async (urlString: string): Promise<boolean> => {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname;

    // Block obvious internal hosts early
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false;
    }
    
    // Only allow HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    // Resolve the hostname to an IP address
    const { address } = await lookup(hostname);

    // Check if the resolved IP is an internal/private address
    if (isPrivateIP(address)) {
      return false;
    }

    return true;
  } catch (error) {
    // If URL is invalid or DNS resolution fails, block the request
    return false;
  }
};

/**
 * Checks if an IP address belongs to a private/internal network
 */
const isPrivateIP = (ip: string): boolean => {
  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  }

  // IPv6 local/private blocks
  if (ip === '::1' || ip.match(/^(fc|fd|fe80)/i)) {
    return true;
  }

  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  
  const [p1, p2] = parts.map(Number);
  
  // 127.0.0.0/8 (Loopback)
  if (p1 === 127) return true;
  // 10.0.0.0/8 (Private)
  if (p1 === 10) return true;
  // 172.16.0.0/12 (Private)
  if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (p1 === 192 && p2 === 168) return true;
  // 169.254.0.0/16 (Link-local / Cloud Metadata instances like AWS)
  if (p1 === 169 && p2 === 254) return true;
  // 0.0.0.0/8 (Current network)
  if (p1 === 0) return true;
  
  return false;
};
