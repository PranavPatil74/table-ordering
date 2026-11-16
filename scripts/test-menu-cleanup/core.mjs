// @ts-check
/**
 * Planning, safety rules and execution for removing leftover `pnpm test:supabase` menu fixtures
 * from a LOCAL development database. Plain ESM so the command-line tool and the tests share it.
 * Types: core.d.mts.
 *
 * WHAT IS A "TEST FIXTURE" HERE
 * `src/supabase-it/harness.ts` (createWorld) creates, per test run with a random 6-hex tag:
 *   category  slug `it-<tag>-cat`,  name `IT <tag> Category`
 *   items     `it-<tag>-sandwich` Grilled Sandwich 14900, `it-<tag>-coffee` Cold Coffee 11900,
 *             `it-<tag>-archived` Archived item 100, `it-<tag>-soldout` Sold out item 100
 *   table     code `IT<TAG>`, label `IT table <tag>`;  modifier group `it-<tag>-extras`
 * and then places paid orders for the two real items, which makes the items undeletable by design
 * (order_items.menu_item_id is ON DELETE RESTRICT) so the test cleanup leaves them behind.
 *
 * A category is only ever touched when ALL of these hold; a name or prefix alone is never enough:
 *   1. slug and name are the exact fixture pair for the same tag;
 *   2. every item in it is one of the four fixture items for that tag (slug, name and price all
 *      equal), so anything a person added to the category protects the whole category;
 *   3. at least one of the run's own other artefacts exists (its test table or modifier group) and
 *      was created within minutes of the category.
 *
 * TEST TABLES. A table is a fixture only when its code is `IT<TAG>` (TAG = the run's 6 hex digits,
 * upper case), its label is exactly `IT table <tag>` (lower case) with the SAME tag, and the same
 * run's category `IT <tag> Category` or modifier group `it-<tag>-extras` exists and was created
 * within minutes of it. A matching label with another code (the manager test's `Z<TAG>`), a matching
 * code with another label, or a table with no same-run evidence is reported and left alone.
 *
 * WHAT IT DOES: archives (is_active = false) the items and then the category, and deactivates
 * (is_active = false) the tables: the app's own "Archive"/"Deactivate" actions. A table that an
 * unpaid checkout (PENDING payment attempt) references is skipped and reported. It deletes an item
 * or category ONLY with `deleteUnreferenced`, and only when nothing references it; tables are never
 * deleted (the app has no table delete either). It never writes to orders, order_items,
 * payment_attempts, order_events or any other history table.
 */
import { createHash } from "node:crypto";

export const TAG_PATTERN = /^[0-9a-f]{6}$/;
const CATEGORY_SLUG = /^it-([0-9a-f]{6})-cat$/;
const TABLE_CODE = /^IT([0-9A-F]{6})$/;
const TABLE_LABEL = /^IT table ([0-9a-f]{6})$/;
/** How close in time the run's table/group must have been created to the category. */
const CORROBORATION_WINDOW_MS = 10 * 60_000;

/** The items createWorld() inserts, for one run tag. */
export function fixtureItems(tag) {
  return [
    { slug: `it-${tag}-sandwich`, name: "Grilled Sandwich", pricePaise: 14900 },
    { slug: `it-${tag}-coffee`, name: "Cold Coffee", pricePaise: 11900 },
    { slug: `it-${tag}-archived`, name: "Archived item", pricePaise: 100 },
    { slug: `it-${tag}-soldout`, name: "Sold out item", pricePaise: 100 },
  ];
}

/** Loopback only: this tool must never be pointed at a hosted project. */
export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1", "host.docker.internal"].includes(host);
  } catch {
    return false;
  }
}

/** The non-secret `host:port` of a URL, for messages. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    confirm: "",
    deleteUnreferenced: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--delete-unreferenced") options.deleteUnreferenced = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--confirm") options.confirm = argv[++i] ?? "";
    else if (arg?.startsWith("--confirm=")) options.confirm = arg.slice("--confirm=".length);
    else throw new Error(`Unknown argument: ${arg}. Use --help.`);
  }
  return options;
}

const ms = (iso) => Date.parse(iso);

/**
 * Pure: decides what would be done, from rows already read. Nothing here can write.
 * @param {object} data  see core.d.mts (PlanInput)
 */
