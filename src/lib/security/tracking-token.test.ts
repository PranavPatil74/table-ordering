import { describe, expect, it } from "vitest";

import {
  TRACKING_TOKEN_LENGTH,
  generateTrackingToken,
  hashTrackingToken,
  isWellFormedTrackingToken,
} from "./tracking-token";

describe("tracking tokens", () => {
  it("generates 22-character URL-safe tokens carrying 128 bits", () => {
    const token = generateTrackingToken();
    expect(token).toHaveLength(TRACKING_TOKEN_LENGTH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(16);
  });

  it("does not repeat (1,000 samples)", () => {
    const seen = new Set(Array.from({ length: 1000 }, generateTrackingToken));
    expect(seen.size).toBe(1000);
  });

  it("hashes to 32 bytes, deterministically", () => {
    const token = generateTrackingToken();
    const hash = hashTrackingToken(token);
    expect(hash).toHaveLength(32);
    expect(hashTrackingToken(token).equals(hash)).toBe(true);
  });

  it("matches an independently computed SHA-256 of a fixed token", () => {
    // Computed outside this codebase: printf 'AAAAAAAAAAAAAAAAAAAAAA' | openssl dgst -sha256
    expect(hashTrackingToken("A".repeat(22)).toString("hex")).toBe(
      "8a5bdb4cc15164126c6ef2668de9dd240d299ce6397a42c95a9411b93d080ed8",
    );
  });

  it("different tokens give different hashes", () => {
    expect(
      hashTrackingToken(generateTrackingToken()).equals(hashTrackingToken(generateTrackingToken())),
    ).toBe(false);
  });

  it("refuses to hash malformed input", () => {
    for (const bad of ["", "short", "A".repeat(23), "A".repeat(21) + "!", " " + "A".repeat(21)]) {
      expect(isWellFormedTrackingToken(bad)).toBe(false);
      expect(() => hashTrackingToken(bad)).toThrow(TypeError);
    }
    expect(isWellFormedTrackingToken(undefined)).toBe(false);
    expect(isWellFormedTrackingToken(42)).toBe(false);
  });
});
