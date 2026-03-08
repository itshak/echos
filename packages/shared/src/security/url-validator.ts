import { z } from 'zod';
import { ValidationError, SecurityError } from '../errors/index.js';

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local / AWS IMDS (169.254.169.254) / Azure IMDS (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT (RFC 6598) — 100.64.0.0/10
  /^0\./,
  /^fc/i,  // IPv6 ULA fc00::/7
  /^fd/i,  // IPv6 ULA fd00::/8
  /^fe80/i, // IPv6 link-local
  /^::1$/,  // IPv6 loopback
  /^::$/,   // IPv6 unspecified
  /^2130706433$/, // 127.0.0.1 as a decimal integer
];

/** Exact hostnames that are always blocked regardless of IP check. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  '169.254.169.254',  // AWS/Azure/GCP instance metadata service
  '168.63.129.16',    // Azure platform endpoint
  'instance-data',    // Alternative metadata hostname used by some cloud providers
]);

export function isPrivateIp(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }
  return PRIVATE_IP_RANGES.some((range) => range.test(hostname));
}

const urlSchema = z.string().url();

export function validateUrl(input: string): string {
  const parsed = urlSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid URL: ${input}`);
  }

  const url = new URL(parsed.data);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SecurityError(`Blocked protocol: ${url.protocol}`);
  }

  if (isPrivateIp(url.hostname)) {
    throw new SecurityError('URL points to private/internal network');
  }

  return parsed.data;
}
