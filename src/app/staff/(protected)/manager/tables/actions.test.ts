import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const requireStaffAction = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireStaffAction: (...args: unknown[]) => requireStaffAction(...args),
}));

const createTable = vi.fn();
const renameTable = vi.fn();
const setTableActive = vi.fn();
vi.mock("@/lib/tables/repository", () => ({ createTable, renameTable, setTableActive }));

const { createTableAction, renameTableAction, setTableActiveAction } = await import("./actions");

const ID = "11111111-1111-4111-8111-111111111111";
const SUPABASE = { marker: "client" };
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};
const asManager = () =>
  requireStaffAction.mockResolvedValue({
    ok: true,
    staff: { role: "manager" },
    supabase: SUPABASE,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const all: [string, () => Promise<unknown>][] = [
  ["createTableAction", () => createTableAction(null, form({ code: "T06", label: "Table 6" }))],
  ["renameTableAction", () => renameTableAction(null, form({ id: ID, label: "Window" }))],
  ["setTableActiveAction", () => setTableActiveAction(ID, false)],
];
const calls = () =>
  createTable.mock.calls.length + renameTable.mock.calls.length + setTableActive.mock.calls.length;

describe("table actions refuse non-managers", () => {
  it.each(all)("%s: signed-out", async (_n, run) => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "Your session has expired. Sign in again to continue.",
    });
    expect(await run()).toMatchObject({ ok: false });
    expect(calls()).toBe(0);
  });
  it.each(all)("%s: counter", async (_n, run) => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(await run()).toMatchObject({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(calls()).toBe(0);
  });
  it.each(all)("%s: requires manager", async (_n, run) => {
    asManager();
    createTable.mockResolvedValue({ ok: true, data: { id: ID } });
    renameTable.mockResolvedValue({ ok: true, data: { id: ID } });
    setTableActive.mockResolvedValue({ ok: true, data: { id: ID } });
    await run();
    expect(requireStaffAction).toHaveBeenCalledWith("manager");
  });
});

describe("table actions", () => {
  beforeEach(asManager);

  it("creates a table with a normalised code and reports it", async () => {
    createTable.mockResolvedValue({ ok: true, data: { id: ID } });
    expect(
      await createTableAction(null, form({ code: " t06 ", label: "  Table   6 " })),
    ).toMatchObject({ ok: true, message: "Added table T06." });
    expect(createTable).toHaveBeenCalledWith(SUPABASE, { code: "T06", label: "Table 6" });
  });

  it.each([
    ["lowercase-only junk", { code: "t 6!", label: "x" }],
    ["a code that is too short", { code: "T", label: "x" }],
    ["a code starting with a digit", { code: "6T", label: "x" }],
    ["a code that is too long", { code: "A".repeat(17), label: "x" }],
    ["an empty label", { code: "T06", label: " " }],
    ["a label over 40 chars", { code: "T06", label: "y".repeat(41) }],
    ["a code that smuggles a query string", { code: "T06&admin=1", label: "x" }],
  ])("rejects %s", async (_l, fields) => {
    expect(await createTableAction(null, form(fields))).toMatchObject({ ok: false });
    expect(createTable).not.toHaveBeenCalled();
  });

  it("explains a duplicate code from the database", async () => {
    createTable.mockResolvedValue({
      ok: false,
      message: "A table with this code already exists.",
      kind: "duplicate",
      field: "code",
    });
    const result = await createTableAction(null, form({ code: "T06", label: "Table 6" }));
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { code: "A table with this code already exists." },
    });
  });

  it("renames, never touching the code", async () => {
    renameTable.mockResolvedValue({ ok: true, data: { id: ID } });
    await renameTableAction(null, form({ id: ID, label: "Window seat", code: "HACK" }));
    expect(renameTable).toHaveBeenCalledWith(SUPABASE, ID, { label: "Window seat" });
  });

  it("rejects a malformed id", async () => {
    expect(await renameTableAction(null, form({ id: "x", label: "ok" }))).toMatchObject({
      ok: false,
    });
    expect(await setTableActiveAction("x", true)).toMatchObject({ ok: false });
    expect(renameTable).not.toHaveBeenCalled();
    expect(setTableActive).not.toHaveBeenCalled();
  });

  it("deactivates and reactivates with clear messages", async () => {
    setTableActive.mockResolvedValue({ ok: true, data: { id: ID } });
    expect(await setTableActiveAction(ID, false)).toMatchObject({
      ok: true,
      message: expect.stringContaining("no longer takes orders"),
    });
    expect(await setTableActiveAction(ID, true)).toMatchObject({
      ok: true,
      message: expect.stringContaining("works again"),
    });
  });

  it("hides internals when something unexpected is thrown", async () => {
    setTableActive.mockRejectedValue(new Error("secret internal detail"));
    const result = await setTableActiveAction(ID, false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
