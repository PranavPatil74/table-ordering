import { describe, expect, it, vi } from "vitest";

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

const signOut = vi.fn();
const clearAuthCookies = vi.fn(async () => undefined);
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut } }),
  clearAuthCookies: () => clearAuthCookies(),
}));

const { signOutAction } = await import("./actions");

describe("signOutAction", () => {
  it("ends only this browser's session, clears cookies and returns to sign-in", async () => {
    signOut.mockResolvedValue({ error: null });
    await expect(signOutAction()).rejects.toMatchObject({ to: "/staff/login?signed-out=1" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearAuthCookies).toHaveBeenCalled();
  });

  it("still clears the cookies when the Auth server cannot be reached", async () => {
    clearAuthCookies.mockClear();
    signOut.mockRejectedValue(new Error("network down"));
    await expect(signOutAction()).rejects.toMatchObject({ to: "/staff/login?signed-out=1" });
    expect(clearAuthCookies).toHaveBeenCalled();
  });
});
