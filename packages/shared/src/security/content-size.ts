import { ValidationError } from '../errors/index.js';

/**
 * Default thresholds for content size validation.
 *
 * These limits are intentionally generous for a personal knowledge-management
 * system while still protecting against accidental (or malicious) oversized
 * payloads reaching the AI or the storage layer.
 */
export const CONTENT_SIZE_DEFAULTS = {
  /** Maximum number of UTF-16 code units (≈ characters) in a text payload. */
  maxChars: 500_000,
  /** Maximum byte length for binary or string buffers. */
  maxBytes: 10 * 1024 * 1024, // 10 MiB
} as const;

export interface ContentSizeOptions {
  /** Maximum characters allowed (default: 500 000). */
  maxChars?: number;
  /** Label used in error messages (e.g. "note content", "article HTML"). */
  label?: string;
}

/**
 * Validate that a string does not exceed the allowed character limit.
 *
 * Throws a {@link ValidationError} if the limit is exceeded so callers can
 * propagate a 400 response without leaking internal details.
 *
 * @param content - The string to validate.
 * @param options - Optional overrides and labelling.
 * @returns The original string, unchanged, if valid.
 */
export function validateContentSize(
  content: string,
  options: ContentSizeOptions = {},
): string {
  const { maxChars = CONTENT_SIZE_DEFAULTS.maxChars, label = 'content' } = options;

  if (content.length > maxChars) {
    throw new ValidationError(
      `${label} exceeds maximum allowed size (${content.length.toLocaleString()} characters; limit is ${maxChars.toLocaleString()})`,
    );
  }

  return content;
}

/**
 * Validate that a `Buffer` or `Uint8Array` does not exceed the allowed byte
 * limit.
 *
 * @param buffer - The binary buffer to validate.
 * @param options - Optional overrides and labelling.
 * @returns The original buffer, unchanged, if valid.
 */
export function validateBufferSize(
  buffer: Buffer | Uint8Array,
  options: { maxBytes?: number; label?: string } = {},
): Buffer | Uint8Array {
  const { maxBytes = CONTENT_SIZE_DEFAULTS.maxBytes, label = 'buffer' } = options;

  if (buffer.byteLength > maxBytes) {
    throw new ValidationError(
      `${label} exceeds maximum allowed size (${buffer.byteLength.toLocaleString()} bytes; limit is ${maxBytes.toLocaleString()})`,
    );
  }

  return buffer;
}