export function buildPlan(data) {
  const { categories, items, tables, groups, orderRefs, attemptRefs } = data;
  const tableOrderRefs = data.tableOrderRefs ?? {};
  const tableAttemptRefs = data.tableAttemptRefs ?? {};
  const deleteUnreferenced = Boolean(data.deleteUnreferenced);
  const candidates = [];
  const skipped = [];

  for (const category of [...categories].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const skip = (reason) =>
      skipped.push({ id: category.id, slug: category.slug, name: category.name, reason });

    const match = CATEGORY_SLUG.exec(category.slug);
    const tag = match?.[1];
    if (!tag || category.name !== `IT ${tag} Category`) {
      skip("Looks like test data but is not the exact fixture pair (slug and name for one tag).");
      continue;
    }

    const own = items.filter((item) => item.categoryId === category.id);
    const known = fixtureItems(tag);
    const stranger = own.find(
      (item) =>
        !known.some(
          (f) => f.slug === item.slug && f.name === item.name && f.pricePaise === item.pricePaise,
        ),
    );
    if (stranger) {
      skip(
        `Contains an item that is not one of this run's fixtures ("${stranger.name}", slug ${stranger.slug}). Left untouched.`,
      );
      continue;
    }
    if (own.length === 0) {
      skip("Has no items, so nothing identifies it as a fixture. Left untouched.");
      continue;
    }

    const evidence = [];
    const table = tables.find(
      (t) => t.code === `IT${tag.toUpperCase()}` && t.label === `IT table ${tag}`,
    );
    const group = groups.find(
      (g) => g.slug === `it-${tag}-extras` && g.name === `IT ${tag} Extras`,
    );
    for (const [label, artefact] of [
      [`test table ${table?.code}`, table],
      [`modifier group ${group?.slug}`, group],
    ]) {
      if (
        artefact &&
        Math.abs(ms(artefact.createdAt) - ms(category.createdAt)) <= CORROBORATION_WINDOW_MS
      ) {
        evidence.push(`created by the same test run as ${label}`);
      }
    }
    if (evidence.length === 0) {
      skip(
        "No test table or modifier group from the same run was found, so it cannot be told apart from hand-made data. Left untouched.",
      );
      continue;
    }

    const planned = own
      .map((item) => {
        const orders = orderRefs[item.id] ?? 0;
        const pending = attemptRefs[item.id]?.pending ?? 0;
        const other = attemptRefs[item.id]?.other ?? 0;
        const unreferenced = orders === 0 && pending === 0 && other === 0;
        const action =
          deleteUnreferenced && unreferenced
            ? "delete"
            : item.isActive
              ? "archive"
              : "already-archived";
        return {
          id: item.id,
          slug: item.slug,
          name: item.name,
          pricePaise: item.pricePaise,
          isActive: item.isActive,
          isAvailable: item.isAvailable,
          orderRefs: orders,
          pendingAttempts: pending,
          otherAttempts: other,
          action,
        };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));

    const categoryAction = planned.every((item) => item.action === "delete")
      ? "delete"
      : category.isActive
        ? "archive"
        : "already-archived";

    candidates.push({
      category: { ...category },
      tag,
      evidence,
      items: planned,
      categoryAction,
    });
  }

  const tableCandidates = [];
  const skippedTables = [];
  for (const table of [...tables].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const skip = (reason) =>
      skippedTables.push({
        id: table.id,
        code: table.code,
        label: table.label,
        isActive: table.isActive,
        orderRefs: tableOrderRefs[table.id] ?? 0,
        reason,
      });
    const codeTag = TABLE_CODE.exec(table.code)?.[1]?.toLowerCase();
    const labelTag = TABLE_LABEL.exec(table.label)?.[1];
    if (!codeTag && !labelTag) {
      skip(
        "Neither the code (IT<6 hex digits>) nor the label (IT table <tag>) is the fixture pattern.",
      );
      continue;
    }
    if (!codeTag) {
      skip(
        "The label looks like a fixture (IT table <tag>) but the code is not IT<TAG>, so it was not created by the integration-test fixture generator.",
      );
      continue;
    }
    if (!labelTag) {
      skip(
        "The code looks like a fixture (IT<TAG>) but the label is not exactly `IT table <tag>`.",
      );
      continue;
    }
    if (codeTag !== labelTag) {
      skip(`Code tag (${codeTag}) and label tag (${labelTag}) differ.`);
      continue;
    }

    const tag = codeTag;
    const category = categories.find(
      (c) => c.slug === `it-${tag}-cat` && c.name === `IT ${tag} Category`,
    );
    const group = groups.find(
      (g) => g.slug === `it-${tag}-extras` && g.name === `IT ${tag} Extras`,
    );
    const near = (row) =>
      Boolean(row) && Math.abs(ms(row.createdAt) - ms(table.createdAt)) <= CORROBORATION_WINDOW_MS;
    const evidence = [];
    if (near(category)) evidence.push(`same-run category "IT ${tag} Category" exists`);
    if (near(group)) evidence.push(`same-run modifier group it-${tag}-extras exists`);
    if (evidence.length === 0) {
      skip(
        `No category "IT ${tag} Category" or modifier group it-${tag}-extras created by the same run was found, so it cannot be told apart from a hand-made table.`,
      );
      continue;
    }

    const orders = tableOrderRefs[table.id] ?? 0;
    const pending = tableAttemptRefs[table.id]?.pending ?? 0;
    const other = tableAttemptRefs[table.id]?.other ?? 0;
    const action = !table.isActive
      ? "already-inactive"
      : pending > 0
        ? "skip-unpaid-checkout"
        : "deactivate";
    tableCandidates.push({
      table: { ...table },
      tag,
      evidence,
      relatedCategory: Boolean(category),
      relatedGroup: Boolean(group),
      orderRefs: orders,
      pendingAttempts: pending,
      otherAttempts: other,
      action,
    });
  }

  const steps = candidates.flatMap((c) => [
    ...c.items.map((i) => `item:${i.id}:${i.action}`),
    `category:${c.category.id}:${c.categoryAction}`,
  ]);
  steps.push(...tableCandidates.map((t) => `table:${t.table.id}:${t.action}`));
  const token = createHash("sha256").update(steps.sort().join("\n")).digest("hex").slice(0, 10);

  const all = candidates.flatMap((c) => c.items);
  return {
    deleteUnreferenced,
    candidates,
    skipped,
    tableCandidates,
    skippedTables,
    token,
    totals: {
      categories: candidates.length,
      items: all.length,
      itemsWithOrderHistory: all.filter((i) => i.orderRefs > 0).length,
      itemsInUnpaidCheckout: all.filter((i) => i.pendingAttempts > 0).length,
      itemsToArchive: all.filter((i) => i.action === "archive").length,
      itemsToDelete: all.filter((i) => i.action === "delete").length,
      categoriesToArchive: candidates.filter((c) => c.categoryAction === "archive").length,
      categoriesToDelete: candidates.filter((c) => c.categoryAction === "delete").length,
      tables: tableCandidates.length,
      tablesWithOrderHistory: tableCandidates.filter((t) => t.orderRefs > 0).length,
      tablesToDeactivate: tableCandidates.filter((t) => t.action === "deactivate").length,
      tablesSkippedUnpaidCheckout: tableCandidates.filter(
        (t) => t.action === "skip-unpaid-checkout",
      ).length,
    },
  };
}

