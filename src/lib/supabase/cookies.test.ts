import { describe, expect, it } from "vitest";

import { authCookieOptions, hasSupabaseAuthCookie, isSupabaseAuthCookie } from "./cookies";

describe("authCookieOptions", () => {
  it("is always HttpOnly, SameSite=Lax and site-wide", () => {
    for (const url of ["https://orders.example.com", "http://localhost:3000"]) {
      expect(authCookieOptions(url)).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    }
  });

  it("is Secure exactly when the public origin is https", () => {
    expect(authCookieOptions("https://orders.example.com").secure).toBe(true);
    expect(authCookieOptions("http://localhost:3000").secure).toBe(false);
    expect(authCookieOptions("not a url").secure).toBe(false);
  });
});

describe("isSupabaseAuthCookie", () => {
  it.each([
    "sb-127-auth-token",
    "sb-abcdefghijklmnopqrst-auth-token",
    "sb-abc-auth-token.0",
    "sb-abc-auth-token.12",
    "sb-abc-auth-token-code-verifier",
  ])("recognises %s", (name) => expect(isSupabaseAuthCookie(name)).toBe(true));

  it.each(["session", "sb-abc", "sb-abc-auth-token.x", "xsb-abc-auth-token", "theme", ""])(
    "ignores %s",
    (name) => expect(isSupabaseAuthCookie(name)).toBe(false),
  );

  it("hasSupabaseAuthCookie looks through a list", () => {
    expect(hasSupabaseAuthCookie([{ name: "theme" }, { name: "sb-x-auth-token.0" }])).toBe(true);
    expect(hasSupabaseAuthCookie([{ name: "theme" }])).toBe(false);
    expect(hasSupabaseAuthCookie([])).toBe(false);
  });
});
