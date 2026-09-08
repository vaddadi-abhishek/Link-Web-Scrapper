import http from 'http';
import https from 'https';
import axios from 'axios';

/**
 * High-performance shared HTTP and HTTPS agents with TCP Keep-Alive.
 * Reuses TCP and TLS sessions across all outgoing HTTP requests, eliminating 50-150ms
 * handshake overhead on repeated platform queries (Facebook, Reddit, Instagram, YouTube, X).
 */
export const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
  keepAliveMsecs: 10000,
});

export const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
  keepAliveMsecs: 10000,
});

/**
 * Configures Axios defaults to use connection pooling globally.
 * Automatically inherited by any Axios request across extractors and controllers.
 */
export function initializeHttpClient(): void {
  axios.defaults.httpAgent = sharedHttpAgent;
  axios.defaults.httpsAgent = sharedHttpsAgent;
}
