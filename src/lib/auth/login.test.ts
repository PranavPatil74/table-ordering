import { describe, expect, it } from "vitest";

import { classifySignInError, safeStaffPath, SIGN_IN_MESSAGES, validateLogin } from "./login";

describe("validateLogin", () => {
  it("accepts a valid pair and normalises the email (trim, lower-case) but not the password", () => {
    expect(validateLogin({ email: "  Casey@Example.COM ", password: " pass word " })).toEqual({
      ok: true,
      data: { email: "casey@example.com", password: " pass word " },
    });
  });

  it("explains an empty form field by field", () => {
    const result = validateLogin({ email: "", password: "" });
    expect(result).toEqual({
      ok: false,
      fieldErrors: { email: "Enter your email address.", password: "Enter your password." },
    });
  });

  it("rejects malformed emails", () => {
    for (const email of ["nope", "a@", "@b.com", "a b@c.com", "a@b"]) {
      const result = validateLogin({ email, password: "x" });
      expect(result.ok, email).toBe(false);
    }
  });

  it("does not impose a minimum password length (the Auth server owns that policy)", () => {
    expect(validateLogin({ email: "a@b.co", password: "x" }).ok).toBe(true);
  });

  it("rejects absurdly long passwords and non-string input", () => {
    expect(validateLogin({ email: "a@b.co", password: "x".repeat(1025) }).ok).toBe(false);
    expect(validateLogin({ email: null, password: undefined }).ok).toBe(false);
    expect(validateLogin({ email: ["a@b.co"], password: 5 }).ok).toBe(false);
  });
});

describe("classifySignInError", () => {
  it.each([
    [{ code: "invalid_credentials", status: 400 }, "invalid_credentials"],
    [{ code: "invalid_login_credentials", status: 400 }, "invalid_credentials"],
    [{ status: 400 }, "invalid_credentials"],
    [{ code: "over_request_rate_limit", status: 429 }, "rate_limited"],
    [{ status: 429 }, "rate_limited"],
    [{ code: "email_not_confirmed", status: 400 }, "not_allowed"],
    [{ code: "user_banned", status: 400 }, "not_allowed"],
    [{ name: "AuthRetryableFetchError", status: 0 }, "unavailable"],
    [{ status: 503 }, "unavailable"],
    [{ status: 500, code: "unexpected_failure" }, "unavailable"],
    [{ code: "something_new", status: 418 }, "unknown"],
    [{}, "unknown"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(classifySignInError(error)).toBe(expected);
  });

  it("uses wording that never says whether an account exists", () => {
    const text = Object.values(SIGN_IN_MESSAGES).join(" ").toLowerCase();
    for (const leak of [
      "no account",
      "not found",
      "does not exist",
      "unknown user",
      "wrong password",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});

describe("safeStaffPath", () => {
  it.each([
    ["/staff", "/staff"],
    ["/staff/orders", "/staff/orders"],
    ["/staff/orders?tab=ready", "/staff/orders?tab=ready"],
    [undefined, "/staff"],
    [null, "/staff"],
    ["", "/staff"],
    [42, "/staff"],
    // leaving the staff area
    ["/", "/staff"],
    ["/admin", "/staff"],
    ["/staffer", "/staff"],
    ["/api/staff/me", "/staff"],
    // other sites and tricks
    ["https://evil.example/staff", "/staff"],
    ["//evil.example", "/staff"],
    ["//evil.example/staff", "/staff"],
    ["/\\evil.example", "/staff"],
    ["\\\\evil.example", "/staff"],
    ["/staff\\..\\..\\evil", "/staff"],
    ["javascript:alert(1)", "/staff"],
    ["/staff\n/evil", "/staff"],
    ["/staff\u0000", "/staff"],
    // never loop back to the sign-in page
    ["/staff/login", "/staff"],
    ["/staff/login?next=/staff", "/staff"],
  ])("%j -> %s", (input, expected) => {
    expect(safeStaffPath(input)).toBe(expected);
  });
});
