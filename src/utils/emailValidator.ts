import axios from 'axios';
import disposableDomains from 'disposable-email-domains';
import wildcards from 'disposable-email-domains/wildcard.json';
import { logger } from './logger';

// Baseline offline set for instantaneous 0ms local screening
const offlineDisposableSet = new Set<string>(disposableDomains.map((d: string) => d.toLowerCase()));
const wildcardList: string[] = (wildcards as string[]).map((w: string) => w.toLowerCase());

// RFC 5322 compliant regex for safe web email validation
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export interface EmailValidationResult {
  isValid: boolean;
  isDisposable: boolean;
  error?: string;
  normalizedEmail: string;
  domain: string;
}

/**
 * Checks a live real-time threat intelligence API (no API key / account required).
 * Catches newly registered, actively rotating burner domains dynamically.
 */
async function checkLiveDisposableApi(email: string): Promise<boolean> {
  try {
    const url = `https://disposable.debounce.io/?email=${encodeURIComponent(email)}`;
    const response = await axios.get<{ disposable?: string | boolean }>(url, {
      timeout: 2500,
      headers: {
        'User-Agent': 'mindspace-email-validator/1.0',
      },
    });

    if (response.data && (response.data.disposable === 'true' || response.data.disposable === true)) {
      return true;
    }
    return false;
  } catch (err: unknown) {
    // Graceful fallback: If external API times out or is unreachable, log warning and do not block legitimate users
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('EmailValidator', `Live disposable check skipped or timed out: ${message}`);
    return false;
  }
}

/**
 * Comprehensive email validation.
 * 1. Checks RFC 5321 length and syntax rules.
 * 2. Checks offline base disposable set.
 * 3. Calls real-time live threat intelligence API (no API key required) to detect newly created burner domains.
 */
export async function validateEmail(rawEmail: unknown): Promise<EmailValidationResult> {
  if (!rawEmail || typeof rawEmail !== 'string') {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Email address is required.',
      normalizedEmail: '',
      domain: '',
    };
  }

  const normalizedEmail = rawEmail.trim().toLowerCase();

  // RFC 5321 length limits: Total <= 254 chars
  if (normalizedEmail.length > 254) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Email address exceeds maximum length of 254 characters.',
      normalizedEmail,
      domain: '',
    };
  }

  const atIndex = normalizedEmail.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === normalizedEmail.length - 1) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Please enter a valid email address.',
      normalizedEmail,
      domain: '',
    };
  }

  const localPart = normalizedEmail.substring(0, atIndex);
  const domain = normalizedEmail.substring(atIndex + 1);

  // Local part maximum length: 64 characters (RFC 5321)
  if (localPart.length > 64) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Email local part cannot exceed 64 characters.',
      normalizedEmail,
      domain,
    };
  }

  // Syntax format validation
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Please enter a valid email address format.',
      normalizedEmail,
      domain,
    };
  }

  // Domain structure validation
  if (!domain.includes('.')) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Email domain must contain a valid top-level domain.',
      normalizedEmail,
      domain,
    };
  }

  const tld = domain.substring(domain.lastIndexOf('.') + 1);
  if (tld.length < 2 || !/^[a-z]+$/.test(tld)) {
    return {
      isValid: false,
      isDisposable: false,
      error: 'Email contains an invalid top-level domain.',
      normalizedEmail,
      domain,
    };
  }

  // Check 1: Fast offline base lookup
  if (offlineDisposableSet.has(domain)) {
    return {
      isValid: false,
      isDisposable: true,
      error: 'Please enter a valid email address.',
      normalizedEmail,
      domain,
    };
  }

  // Check 2: Wildcard patterns
  const isWildcardMatch = wildcardList.some((wc) => domain === wc || domain.endsWith('.' + wc));
  if (isWildcardMatch) {
    return {
      isValid: false,
      isDisposable: true,
      error: 'Please enter a valid email address.',
      normalizedEmail,
      domain,
    };
  }

  // Check 3: Live real-time validator API (Catches newly rotated burner domains dynamically without hardcoding)
  const isLiveDisposable = await checkLiveDisposableApi(normalizedEmail);
  if (isLiveDisposable) {
    return {
      isValid: false,
      isDisposable: true,
      error: 'Please enter a valid email address.',
      normalizedEmail,
      domain,
    };
  }

  return {
    isValid: true,
    isDisposable: false,
    normalizedEmail,
    domain,
  };
}
