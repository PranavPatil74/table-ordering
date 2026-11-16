import { describe, expect, it } from "vitest";

import {
  EnvValidationError,
  parsePublicEnv,
  parseServerEnv,
  requireRazorpay,
  resolveQrBaseUrl,
  type RawEnv,
} from "./schema";

// Obviously fake, test-only values. These are NOT credentials.
const FIXTURE_PUBLISHABLE_KEY = "test-fixture-publishable-key";
const FIXTURE_SERVICE_KEY = "test-fixture-service-role-key";

const validBase: RawEnv = {
  NEXT_PUBLIC_APP_URL: "https://orders.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FIXTURE_PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: FIXTURE_SERVICE_KEY,
};

const razorpayFixture: RawEnv = {
  RAZORPAY_KEY_ID: "rzp_test_FixtureKeyId01",
  RAZORPAY_KEY_SECRET: "test-fixture-razorpay-secret",
  RAZORPAY_WEBHOOK_SECRET: "test-fixture-webhook-secret",
};

/** Copy of `env` with one variable removed (i.e. genuinely unset, not blank). */
function withoutKey(env: RawEnv, key: string): RawEnv {
  const copy = { ...env };
  delete copy[key];
  return copy;
}

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error.problems;
    throw error;
  }
  throw new Error("Expected EnvValidationError but nothing was thrown");
}

