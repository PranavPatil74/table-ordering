import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALL_ENV_KEYS,
  EnvValidationError,
  PUBLIC_ENV_KEYS,
  SERVER_ONLY_ENV_KEYS,
  parseServerEnv,
  type RawEnv,
} from "@/lib/env/schema";

const text = readFileSync(fileURLToPath(new URL("../../.env.example", import.meta.url)), "utf8");

/** Minimal dotenv parser: KEY=value lines, ignoring comments and blanks. */
function parseDotenv(source: string): RawEnv {
  const out: RawEnv = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const example = parseDotenv(text);

describe(".env.example", () => {
  it("documents every variable the schema reads", () => {
    for (const key of ALL_ENV_KEYS) {
      expect(Object.keys(example), `${key} missing from .env.example`).toContain(key);
    }
  });

  it("documents no variable the schema does not read", () => {
    expect(Object.keys(example).sort()).toEqual([...ALL_ENV_KEYS].sort());
  });

  it("is valid for local development as-is", () => {
    expect(() => parseServerEnv(example, { nodeEnv: "development" })).not.toThrow();
  });

  it("is rejected in production until real values are filled in", () => {
    expect(() => parseServerEnv(example, { nodeEnv: "production" })).toThrow(EnvValidationError);
  });

  it("leaves Razorpay blank so payments are reported as unconfigured, not faked", () => {
    expect(parseServerEnv(example, { nodeEnv: "development" }).razorpay).toBeNull();
  });
});

describe("secret hygiene", () => {
  it("never puts a secret-looking name under NEXT_PUBLIC_", () => {
    for (const key of PUBLIC_ENV_KEYS) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(true);
      expect(key).not.toMatch(/SECRET|SERVICE_ROLE|WEBHOOK|PRIVATE/i);
    }
  });

  it("keeps every secret out of the NEXT_PUBLIC_ namespace", () => {
    for (const key of SERVER_ONLY_ENV_KEYS) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("ships no real-looking credentials in .env.example", () => {
    const realLooking = [
      /rzp_(test|live)_[A-Za-z0-9]{8,}/, // Razorpay key ids
      /sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/, // Supabase new-style keys
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWTs (legacy anon / service_role keys)
    ];
    for (const pattern of realLooking) {
      expect(text).not.toMatch(pattern);
    }
  });
});
