import http from 'http';
import https from 'https';
import axios from 'axios';

import dns from 'dns';
import { isPrivateIP } from './ssrfValidator';

/**
 * Socket-level DNS lookup validation.
 * Intercepts DNS resolution directly before TCP connection creation,
 * protecting all Axios requests (including redirects and DNS rebinding) from hitting private/cloud metadata IPs.
 */
const ssrfSafeLookup = (
  hostname: string,
  options: any,
  callback: (err: Error | null, address?: any, family?: any) => void
): void => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      return callback(err);
    }

    if (Array.isArray(address)) {
      for (const item of address) {
        if (item?.address && isPrivateIP(item.address)) {
          return callback(new Error(`SSRF blocked: ${hostname} resolved to private/internal IP ${item.address}`));
        }
      }
      return callback(null, address, family);
    }

    if (typeof address === 'string' && isPrivateIP(address)) {
      return callback(new Error(`SSRF blocked: ${hostname} resolved to private/internal IP ${address}`));
    }

    callback(null, address, family);
  });
};

/**
 * High-performance shared HTTP and HTTPS agents with TCP Keep-Alive and socket-level SSRF guards.
 * Reuses TCP and TLS sessions across all outgoing HTTP requests, eliminating 50-150ms
 * handshake overhead on repeated platform queries (Facebook, Reddit, Instagram, YouTube, X).
 */
export const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
  keepAliveMsecs: 10000,
  lookup: ssrfSafeLookup as any,
});

export const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
  keepAliveMsecs: 10000,
  lookup: ssrfSafeLookup as any,
});

/**
 * Configures Axios defaults to use connection pooling globally.
 * Automatically inherited by any Axios request across extractors and controllers.
 */
export function initializeHttpClient(): void {
  axios.defaults.httpAgent = sharedHttpAgent;
  axios.defaults.httpsAgent = sharedHttpsAgent;
}
