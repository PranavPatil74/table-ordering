import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffAccess } from "./staff";

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => ({})) }));
const loadStaffAccess = vi.fn<() => Promise<StaffAccess>>();
vi.mock("./staff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./staff")>()),
  loadStaffAccess: () => loadStaffAccess(),
}));

const { requireStaffAction, requireStaffApi, requireStaffPage, StaffAuthUnavailableError } =
  await import("./session");

const staff = (role: "counter" | "manager"): StaffAccess => ({
  status: "authorized",
  staff: { userId: "u1", displayName: "Pat", role },
});

beforeEach(() => loadStaffAccess.mockReset());

describe("requireStaffPage", () => {
  it("returns the verified staff member for an active counter or manager", async () => {
    loadStaffAccess.mockResolvedValue(staff("counter"));
    await expect(requireStaffPage()).resolves.toMatchObject({ role: "counter" });
    loadStaffAccess.mockResolvedValue(staff("manager"));
    await expect(requireStaffPage()).resolves.toMatchObject({ role: "manager" });
  });

  it.each([
    [{ status: "unauthenticated" }],
    [{ status: "denied", reason: "no_profile" }],
    [{ status: "denied", reason: "inactive" }],
    [{ status: "denied", reason: "invalid_role" }],
  ] as const)("sends %j to the sign-in page", async (access) => {
    loadStaffAccess.mockResolvedValue(access);
    await expect(requireStaffPage()).rejects.toMatchObject({ to: "/staff/login" });
  });

  it("fails closed with an error (never a page) when access cannot be verified", async () => {
    loadStaffAccess.mockResolvedValue({ status: "unavailable" });
    await expect(requireStaffPage()).rejects.toBeInstanceOf(StaffAuthUnavailableError);
  });

  it("a counter asking for manager-only access gets a 404; a manager gets in", async () => {
    loadStaffAccess.mockResolvedValue(staff("counter"));
    await expect(requireStaffPage("manager")).rejects.toBeInstanceOf(NotFound);
    loadStaffAccess.mockResolvedValue(staff("manager"));
    await expect(requireStaffPage("manager")).resolves.toMatchObject({ role: "manager" });
  });

  it("an inactive manager never reaches manager-only pages", async () => {
    loadStaffAccess.mockResolvedValue({ status: "denied", reason: "inactive" });
    await expect(requireStaffPage("manager")).rejects.toBeInstanceOf(Redirected);
  });
});

describe("requireStaffApi", () => {
  const read = async (access: StaffAccess, minimum?: "counter" | "manager") => {
    loadStaffAccess.mockResolvedValue(access);
    const guard = await requireStaffApi(minimum);
    if (guard.ok) return { ok: true as const, staff: guard.staff };
    return {
      ok: false as const,
      status: guard.response.status,
      body: await guard.response.json(),
      cache: guard.response.headers.get("cache-control"),
    };
  };

  it("lets active staff through with their verified identity", async () => {
    expect(await read(staff("counter"))).toEqual({
      ok: true,
      staff: { userId: "u1", displayName: "Pat", role: "counter" },
    });
  });

  it("401 for nobody, 403 for non-staff and inactive staff, 503 when it cannot tell", async () => {
    expect(await read({ status: "unauthenticated" })).toMatchObject({ status: 401 });
    expect(await read({ status: "denied", reason: "no_profile" })).toMatchObject({ status: 403 });
    expect(await read({ status: "denied", reason: "inactive" })).toMatchObject({ status: 403 });
    expect(await read({ status: "unavailable" })).toMatchObject({ status: 503 });
  });

  it("403 for a counter on a manager-only endpoint; a manager passes", async () => {
    expect(await read(staff("counter"), "manager")).toMatchObject({ status: 403 });
    expect(await read(staff("manager"), "manager")).toMatchObject({ ok: true });
  });

  it("never reveals WHY a signed-in user was refused, and is never cached", async () => {
    const reasons = ["no_profile", "inactive", "invalid_role"] as const;
    const bodies = await Promise.all(reasons.map((reason) => read({ status: "denied", reason })));
    for (const body of bodies) {
      expect(body).toMatchObject({ body: { error: "forbidden" }, cache: "private, no-store" });
    }
  });
});

describe("requireStaffAction (Server Actions)", () => {
  it("lets an active manager through and hands back their own client", async () => {
    loadStaffAccess.mockResolvedValue(staff("manager"));
    const guard = await requireStaffAction("manager");
    expect(guard).toMatchObject({ ok: true, staff: { role: "manager" } });
  });

  it("refuses a counter for a manager action, without a redirect or throw", async () => {
    loadStaffAccess.mockResolvedValue(staff("counter"));
    await expect(requireStaffAction("manager")).resolves.toEqual({
      ok: false,
      message: "You don't have permission to do that.",
    });
  });

  it("still lets a counter through a counter-level action", async () => {
    loadStaffAccess.mockResolvedValue(staff("counter"));
    await expect(requireStaffAction("counter")).resolves.toMatchObject({ ok: true });
  });

  it.each([
    [{ status: "denied", reason: "inactive" }],
    [{ status: "denied", reason: "no_profile" }],
    [{ status: "denied", reason: "invalid_role" }],
  ] as const)("refuses %j", async (access) => {
    loadStaffAccess.mockResolvedValue(access);
    await expect(requireStaffAction("manager")).resolves.toMatchObject({ ok: false });
  });

  it("tells a signed-out caller to sign in again", async () => {
    loadStaffAccess.mockResolvedValue({ status: "unauthenticated" });
    await expect(requireStaffAction("manager")).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("Sign in again"),
    });
  });

  it("fails closed when access cannot be verified", async () => {
    loadStaffAccess.mockResolvedValue({ status: "unavailable" });
    const guard = await requireStaffAction("manager");
    expect(guard).toMatchObject({ ok: false });
    expect((guard as { message: string }).message).toMatch(/Nothing was changed/);
  });
});
