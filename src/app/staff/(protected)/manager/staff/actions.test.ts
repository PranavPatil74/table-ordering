import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireStaffAction = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireStaffAction: (...args: unknown[]) => requireStaffAction(...args),
}));

const setStaffActive = vi.fn();
vi.mock("@/lib/staff/repository", () => ({ setStaffActive }));

const { setStaffActiveAction } = await import("./actions");
const { revalidatePath } = await import("next/cache");

const ME = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SUPABASE = { marker: "client" };
const asManager = () =>
  requireStaffAction.mockResolvedValue({
    ok: true,
    staff: { userId: ME, role: "manager", displayName: "Me" },
    supabase: SUPABASE,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("setStaffActiveAction", () => {
  it("refuses signed-out callers without touching the repository", async () => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "Your session has expired. Sign in again to continue.",
    });
    expect(await setStaffActiveAction(TARGET, false)).toMatchObject({ ok: false });
    expect(setStaffActive).not.toHaveBeenCalled();
  });
  it("refuses counter staff and inactive staff (the guard says no)", async () => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(await setStaffActiveAction(TARGET, false)).toEqual({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(setStaffActive).not.toHaveBeenCalled();
  });
  it("requires the manager role", async () => {
    asManager();
    setStaffActive.mockResolvedValue({ ok: true, message: "done" });
    await setStaffActiveAction(TARGET, true);
    expect(requireStaffAction).toHaveBeenCalledWith("manager");
  });
  it("takes the ACTOR from the verified session, never from the arguments", async () => {
    asManager();
    setStaffActive.mockResolvedValue({ ok: true, message: "Tara is deactivated." });
    expect(await setStaffActiveAction(TARGET, false)).toEqual({
      ok: true,
      message: "Tara is deactivated.",
    });
    expect(setStaffActive).toHaveBeenCalledWith(SUPABASE, ME, TARGET, false);
    expect(revalidatePath).toHaveBeenCalled();
  });
  it.each([
    ["not a uuid", "nope", false],
    ["empty", "", true],
    ["sql-ish", "1; drop table staff_profiles", false],
  ])("rejects an invalid target (%s) before any authorisation work", async (_n, id, active) => {
    asManager();
    expect(await setStaffActiveAction(id, active)).toMatchObject({
      ok: false,
      message: "That request is not valid.",
    });
    expect(setStaffActive).not.toHaveBeenCalled();
  });
  it("rejects a non-boolean 'active' (a forged argument)", async () => {
    asManager();
    expect(await setStaffActiveAction(TARGET, "manager" as unknown as boolean)).toMatchObject({
      ok: false,
    });
    expect(setStaffActive).not.toHaveBeenCalled();
  });
  it("passes repository refusals through as plain failures and does not revalidate", async () => {
    asManager();
    setStaffActive.mockResolvedValue({
      ok: false,
      kind: "last_manager",
      message: "You can't deactivate the last active manager.",
    });
    expect(await setStaffActiveAction(TARGET, false)).toEqual({
      ok: false,
      message: "You can't deactivate the last active manager.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("never leaks an unexpected error", async () => {
    asManager();
    setStaffActive.mockRejectedValue(new Error("connection string postgres://secret"));
    const result = await setStaffActiveAction(TARGET, false);
    expect(result).toEqual({
      ok: false,
      message: "Something went wrong. Nothing was saved. Try again.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