/** Reads everything the plan needs through `port` (read-only) and builds the plan. */
export async function collectPlan(port, options = {}) {
  const categories = await port.listCategories();
  const items = categories.length > 0 ? await port.listItems(categories.map((c) => c.id)) : [];
  const [tables, groups] = await Promise.all([port.listTables(), port.listGroups()]);
  const itemIds = items.map((i) => i.id);
  const orderRefs = itemIds.length > 0 ? await port.orderItemRefs(itemIds) : {};
  const attemptRefs = itemIds.length > 0 ? await port.attemptRefs(itemIds) : {};
  const tableIds = tables.map((t) => t.id);
  const tableOrderRefs = tableIds.length > 0 ? await port.tableOrderRefs(tableIds) : {};
  const tableAttemptRefs = tableIds.length > 0 ? await port.tableAttemptRefs(tableIds) : {};
  return buildPlan({
    categories,
    items,
    tables,
    groups,
    orderRefs,
    attemptRefs,
    tableOrderRefs,
    tableAttemptRefs,
    deleteUnreferenced: options.deleteUnreferenced,
  });
}

/**
 * Executes a plan after re-reading the database and checking that it still matches what was
 * previewed (`confirm` must equal the token printed by the preview). History is counted before and
 * after and the run is reported as failed if any history count moved.
 */
