import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshSession = vi.fn();
vi.mock("@/lib/supabase/proxy-session", () => ({
  refreshSession: (...args: unknown[]) => refreshSession(...args),
}));

const { config, proxy } = await import("./proxy");

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);
const SESSION = "sb-127-auth-token=abc";

beforeEach(() => refreshSession.mockReset());

describe("proxy, without a session cookie", () => {
  it("sends staff pages to sign-in without contacting the Auth server", async () => {
    const response = await proxy(request("/staff"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/staff/login");
    expect(new URL(response.headers.get("location")!).search).toBe("");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("remembers where the visitor was going", async () => {
    const response = await proxy(request("/staff/orders?tab=ready"));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/staff/login");
    expect(location.searchParams.get("next")).toBe("/staff/orders?tab=ready");
  });

  it("lets the sign-in page and staff API through (the API answers 401 itself)", async () => {
    for (const path of ["/staff/login", "/api/staff/me"]) {
      const response = await proxy(request(path));
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.status, path).toBe(200);
    }
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("proxy, with a session cookie", () => {
  const passthrough = () => NextResponse.next();

  it("refreshes the session and lets a valid session through", async () => {
    const response = passthrough();
    refreshSession.mockResolvedValue({ response, signedIn: true, unknown: false });
    expect(await proxy(request("/staff", SESSION))).toBe(response);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("redirects a dead session to sign-in and keeps the cookie changes", async () => {
    const dead = passthrough();
    dead.cookies.set("sb-127-auth-token", "", { maxAge: 0 });
    refreshSession.mockResolvedValue({ response: dead, signedIn: false, unknown: false });

    const response = await proxy(request("/staff", SESSION));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/staff/login");
    expect(response.cookies.get("sb-127-auth-token")?.value).toBe("");
  });

  it("does not bounce staff pages when Auth is merely unreachable (the page fails closed itself)", async () => {
    const response = passthrough();
    refreshSession.mockResolvedValue({ response, signedIn: false, unknown: true });
    expect(await proxy(request("/staff", SESSION))).toBe(response);
  });

  it("refreshes for the sign-in page and APIs but never redirects them", async () => {
    for (const path of ["/staff/login", "/api/staff/me"]) {
      const response = passthrough();
      refreshSession.mockResolvedValue({ response, signedIn: false, unknown: false });
      expect(await proxy(request(path, SESSION)), path).toBe(response);
    }
  });
});

describe("proxy matcher", () => {
  it("covers exactly the staff pages and staff API, as static strings", () => {
    expect(config.matcher).toEqual(["/staff/:path*", "/api/staff/:path*"]);
  });
});
