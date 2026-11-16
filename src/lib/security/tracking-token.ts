import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Customer order-tracking tokens.
 *
 * A token is 128 bits from the operating system's CSPRNG, base64url-encoded (22 characters).
 * It is shown to the customer once (in the tracking URL) and NEVER stored: the database keeps
 * only its SHA-256 hash (`tracking_token_hash`, 32 bytes). Lookups hash the presented token
 * and compare hashes, so a database leak does not reveal working tracking links.
 *
 * SHA-256 (rather than a slow password hash) is appropriate because the input is already a
 * high-entropy random value, so there is nothing to brute-force.
 */
export const TRACKING_TOKEN_BYTES = 16;
export const TRACKING_TOKEN_LENGTH = 22;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function generateTrackingToken(): string {
  return randomBytes(TRACKING_TOKEN_BYTES).toString("base64url");
}

export function isWellFormedTrackingToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** SHA-256 of the token's UTF-8 bytes, as the 32-byte value stored in `tracking_token_hash`. */
export function hashTrackingToken(token: string): Buffer {
  if (!isWellFormedTrackingToken(token)) {
    throw new TypeError("Malformed tracking token");
  }
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * A tracking token that can be re-derived, for a checkout saved BEFORE payment.
 *
 * `payment_attempts.tracking_token_hash` is NOT NULL and immutable, so the token must be fixed at
 * the moment the attempt is saved, yet the customer only needs to see it after payment (Phase 7).
 * Deriving it as HMAC-SHA256(server secret, "tracking-token:v1:" + submission id) means:
 *   - it is never stored (only its SHA-256 hash is), so a database leak reveals no working links;
 *   - without the server secret it cannot be computed from the idempotency key that IS stored;
 *   - a retry of the same submission derives the same token and the same hash;
 *   - nothing has to be returned to, or remembered by, the browser in Phase 5.
 * The secret is the existing service-role key (the same precedent as the rate-limit fingerprint).
 */
export function deriveTrackingToken(secret: string, submissionId: string): string {
  if (!secret || !submissionId) throw new TypeError("A secret and a submission id are required");
  return createHmac("sha256", secret)
    .update(`tracking-token:v1:${submissionId}`)
    .digest()
    .subarray(0, TRACKING_TOKEN_BYTES)
    .toString("base64url");
}