describe("parseServerEnv", () => {
  it("accepts a complete valid configuration and reports payments as unconfigured", () => {
    const env = parseServerEnv(validBase, { nodeEnv: "production" });
    expect(env.appUrl).toBe("https://orders.example.com");
    expect(env.supabaseUrl).toBe("https://abcd1234.supabase.co");
    expect(env.supabaseServiceRoleKey).toBe(FIXTURE_SERVICE_KEY);
    expect(env.razorpay).toBeNull();
  });

  it("derives Razorpay test mode from the key id prefix", () => {
    const env = parseServerEnv({ ...validBase, ...razorpayFixture }, { nodeEnv: "production" });
    expect(env.razorpay).toEqual({
      mode: "test",
      keyId: "rzp_test_FixtureKeyId01",
      keySecret: "test-fixture-razorpay-secret",
      webhookSecret: "test-fixture-webhook-secret",
    });
  });

  it("derives Razorpay live mode from the key id prefix", () => {
    const env = parseServerEnv(
      { ...validBase, ...razorpayFixture, RAZORPAY_KEY_ID: "rzp_live_FixtureKeyId01" },
      { nodeEnv: "production" },
    );
    expect(env.razorpay?.mode).toBe("live");
  });

  it("treats blank Razorpay values (a copied .env.example) as unset", () => {
    const env = parseServerEnv(
      { ...validBase, RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "  ", RAZORPAY_WEBHOOK_SECRET: "" },
      { nodeEnv: "production" },
    );
    expect(env.razorpay).toBeNull();
  });

  it("rejects a half-configured Razorpay setup", () => {
    const problems = problemsOf(() =>
      parseServerEnv({ ...validBase, RAZORPAY_KEY_ID: "rzp_test_FixtureKeyId01" }),
    );
    expect(problems.join("\n")).toMatch(/Set all three or none/);
  });

  it("rejects a malformed Razorpay key id", () => {
    const problems = problemsOf(() =>
      parseServerEnv({ ...validBase, ...razorpayFixture, RAZORPAY_KEY_ID: "not-a-razorpay-key" }),
    );
    expect(problems.join("\n")).toMatch(/RAZORPAY_KEY_ID/);
  });

  it("lists every missing required variable by name", () => {
    const problems = problemsOf(() => parseServerEnv({}));
    const text = problems.join("\n");
    expect(text).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(text).toMatch(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
    expect(text).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("rejects the publishable key pasted into the service role slot", () => {
    const sameKey = problemsOf(() =>
      parseServerEnv({ ...validBase, SUPABASE_SERVICE_ROLE_KEY: FIXTURE_PUBLISHABLE_KEY }),
    );
    expect(sameKey.join("\n")).toMatch(/publishable\/anon key/);

    const prefixed = problemsOf(() =>
      parseServerEnv({ ...validBase, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123" }),
    );
    expect(prefixed.join("\n")).toMatch(/publishable\/anon key/);
  });

  it("never echoes secret values in error messages", () => {
    const secret = "super-secret-value-that-must-not-leak";
    let message = "";
    try {
      parseServerEnv({
        ...validBase,
        NEXT_PUBLIC_SUPABASE_URL: secret, // invalid URL carrying the "secret"
        RAZORPAY_KEY_ID: secret,
        RAZORPAY_KEY_SECRET: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
  });

  it("does not throw a TypeError on garbage URLs (reports a clean problem instead)", () => {
    const problems = problemsOf(() =>
      parseServerEnv({ ...validBase, NEXT_PUBLIC_SUPABASE_URL: "not a url at all" }),
    );
    expect(problems.join("\n")).toMatch(/NEXT_PUBLIC_SUPABASE_URL: Must be a valid URL/);
  });
});

describe("APP_URL rules", () => {
  it("defaults to localhost outside production", () => {
    expect(
      parseServerEnv(withoutKey(validBase, "NEXT_PUBLIC_APP_URL"), { nodeEnv: "development" })
        .appUrl,
    ).toBe("http://localhost:3000");
  });

  it("treats a blank NEXT_PUBLIC_APP_URL like an unset one", () => {
    const env = parseServerEnv(
      { ...validBase, NEXT_PUBLIC_APP_URL: "" },
      { nodeEnv: "development" },
    );
    expect(env.appUrl).toBe("http://localhost:3000");
  });

  it("is required in production", () => {
    expect(
      problemsOf(() =>
        parseServerEnv(withoutKey(validBase, "NEXT_PUBLIC_APP_URL"), { nodeEnv: "production" }),
      ).join("\n"),
    ).toMatch(/NEXT_PUBLIC_APP_URL: Required in production/);
  });

  it("requires https in production except for localhost", () => {
    expect(
      problemsOf(() =>
        parseServerEnv(
          { ...validBase, NEXT_PUBLIC_APP_URL: "http://cafe.example.com" },
          { nodeEnv: "production" },
        ),
      ).join("\n"),
    ).toMatch(/Must use https/);

    expect(
      parseServerEnv(
        { ...validBase, NEXT_PUBLIC_APP_URL: "http://localhost:3100" },
        { nodeEnv: "production" },
      ).appUrl,
    ).toBe("http://localhost:3100");
  });

  it("allows plain http for any host outside production", () => {
    const env = parseServerEnv(
      { ...validBase, NEXT_PUBLIC_APP_URL: "http://192.168.1.20:3000" },
      { nodeEnv: "development" },
    );
    expect(env.appUrl).toBe("http://192.168.1.20:3000");
  });

  it("normalises a trailing slash to a bare origin", () => {
    const env = parseServerEnv({
      ...validBase,
      NEXT_PUBLIC_APP_URL: "https://orders.example.com/",
    });
    expect(env.appUrl).toBe("https://orders.example.com");
  });

  it("rejects URLs with a path, query or fragment", () => {
    for (const bad of [
      "https://orders.example.com/app",
      "https://orders.example.com/?x=1",
      "https://orders.example.com/#frag",
    ]) {
      expect(
        problemsOf(() => parseServerEnv({ ...validBase, NEXT_PUBLIC_APP_URL: bad })).join("\n"),
      ).toMatch(/origin only/);
    }
  });

  it("rejects non-http protocols", () => {
    expect(
      problemsOf(() =>
        parseServerEnv({ ...validBase, NEXT_PUBLIC_APP_URL: "ftp://orders.example.com" }),
      ).join("\n"),
    ).toMatch(/http:\/\/ or https:\/\//);
  });
});

describe("production placeholder guard", () => {
  it("rejects values copied from .env.example when NODE_ENV=production", () => {
    const problems = problemsOf(() =>
      parseServerEnv(
        {
          ...validBase,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "your-supabase-publishable-key",
          SUPABASE_SERVICE_ROLE_KEY: "your-supabase-service-role-key",
        },
        { nodeEnv: "production" },
      ),
    );
    const text = problems.join("\n");
    expect(text).toMatch(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: Still set to a placeholder/);
    expect(text).toMatch(/SUPABASE_SERVICE_ROLE_KEY: Still set to a placeholder/);
  });

  it("allows the same placeholders in development", () => {
    expect(() =>
      parseServerEnv(
        {
          ...validBase,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "your-supabase-publishable-key",
          SUPABASE_SERVICE_ROLE_KEY: "your-supabase-service-role-key",
        },
        { nodeEnv: "development" },
      ),
    ).not.toThrow();
  });
});

describe("parsePublicEnv", () => {
  it("returns only browser-safe values", () => {
    const env = parsePublicEnv(validBase, { nodeEnv: "production" });
    expect(Object.keys(env).sort()).toEqual(["appUrl", "supabasePublishableKey", "supabaseUrl"]);
  });

  it("does not require or expose any server secret", () => {
    const env = parsePublicEnv(
      {
        NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FIXTURE_PUBLISHABLE_KEY,
        SUPABASE_SERVICE_ROLE_KEY: FIXTURE_SERVICE_KEY,
      },
      { nodeEnv: "development" },
    );
    expect(JSON.stringify(env)).not.toContain(FIXTURE_SERVICE_KEY);
  });

  it("reports missing public variables", () => {
    expect(problemsOf(() => parsePublicEnv({})).join("\n")).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("requireRazorpay", () => {
  it("returns the gateway settings when configured", () => {
    const env = parseServerEnv({ ...validBase, ...razorpayFixture });
    expect(requireRazorpay(env).keyId).toBe("rzp_test_FixtureKeyId01");
  });

  it("fails loudly when payments are not configured", () => {
    const env = parseServerEnv(validBase);
    expect(() => requireRazorpay(env)).toThrow(EnvValidationError);
    expect(() => requireRazorpay(env)).toThrow(/Payments are not configured/);
  });
});

describe("resolveQrBaseUrl (runtime QR origin)", () => {
  const dev = { nodeEnv: "development" };
  const prod = { nodeEnv: "production" };

  it("prefers APP_BASE_URL over a NEXT_PUBLIC_APP_URL that was frozen into the build", () => {
    expect(
      resolveQrBaseUrl(
        {
          APP_BASE_URL: "https://orders.example.com",
          NEXT_PUBLIC_APP_URL: "http://localhost:3100",
        },
        prod,
      ),
    ).toEqual({ origin: "https://orders.example.com", source: "APP_BASE_URL" });
  });

  it("falls back to NEXT_PUBLIC_APP_URL, then to the development default", () => {
    expect(resolveQrBaseUrl({ NEXT_PUBLIC_APP_URL: "https://cafe.example.com" }, prod)).toEqual({
      origin: "https://cafe.example.com",
      source: "NEXT_PUBLIC_APP_URL",
    });
    expect(resolveQrBaseUrl({}, dev)).toEqual({
      origin: "http://localhost:3000",
      source: "default",
    });
  });

  it("treats a blank APP_BASE_URL (a copied .env.example) as unset", () => {
    expect(
      resolveQrBaseUrl({ APP_BASE_URL: "", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, dev)
        .source,
    ).toBe("NEXT_PUBLIC_APP_URL");
  });

  it("normalises to an origin and rejects paths, bad schemes and garbage", () => {
    expect(resolveQrBaseUrl({ APP_BASE_URL: "https://orders.example.com/" }, prod).origin).toBe(
      "https://orders.example.com",
    );
    for (const bad of [
      "https://orders.example.com/menu",
      "ftp://orders.example.com",
      "not a url",
    ]) {
      expect(() => resolveQrBaseUrl({ APP_BASE_URL: bad }, dev), bad).toThrow(EnvValidationError);
    }
  });

  it("production requires a value, and http is only allowed for local addresses", () => {
    expect(() => resolveQrBaseUrl({}, prod)).toThrow(/APP_BASE_URL: Required in production/);
    expect(() => resolveQrBaseUrl({ APP_BASE_URL: "http://cafe.example.com" }, prod)).toThrow(
      /APP_BASE_URL: Must use https/,
    );
    expect(() =>
      resolveQrBaseUrl({ NEXT_PUBLIC_APP_URL: "http://cafe.example.com" }, prod),
    ).toThrow(/NEXT_PUBLIC_APP_URL: Must use https/);
    // A local address is accepted here; the QR export policy is what refuses to print it.
    expect(resolveQrBaseUrl({ APP_BASE_URL: "http://localhost:3100" }, prod).origin).toBe(
      "http://localhost:3100",
    );
  });

  it("parseServerEnv also validates APP_BASE_URL at startup, naming the variable but not its value", () => {
    const base = { ...validBase, APP_BASE_URL: "http://cafe.example.com" };
    const error = (() => {
      try {
        parseServerEnv(base, { nodeEnv: "production" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(/APP_BASE_URL: Must use https/);
    expect(error?.message).not.toContain("cafe.example.com");
  });
});
