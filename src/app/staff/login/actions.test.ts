import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffAccess } from "@/lib/auth/staff";

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const signInWithPassword = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));
const clearAuthCookies = vi.fn(async () => undefined);
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithPassword, signOut } }),
  clearAuthCookies: () => clearAuthCookies(),
}));
const loadStaffAccess = vi.fn<() => Promise<StaffAccess>>();
vi.mock("@/lib/auth/staff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/staff")>()),
  loadStaffAccess: () => loadStaffAccess(),
}));

const { signInAction } = await import("./actions");
const idle = { status: "idle" } as const;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const GOOD = { email: "Casey@Example.com", password: "a-long-test-password" };

beforeEach(() => {
  signInWithPassword.mockReset();
  signOut.mockClear();
  clearAuthCookies.mockClear();
  loadStaffAccess.mockReset();
});

describe("signInAction", () => {
  it("rejects bad input without ever contacting the Auth server", async () => {
    const state = await signInAction(idle, form({ email: "nope", password: "" }));
    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { email: expect.any(String), password: "Enter your password." },
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("signs in with the normalised email and redirects active staff to /staff", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    loadStaffAccess.mockResolvedValue({
      status: "authorized",
      staff: { userId: "u", displayName: "Casey", role: "counter" },
    });
    await expect(signInAction(idle, form(GOOD))).rejects.toMatchObject({ to: "/staff" });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "casey@example.com",
      password: GOOD.password,
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("honours a safe ?next= and ignores an unsafe one", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    loadStaffAccess.mockResolvedValue({
      status: "authorized",
      staff: { userId: "u", displayName: "C", role: "manager" },
    });
    await expect(
      signInAction(idle, form({ ...GOOD, next: "/staff/orders" })),
    ).rejects.toMatchObject({ to: "/staff/orders" });
    await expect(
      signInAction(idle, form({ ...GOOD, next: "https://evil.example" })),
    ).rejects.toMatchObject({ to: "/staff" });
  });

  it("wrong credentials: a generic message, the email echoed, the password never returned", async () => {
    signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials", status: 400, name: "AuthApiError" },
    });
    const state = await signInAction(idle, form(GOOD));
    expect(state).toMatchObject({ status: "error", email: "casey@example.com" });
    expect(state.message).toMatch(/don't match/);
    expect(JSON.stringify(state)).not.toContain(GOOD.password);
    expect(loadStaffAccess).not.toHaveBeenCalled();
  });

  it("maps rate limits and outages to their own messages", async () => {
    signInWithPassword.mockResolvedValue({
      error: { code: "over_request_rate_limit", status: 429 },
    });
    expect((await signInAction(idle, form(GOOD))).message).toMatch(/Too many/);
    signInWithPassword.mockResolvedValue({ error: { name: "AuthRetryableFetchError", status: 0 } });
    expect((await signInAction(idle, form(GOOD))).message).toMatch(/couldn't reach/);
  });

  it.each([
    [{ status: "denied", reason: "no_profile" }],
    [{ status: "denied", reason: "inactive" }],
    [{ status: "denied", reason: "invalid_role" }],
  ] as const)(
    "valid Auth user who is not active staff (%j): signed straight back out, cookies cleared",
    async (access) => {
      signInWithPassword.mockResolvedValue({ error: null });
      loadStaffAccess.mockResolvedValue(access);
      const state = await signInAction(idle, form(GOOD));
      expect(state.message).toMatch(/doesn't have staff access/);
      expect(signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(clearAuthCookies).toHaveBeenCalled();
    },
  );

  it("cannot verify staff status: signs out and reports an outage, never lets them in", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    loadStaffAccess.mockResolvedValue({ status: "unavailable" });
    const state = await signInAction(idle, form(GOOD));
    expect(state.message).toMatch(/couldn't reach/);
    expect(signOut).toHaveBeenCalled();
    expect(clearAuthCookies).toHaveBeenCalled();
  });

  it("logs failure kinds only: never the email, the password or the raw error", async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    signInWithPassword.mockResolvedValue({
      error: { name: "AuthRetryableFetchError", status: 0, message: `boom ${GOOD.password}` },
    });
    await signInAction(idle, form(GOOD));
    spy.mockRestore();
    const output = logged.join("\n");
    expect(output).toContain("unavailable");
    expect(output).not.toContain(GOOD.password);
    expect(output.toLowerCase()).not.toContain("casey@example.com");
  });
});