export async function applyPlan(port, options) {
  const plan = await collectPlan(port, { deleteUnreferenced: options.deleteUnreferenced });
  if (!options.confirm) {
    throw new Error(`--apply needs --confirm ${plan.token} (the token of the preview).`);
  }
  if (options.confirm !== plan.token) {
    throw new Error(
      "The confirmation token does not match the current data (it changed since the preview, " +
        "or the options differ). Nothing was changed. Run the preview again.",
    );
  }

  const before = await port.historyCounts();
  const results = [];
  const attempt = async (what, id, fn) => {
    try {
      await fn();
      results.push({ what, id, ok: true });
    } catch (error) {
      results.push({ what, id, ok: false, error: safeMessage(error) });
    }
  };

  for (const candidate of plan.candidates) {
    for (const item of candidate.items) {
      if (item.action === "archive") {
        await attempt(`archive item ${item.slug}`, item.id, () =>
          port.setItemActive(item.id, false),
        );
      } else if (item.action === "delete") {
        await attempt(`delete item ${item.slug}`, item.id, () => port.deleteItem(item.id));
      }
    }
    const category = candidate.category;
    if (candidate.categoryAction === "archive") {
      await attempt(`archive category ${category.slug}`, category.id, () =>
        port.setCategoryActive(category.id, false),
      );
    } else if (candidate.categoryAction === "delete") {
      await attempt(`delete category ${category.slug}`, category.id, () =>
        port.deleteCategory(category.id),
      );
    }
  }

  for (const candidate of plan.tableCandidates) {
    if (candidate.action === "deactivate") {
      await attempt(`deactivate table ${candidate.table.code}`, candidate.table.id, () =>
        port.setTableActive(candidate.table.id, false),
      );
    }
  }

  const after = await port.historyCounts();
  const historyUnchanged = Object.keys(before).every((key) => before[key] === after[key]);
  const remaining = await collectPlan(port, { deleteUnreferenced: options.deleteUnreferenced });
  return { plan, results, before, after, historyUnchanged, remaining };
}

function safeMessage(error) {
  const e = /** @type {{ code?: string, message?: string }} */ (error ?? {});
  return `${e.code ? `${e.code}: ` : ""}${String(e.message ?? error).slice(0, 160)}`;
}

const rupees = (paise) => `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;

/** Human-readable preview. Contains ids, names, prices and counts; never keys or customer data. */
export function formatPlan(plan, where) {
  const lines = [];
  lines.push(`Database: ${where} (local)`);
  lines.push(
    `Mode: ${plan.deleteUnreferenced ? "archive, and delete unreferenced records" : "archive only"}`,
  );
  lines.push("");
  if (plan.candidates.length === 0) lines.push("No test-fixture categories found.");
  for (const c of plan.candidates) {
    lines.push(`Category "${c.category.name}"  [${c.category.id}]  -> ${c.categoryAction}`);
    lines.push(`  evidence: slug ${c.category.slug}; ${c.evidence.join("; ")}`);
    for (const i of c.items) {
      lines.push(
        `  - ${i.name} ${rupees(i.pricePaise)} [${i.id}] active=${i.isActive}` +
          ` | order history: ${i.orderRefs} line(s) | unpaid checkout: ${i.pendingAttempts}` +
          ` | other attempts: ${i.otherAttempts} -> ${i.action}`,
      );
    }
  }
  if (plan.tableCandidates.length > 0) {
    lines.push("", "Test tables (match the integration-test fixture generator):");
    for (const t of plan.tableCandidates) {
      lines.push(
        `  - "${t.table.label}" code ${t.table.code} [${t.table.id}] active=${t.table.isActive}` +
          ` | fixture pattern: yes (code, label, ${t.evidence.join("; ")})` +
          ` | order history: ${t.orderRefs} order(s) | unpaid checkout: ${t.pendingAttempts}` +
          ` | other payment attempts: ${t.otherAttempts} -> ${t.action}`,
      );
      if (t.action === "skip-unpaid-checkout") {
        lines.push(
          "      skipped: an unpaid checkout still references this table; run again once it is no longer PENDING (paid or failed).",
        );
      }
    }
  }
  if (plan.skippedTables.length > 0) {
    lines.push("", "Tables that look similar but will NOT be touched:");
    for (const t of plan.skippedTables) {
      lines.push(
        `  - "${t.label}" code ${t.code} [${t.id}] active=${t.isActive} | order history: ${t.orderRefs} order(s): ${t.reason}`,
      );
    }
  }
  if (plan.skipped.length > 0) {
    lines.push("", "Looks similar but will NOT be touched:");
    for (const s of plan.skipped) lines.push(`  - "${s.name}" [${s.id}]: ${s.reason}`);
  }
  const t = plan.totals;
  lines.push(
    "",
    `Totals: ${t.categories} categories, ${t.items} items (${t.itemsWithOrderHistory} with order history, ` +
      `${t.itemsInUnpaidCheckout} in an unpaid checkout).`,
    `Would archive ${t.itemsToArchive} items and ${t.categoriesToArchive} categories; ` +
      `delete ${t.itemsToDelete} items and ${t.categoriesToDelete} categories.`,
    `Tables: ${t.tables} test tables (${t.tablesWithOrderHistory} with order history); would deactivate ` +
      `${t.tablesToDeactivate}, skip ${t.tablesSkippedUnpaidCheckout} with an unpaid checkout. Tables are never deleted.`,
    "Orders, order items, payment attempts and audit events are never modified.",
  );
  return lines.join("\n");
}
