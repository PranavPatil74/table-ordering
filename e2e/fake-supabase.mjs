// @ts-check
/**
 * TEST DOUBLE, NOT SUPABASE.
 *
 * A tiny HTTP stand-in for the three Supabase endpoints the staff sign-in flow touches (GoTrue
 * password sign-in, refresh and user lookup, plus PostgREST's `staff_profiles`). It exists so the
 * Playwright browser tests can drive the real Next.js production build (cookies, proxy, redirects,
 * Server Actions) on a machine with no Docker.
 *
 * What it proves: the APP's behaviour for each response the real services can give.
 * What it does NOT prove: that real GoTrue/PostgREST/RLS behave this way. That is the job of
 * `pnpm test:supabase`, which talks to a real local stack.
 *
 * Everything below is a clearly fake fixture. Refresh tokens rotate and the old one is rejected
 * immediately (stricter than GoTrue's reuse window), so a double refresh bug would fail here.
 */
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54399);
const JWT_SECRET = "fake-supabase-jwt-secret-for-e2e-only";
const PASSWORD = "e2e-fixture-password";
const PUBLISHABLE_KEY = "e2e-fixture-publishable-key";
const SERVICE_KEY = "e2e-fixture-service-role-key";

/** email -> account. `profile: null` means a Supabase user with no staff profile. */
const USERS = {
  "counter@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000001",
    // The user can edit their own metadata in real Supabase, so the app must ignore it.
    metadata: { role: "manager" },
    profile: { display_name: "Casey Counter", role: "counter", is_active: true },
  },
  "manager@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000002",
    metadata: {},
    profile: { display_name: "Morgan Manager", role: "manager", is_active: true },
  },
  "inactive@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000003",
    metadata: {},
    profile: { display_name: "Ivy Inactive", role: "counter", is_active: false },
  },
  "noprofile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000004",
    metadata: { role: "manager" },
    profile: null,
  },
  // Session-refresh fixtures: the test rewrites the stored session so it looks about to expire.
  // One account per Playwright project, so parallel projects never share refresh counts.
  "refresh-mobile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000005",
    metadata: {},
    profile: { display_name: "Remy Refresh", role: "counter", is_active: true },
  },
  "refresh-desktop@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000010",
    metadata: {},
    profile: { display_name: "Remy Refresh", role: "counter", is_active: true },
  },
  // Profiles edited DURING a test through /__stub/profile (one account per Playwright project, so
  // parallel projects never touch each other's state).
  "toggle-mobile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000008",
    metadata: {},
    profile: { display_name: "Tia Toggle", role: "manager", is_active: true },
  },
  "toggle-desktop@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000009",
    metadata: {},
    profile: { display_name: "Tia Toggle", role: "manager", is_active: true },
  },
  // Phase 4 staff-management fixtures. One TARGET account per Playwright project, so a deactivation
  // in one project never touches the other's.
  "target-mobile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000011",
    metadata: {},
    profile: { display_name: "Tara Mobile", role: "counter", is_active: true },
  },
  "target-desktop@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000012",
    metadata: {},
    profile: { display_name: "Tara Desktop", role: "counter", is_active: true },
  },
  // A second target per project for the "someone else changed it first" test, which runs in
  // parallel with the deactivation test and must not share state with it.
  "race-mobile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000014",
    metadata: {},
    profile: { display_name: "Rhea Mobile", role: "counter", is_active: true },
  },
  "race-desktop@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000015",
    metadata: {},
    profile: { display_name: "Rhea Desktop", role: "counter", is_active: true },
  },
  // A third target per project, for the direct-Server-Action replay test.
  "probe-mobile@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000016",
    metadata: {},
    profile: { display_name: "Pia Mobile", role: "counter", is_active: true },
  },
  "probe-desktop@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000017",
    metadata: {},
    profile: { display_name: "Pia Desktop", role: "counter", is_active: true },
  },
  // A staff profile whose Auth e-mail cannot be loaded: the directory must say so, not fail.
  "ghost@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000013",
    metadata: {},
    profile: { display_name: "Gina Ghost", role: "counter", is_active: true },
    noEmail: true,
  },
  // Failure fixtures: the Auth server rate-limits, or is down, for this one address only.
  "limited@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000006",
    metadata: {},
    profile: null,
    fail: 429,
  },
  "outage@sandwich-express.test": {
    id: "00000000-0000-4000-8000-000000000007",
    metadata: {},
    profile: null,
    fail: 503,
  },
};

/** @type {Map<string, { email: string, sessionId: string, revoked: boolean }>} */
const refreshTokens = new Map();
/** @type {Map<string, { revoked: boolean }>} */
const sessions = new Map();
/** @type {Map<string, number>} */
const rateHits = new Map();
/** Phase 5: saved checkouts by idempotency key (emulates public.payment_attempts). */
const checkoutAttempts = new Map();
const createdAt = (user) => user.created ?? "2026-01-15T09:00:00Z";
/** @type {Record<string, number>} */
const stats = {};
/** Requests from the app (anything that is not a /__stub/ call). The E2E preflight uses this to prove the app talks to THIS server. */
let appRequests = 0;
const bump = (key) => (stats[key] = (stats[key] ?? 0) + 1);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signJwt(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function verifyJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  if (expected !== parts[2]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp * 1000 < Date.now()) return null;
    if (sessions.get(payload.session_id)?.revoked !== false) return null; // unknown or revoked
    return payload;
  } catch {
    return null;
  }
}

function userJson(email, user) {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"], ...user.metadata },
    user_metadata: user.metadata,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function issueSession(email, user, sessionId = randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  const session = sessions.get(sessionId) ?? { revoked: false };
  const expiresIn = 3600;
  sessions.set(sessionId, session);
  const refresh = `fake-refresh-${randomUUID()}`;
  refreshTokens.set(refresh, { email, sessionId, revoked: false });
  return {
    access_token: signJwt({
      iss: `http://127.0.0.1:${PORT}/auth/v1`,
      sub: user.id,
      aud: "authenticated",
      exp: now + expiresIn,
      iat: now,
      email,
      role: "authenticated",
      aal: "aal1",
      session_id: sessionId,
      app_metadata: { provider: "email", ...user.metadata },
      user_metadata: user.metadata,
      is_anonymous: false,
    }),
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: refresh,
    user: userJson(email, user),
  };
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const authError = (res, status, code, msg) =>
  send(res, status, { code: status, error_code: code, msg });

function bearer(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const emailOf = (payload) => payload.email;

/** Who is calling a REST endpoint: the service role, the anonymous role, a signed-in user, or garbage. */
function callerOf(req) {
  const token = bearer(req);
  if (token === SERVICE_KEY) return { kind: "service" };
  if (!token || token === PUBLISHABLE_KEY) return { kind: "anon" };
  const payload = verifyJwt(token);
  return payload ? { kind: "user", payload } : { kind: "invalid" };
}

// ---------------------------------------------------------------------------------------------
// Phase 3: an in-memory stand-in for the admin tables (cafe_tables and the menu tables).
//
// It implements only what the manager screens send through supabase-js: select with filters,
// order, single/maybeSingle; insert; update; delete. It also imitates the constraints and roles
// the real database enforces (unique names/slugs/codes, format and range checks, delete
// restrictions, counter limited to is_available), so the app's validation, error mapping and
// guards can be driven in a real browser. Real RLS and constraints are proven by `pnpm test:db`
// and `pnpm test:supabase`, not here.
// ---------------------------------------------------------------------------------------------
const lower = (value) => String(value ?? "").toLowerCase();
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** @type {Record<string, { columns: string[], defaults: Record<string, unknown>, rules: (row: any, rows: any[], all: Record<string, any[]>) => { code: string, message: string } | null }>} */
const ADMIN_TABLES = {
  cafe_settings: {
    columns: ["id", "cafe_name", "orders_enabled", "max_item_quantity", "max_items_per_order"],
    defaults: {},
    rules: () => null,
  },
  cafe_tables: {
    columns: ["id", "code", "label", "is_active", "sort_order"],
    defaults: { is_active: true, sort_order: 0 },
    rules: (row, rows) => {
      if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(row.code ?? ""))
        return {
          code: "23514",
          message: 'new row violates check constraint "cafe_tables_code_format"',
        };
      const label = String(row.label ?? "").trim();
      if (label.length < 1 || label.length > 40)
        return {
          code: "23514",
          message: 'new row violates check constraint "cafe_tables_label_length"',
        };
      if (rows.some((r) => r.id !== row.id && r.code === row.code))
        return {
          code: "23505",
          message: 'duplicate key value violates unique constraint "cafe_tables_code_unique"',
        };
      return null;
    },
  },
  menu_categories: {
    columns: ["id", "slug", "name", "description", "sort_order", "is_active"],
    defaults: { description: null, is_active: true, sort_order: 0 },
    rules: (row, rows) => {
      if (rows.some((r) => r.id !== row.id && r.slug === row.slug))
        return {
          code: "23505",
          message: 'duplicate key value violates unique constraint "menu_categories_slug_unique"',
        };
      if (rows.some((r) => r.id !== row.id && lower(r.name) === lower(row.name)))
        return {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "menu_categories_name_lower_unique"',
        };
      return null;
    },
  },
  menu_items: {
    columns: [
      "id",
      "category_id",
      "slug",
      "name",
      "description",
      "ingredients",
      "dietary_tags",
      "price_paise",
      "image_path",
      "sort_order",
      "is_active",
      "is_available",
    ],
    defaults: {
      description: null,
      ingredients: null,
      dietary_tags: [],
      image_path: null,
      is_active: true,
      is_available: true,
      sort_order: 0,
    },
    rules: (row, rows, all) => {
      if (!inRange(row.price_paise, 0, 10_000_000))
        return {
          code: "23514",
          message: 'new row violates check constraint "menu_items_price_paise_range"',
        };
      if (!all.menu_categories.some((c) => c.id === row.category_id))
        return {
          code: "23503",
          message: 'insert or update violates foreign key constraint "menu_items_category_id_fkey"',
        };
      if (rows.some((r) => r.id !== row.id && r.slug === row.slug))
        return {
          code: "23505",
          message: 'duplicate key value violates unique constraint "menu_items_slug_unique"',
        };
      if (
        rows.some(
          (r) =>
            r.id !== row.id &&
            r.category_id === row.category_id &&
            lower(r.name) === lower(row.name),
        )
      )
        return {
          code: "23505",
          message:
            'duplicate key value violates unique index "menu_items_category_name_lower_unique"',
        };
      return null;
    },
  },
  modifier_groups: {
    columns: ["id", "slug", "name", "min_select", "max_select", "sort_order", "is_active"],
    defaults: { min_select: 0, max_select: 1, is_active: true, sort_order: 0 },
    rules: (row, rows) => {
      if (!(
        inRange(row.min_select, 0, 20) &&
        inRange(row.max_select, 1, 20) &&
        row.max_select >= row.min_select
      ))
        return {
          code: "23514",
          message: 'new row violates check constraint "modifier_groups_select_bounds"',
        };
      if (rows.some((r) => r.id !== row.id && r.slug === row.slug))
        return {
          code: "23505",
          message: 'duplicate key value violates unique constraint "modifier_groups_slug_unique"',
        };
      if (rows.some((r) => r.id !== row.id && lower(r.name) === lower(row.name)))
        return {
          code: "23505",
          message: 'duplicate key value violates unique index "modifier_groups_name_lower_unique"',
        };
      return null;
    },
  },
  modifier_options: {
    columns: [
      "id",
      "group_id",
      "name",
      "price_delta_paise",
      "is_default",
      "sort_order",
      "is_active",
      "is_available",
    ],
    defaults: {
      price_delta_paise: 0,
      is_default: false,
      is_active: true,
      is_available: true,
      sort_order: 0,
    },
    rules: (row, rows, all) => {
      if (!inRange(row.price_delta_paise, 0, 1_000_000))
        return {
          code: "23514",
          message: 'new row violates check constraint "modifier_options_price_delta_range"',
        };
      if (!all.modifier_groups.some((g) => g.id === row.group_id))
        return {
          code: "23503",
          message:
            'insert or update violates foreign key constraint "modifier_options_group_id_fkey"',
        };
      if (
        rows.some(
          (r) =>
            r.id !== row.id && r.group_id === row.group_id && lower(r.name) === lower(row.name),
        )
      )
        return {
          code: "23505",
          message:
            'duplicate key value violates unique index "modifier_options_group_name_lower_unique"',
        };
      return null;
    },
  },
  menu_item_modifier_groups: {
    columns: ["item_id", "group_id", "sort_order"],
    defaults: { sort_order: 0 },
    rules: (row, rows) =>
      rows.some((r) => r !== row && r.item_id === row.item_id && r.group_id === row.group_id)
        ? {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "menu_item_modifier_groups_pkey"',
          }
        : null,
  },
};

/** @type {Record<string, any[]>} */
const DATA = Object.fromEntries(Object.keys(ADMIN_TABLES).map((name) => [name, []]));
const SEED_IDS = {
  category: "10000000-0000-4000-8000-000000000001",
  item: "10000000-0000-4000-8000-000000000002",
  table: "10000000-0000-4000-8000-000000000003",
  tableOff: "10000000-0000-4000-8000-000000000004",
};
DATA.cafe_settings.push({
  id: 1,
  cafe_name: "Sandwich Express",
  orders_enabled: true,
  max_item_quantity: 10,
  max_items_per_order: 30,
});
DATA.menu_categories.push({
  id: SEED_IDS.category,
  slug: "sandwiches",
  name: "Sandwiches",
  description: null,
  sort_order: 10,
  is_active: true,
});
DATA.menu_items.push({
  id: SEED_IDS.item,
  category_id: SEED_IDS.category,
  slug: "grilled-sandwich",
  name: "Grilled Sandwich",
  description: null,
  ingredients: null,
  dietary_tags: ["veg"],
  price_paise: 14900,
  image_path: null,
  sort_order: 10,
  is_active: true,
  is_available: true,
});
DATA.cafe_tables.push({
  id: SEED_IDS.table,
  code: "T01",
  label: "Table 1",
  is_active: true,
  sort_order: 10,
});
DATA.cafe_tables.push({
  id: SEED_IDS.tableOff,
  code: "T02",
  label: "Table 2",
  is_active: false,
  sort_order: 20,
});

const rls = (res, code = "42501", message = "new row violates row-level security policy") =>
  send(res, 403, { code, message });

/** PostgREST filter value -> predicate, for the few operators the app uses. */
function filterOf(url) {
  const tests = [];
  for (const [key, value] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (value.startsWith("eq.")) tests.push((row) => String(row[key]) === value.slice(3));
    else if (value.startsWith("in.(")) {
      const set = value
        .slice(4, -1)
        .split(",")
        .map((v) => v.replace(/^"|"$/g, ""));
      tests.push((row) => set.includes(String(row[key])));
    }
  }
  return (row) => tests.every((test) => test(row));
}

function project(row, select, columns) {
  const wanted = !select || select === "*" ? columns : select.split(",").map((c) => c.trim());
  return Object.fromEntries(wanted.map((c) => [c, row[c] ?? null]));
}

function sortRows(rows, url) {
  const orders = url.searchParams.getAll("order").flatMap((o) => o.split(","));
  return [...rows].sort((a, b) => {
    for (const spec of orders) {
      const [col, dir] = spec.split(".");
      const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

/** Rows the anonymous role can see (null = no privilege on the table at all). */
function publicRows(name) {
  const activeCategory = (id) => DATA.menu_categories.some((c) => c.id === id && c.is_active);
  const activeItem = (id) => DATA.menu_items.some((i) => i.id === id && i.is_active);
  const activeGroup = (id) => DATA.modifier_groups.some((g) => g.id === id && g.is_active);
  switch (name) {
    case "cafe_settings":
      return DATA.cafe_settings;
    case "menu_categories":
      return DATA.menu_categories.filter((c) => c.is_active);
    case "menu_items":
      return DATA.menu_items.filter((i) => i.is_active && activeCategory(i.category_id));
    case "modifier_groups":
      return DATA.modifier_groups.filter((g) => g.is_active);
    case "modifier_options":
      return DATA.modifier_options.filter((o) => o.is_active && activeGroup(o.group_id));
    case "menu_item_modifier_groups":
      return DATA.menu_item_modifier_groups.filter(
        (l) => activeItem(l.item_id) && activeGroup(l.group_id),
      );
    default:
      return null;
  }
}

async function handleAdminTable(req, res, url, name) {
  const spec = ADMIN_TABLES[name];
  const who = callerOf(req);
  if (who.kind === "invalid")
    return send(res, 401, { code: "42501", message: `permission denied for table ${name}` });
  bump(`rest:${req.method}:${name}`);

  // The service role bypasses row-level security (as in Supabase); users get their profile's role.
  const caller = who.payload ? USERS[emailOf(who.payload)]?.profile : undefined;
  const service = who.kind === "service";
  const staff =
    service ||
    Boolean(caller?.is_active && (caller.role === "manager" || caller.role === "counter"));
  const manager = service || Boolean(staff && caller.role === "manager");
  const wantsObject = (req.headers.accept ?? "").includes("vnd.pgrst.object+json");
  const wantsRows = (req.headers.prefer ?? "").includes("return=representation");
  const select = url.searchParams.get("select");
  const rows = DATA[name];

  const reply = (list, status = 200) => {
    const shaped = list.map((r) => project(r, select, spec.columns));
    if (wantsObject) {
      if (shaped.length !== 1)
        return send(res, 406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
        });
      return send(res, status, shaped[0]);
    }
    return send(res, status, shaped);
  };

  if (!staff) {
    // Public (anonymous or signed-in non-staff) access, as Phase 1's grants and policies give it:
    // active menu rows and the settings columns only; cafe_tables is not readable at all.
    if (req.method !== "GET") {
      return who.kind === "anon"
        ? send(res, 403, { code: "42501", message: `permission denied for table ${name}` })
        : send(res, 200, []);
    }
    const visible = publicRows(name);
    if (visible === null)
      return send(res, 403, { code: "42501", message: `permission denied for table ${name}` });
    return reply(sortRows(visible.filter(filterOf(url)), url));
  }

  if (req.method === "GET") {
    const matching = sortRows(rows.filter(filterOf(url)), url);
    return reply(matching);
  }

  if (req.method === "POST") {
    if (!manager) return rls(res);
    const body = await readJson(req);
    const incoming = Array.isArray(body) ? body : [body];
    const created = [];
    for (const input of incoming) {
      const row = { ...spec.defaults, ...input };
      if (spec.columns.includes("id") && !row.id) row.id = randomUUID();
      const problem = spec.rules(row, rows, DATA);
      if (problem) return send(res, problem.code === "23505" ? 409 : 400, problem);
      rows.push(row);
      created.push(row);
    }
    return wantsRows ? reply(created, 201) : (res.writeHead(201), res.end());
  }

  if (req.method === "PATCH") {
    const patch = await readJson(req);
    if (!manager) {
      // Phase 1: a counter may only change availability (guard trigger raises 42501 otherwise).
      const allowed = name === "menu_items" || name === "modifier_options";
      if (!allowed || Object.keys(patch).some((key) => key !== "is_available")) return rls(res);
    }
    const targets = rows.filter(filterOf(url));
    for (const row of targets) {
      const next = { ...row, ...patch };
      const problem = spec.rules(next, rows, DATA);
      if (problem) return send(res, problem.code === "23505" ? 409 : 400, problem);
    }
    for (const row of targets) Object.assign(row, patch);
    return wantsRows ? reply(targets) : (res.writeHead(204), res.end());
  }

  if (req.method === "DELETE") {
    if (!manager) return send(res, 200, []);
    const targets = rows.filter(filterOf(url));
    for (const row of targets) {
      if (name === "menu_categories" && DATA.menu_items.some((i) => i.category_id === row.id))
        return send(res, 409, {
          code: "23503",
          message:
            'update or delete on table "menu_categories" violates foreign key constraint "menu_items_category_id_fkey"',
        });
      if (name === "modifier_groups") {
        DATA.modifier_options = DATA.modifier_options.filter((o) => o.group_id !== row.id);
        DATA.menu_item_modifier_groups = DATA.menu_item_modifier_groups.filter(
          (l) => l.group_id !== row.id,
        );
      }
      if (name === "menu_items")
        DATA.menu_item_modifier_groups = DATA.menu_item_modifier_groups.filter(
          (l) => l.item_id !== row.id,
        );
    }
    DATA[name] = DATA[name].filter((r) => !targets.includes(r));
    return wantsRows ? reply(targets) : (res.writeHead(204), res.end());
  }

  return send(res, 405, { error: "method not allowed" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/__stub/health") return send(res, 200, { ok: true });
  if (path === "/__stub/traffic") return send(res, 200, { requests: appRequests });
  if (!path.startsWith("/__stub/")) appRequests += 1;
  if (path === "/__stub/stats") return send(res, 200, stats);
  if (path === "/__stub/profiles" && req.method === "GET") {
    // Read-only view of staff profiles for assertions (test double only).
    return send(
      res,
      200,
      Object.fromEntries(Object.entries(USERS).map(([email, u]) => [email, u.profile])),
    );
  }
  if (path === "/__stub/profile" && req.method === "POST") {
    // Edit a TOGGLE account's profile, the way an administrator would in the database.
    const email = String(url.searchParams.get("email") ?? "");
    const user = USERS[email];
    if (
      !(
        email.startsWith("toggle-") ||
        email.startsWith("target-") ||
        email.startsWith("race-") ||
        email.startsWith("probe-")
      ) ||
      !user?.profile
    )
      return send(res, 404, { error: "not a toggle or target account" });
    const role = url.searchParams.get("role");
    const active = url.searchParams.get("active");
    if (role === "counter" || role === "manager") user.profile.role = role;
    if (active === "0" || active === "1") user.profile.is_active = active === "1";
    return send(res, 200, user.profile);
  }

  if (path === "/auth/v1/health") return send(res, 200, { name: "fake-gotrue" });
  if (path === "/auth/v1/.well-known/jwks.json") return send(res, 200, { keys: [] });

  if (path === "/auth/v1/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    const body = await readJson(req);

    if (grant === "password") {
      const email = String(body.email ?? "").toLowerCase();
      const user = USERS[email];
      if (user?.fail === 429)
        return authError(res, 429, "over_request_rate_limit", "Request rate limit reached");
      if (user?.fail === 503)
        return authError(res, 503, "unexpected_failure", "Service unavailable");
      if (!user || body.password !== PASSWORD) {
        return authError(res, 400, "invalid_credentials", "Invalid login credentials");
      }
      bump(`login:${email}`);
      return send(res, 200, issueSession(email, user));
    }

    if (grant === "refresh_token") {
      const record = refreshTokens.get(String(body.refresh_token));
      if (record?.revoked) bump(`stale-refresh:${record.email}`); // a rotated token was reused
      if (!record || record.revoked || sessions.get(record.sessionId)?.revoked !== false) {
        return authError(
          res,
          400,
          "refresh_token_not_found",
          "Invalid Refresh Token: Refresh Token Not Found",
        );
      }
      record.revoked = true; // rotation: the old token dies immediately
      bump(`refresh:${record.email}`);
      return send(res, 200, issueSession(record.email, USERS[record.email], record.sessionId));
    }
    return authError(res, 400, "validation_failed", "unsupported grant_type");
  }

  if (path === "/auth/v1/user" && req.method === "GET") {
    const payload = verifyJwt(bearer(req));
    if (!payload) return authError(res, 401, "bad_jwt", "invalid JWT");
    bump(`user:${emailOf(payload)}`);
    return send(res, 200, userJson(emailOf(payload), USERS[emailOf(payload)]));
  }

  if (path === "/auth/v1/logout" && req.method === "POST") {
    const payload = verifyJwt(bearer(req));
    if (payload) {
      const session = sessions.get(payload.session_id);
      if (session) session.revoked = true;
      bump(`logout:${emailOf(payload)}`);
    }
    res.writeHead(204);
    return res.end();
  }

  // Auth admin API (service role only): the manager's staff directory reads e-mail addresses here.
  const adminUser = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(path)?.[1];
  if (adminUser && req.method === "GET") {
    if (bearer(req) !== SERVICE_KEY) return authError(res, 403, "not_admin", "User not allowed");
    bump("admin:getUserById");
    const entry = Object.entries(USERS).find(([, u]) => u.id === adminUser);
    if (!entry || entry[1].noEmail) return authError(res, 404, "user_not_found", "User not found");
    return send(res, 200, userJson(entry[0], entry[1]));
  }

  // Phase 5: public.create_checkout_attempt / get_checkout_attempt (service role only). A small
  // in-memory mirror of the database function: unique idempotency key, same-cart replay returns the
  // existing attempt, a different cart is a conflict, an inactive table is refused, the snapshot
  // total must equal the amount. It never creates an order and never marks an attempt paid.
  if (
    (path === "/rest/v1/rpc/create_checkout_attempt" ||
      path === "/rest/v1/rpc/get_checkout_attempt") &&
    req.method === "POST"
  ) {
    const fn = path.split("/").pop();
    if (bearer(req) !== SERVICE_KEY)
      return send(res, 403, { code: "42501", message: `permission denied for function ${fn}` });
    const body = await readJson(req);
    bump(`rpc:${fn}`);
    const row = (a, outcome) => ({
      ...(outcome ? { out_outcome: outcome } : {}),
      out_status: a.status,
      out_amount_paise: a.amount_paise,
      out_created_at: a.created_at,
      out_expires_at: a.expires_at,
      out_order_created: false,
      out_cart_snapshot: a.cart_snapshot,
    });
    if (fn === "get_checkout_attempt") {
      const found = checkoutAttempts.get(String(body.p_idempotency_key));
      return send(res, 200, found ? [row(found)] : []);
    }
    const key = String(body.p_idempotency_key ?? "");
    const snapshot = body.p_cart_snapshot;
    if (key.length < 16 || key.length > 128)
      return send(res, 400, { code: "22023", message: "invalid idempotency key" });
    if (snapshot?.table?.id !== body.p_table_id)
      return send(res, 400, {
        code: "23514",
        message: "snapshot table does not match the attempt table",
      });
    const sum = (snapshot.items ?? []).reduce(
      (t, i) =>
        t +
        (i.unit_price_paise + i.options.reduce((o, x) => o + x.price_delta_paise, 0)) * i.quantity,
      0,
    );
    if (
      sum !== snapshot.total_paise ||
      sum !== body.p_amount_paise ||
      !Number.isInteger(sum) ||
      sum < 100
    )
      return send(res, 400, { code: "23514", message: "Invalid cart snapshot: total mismatch" });
    const existing = checkoutAttempts.get(key);
    if (existing) {
      const same =
        existing.table_id === body.p_table_id &&
        existing.amount_paise === body.p_amount_paise &&
        JSON.stringify(existing.cart_snapshot) === JSON.stringify(snapshot);
      return send(res, 200, [same ? row(existing, "existing") : { out_outcome: "conflict" }]);
    }
    const table = DATA.cafe_tables.find((t) => t.id === body.p_table_id);
    if (!table || table.is_active !== true)
      return send(res, 200, [{ out_outcome: "table_unavailable" }]);
    const now = new Date();
    const attempt = {
      idempotency_key: key,
      table_id: body.p_table_id,
      amount_paise: body.p_amount_paise,
      status: "PENDING",
      cart_snapshot: snapshot,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (body.p_ttl_minutes ?? 30) * 60000).toISOString(),
    };
    checkoutAttempts.set(key, attempt);
    return send(res, 200, [row(attempt, "created")]);
  }
  // Test inspection only: how many attempts exist (the real database is inspected with SQL).
  if (path === "/__stub/attempts" && req.method === "GET") {
    return send(res, 200, {
      count: checkoutAttempts.size,
      attempts: [...checkoutAttempts.values()].map((a) => ({
        amount_paise: a.amount_paise,
        status: a.status,
        key: a.idempotency_key,
      })),
    });
  }

  // public.check_rate_limit (service role only), with the same fixed-window semantics.
  if (path === "/rest/v1/rpc/check_rate_limit" && req.method === "POST") {
    if (bearer(req) !== SERVICE_KEY)
      return send(res, 403, {
        code: "42501",
        message: "permission denied for function check_rate_limit",
      });
    const body = await readJson(req);
    const windowMs = Number(body.p_window_seconds) * 1000;
    if (!body.p_bucket || !(Number(body.p_limit) >= 1) || !(windowMs >= 1000))
      return send(res, 400, { code: "22023", message: "invalid rate limit parameters" });
    const key = `${body.p_bucket}@${Math.floor(Date.now() / windowMs)}`;
    const hits = (rateHits.get(key) ?? 0) + 1;
    rateHits.set(key, hits);
    bump("rpc:check_rate_limit");
    return send(res, 200, hits <= Number(body.p_limit));
  }

  // Test arrangement only (the real database has no such endpoints): add or change rows directly,
  // the way a seed script or an administrator in the SQL editor would.
  if (path === "/__stub/seed" && req.method === "POST") {
    const body = await readJson(req);
    if (!Object.hasOwn(ADMIN_TABLES, body.table)) return send(res, 404, { error: "unknown table" });
    for (const row of body.rows ?? []) {
      DATA[body.table].push({ ...ADMIN_TABLES[body.table].defaults, ...row });
    }
    return send(res, 200, { ok: true });
  }
  // Remove what a test seeded (its category with items, links, groups and options, and any table),
  // so a long run does not grow the shared in-memory menu that every other test also renders.
  if (path === "/__stub/unseed" && req.method === "POST") {
    const body = await readJson(req);
    if (body.categoryId) {
      const itemIds = DATA.menu_items
        .filter((i) => i.category_id === body.categoryId)
        .map((i) => i.id);
      const groupIds = new Set(
        DATA.menu_item_modifier_groups
          .filter((l) => itemIds.includes(l.item_id))
          .map((l) => l.group_id),
      );
      DATA.menu_item_modifier_groups = DATA.menu_item_modifier_groups.filter(
        (l) => !itemIds.includes(l.item_id),
      );
      DATA.modifier_options = DATA.modifier_options.filter((o) => !groupIds.has(o.group_id));
      DATA.modifier_groups = DATA.modifier_groups.filter((g) => !groupIds.has(g.id));
      DATA.menu_items = DATA.menu_items.filter((i) => i.category_id !== body.categoryId);
      DATA.menu_categories = DATA.menu_categories.filter((c) => c.id !== body.categoryId);
    }
    if (body.tableId) DATA.cafe_tables = DATA.cafe_tables.filter((t) => t.id !== body.tableId);
    return send(res, 200, { ok: true });
  }
  if (path === "/__stub/patch" && req.method === "POST") {
    const table = String(url.searchParams.get("table") ?? "");
    const id = String(url.searchParams.get("id") ?? "");
    if (!Object.hasOwn(ADMIN_TABLES, table)) return send(res, 404, { error: "unknown table" });
    const row = DATA[table].find((r) => String(r.id) === id);
    if (!row) return send(res, 404, { error: "no such row" });
    Object.assign(row, await readJson(req));
    return send(res, 200, row);
  }

  // staff_profiles updates (the manager's activate / deactivate). Imitates the Phase 1 policy
  // (managers only; counters match no rows), the column grant, and the last-manager trigger.
  if (path === "/rest/v1/staff_profiles" && req.method === "PATCH") {
    const who = callerOf(req);
    if (who.kind !== "user")
      return send(res, 403, {
        code: "42501",
        message: "permission denied for table staff_profiles",
      });
    bump("rest:PATCH:staff_profiles");
    const me = USERS[emailOf(who.payload)]?.profile;
    const patch = await readJson(req);
    if (Object.keys(patch).some((k) => !["display_name", "role", "is_active"].includes(k)))
      return send(res, 403, {
        code: "42501",
        message: "permission denied for table staff_profiles",
      });
    const isManager = me?.role === "manager" && me.is_active;
    const wantUser = url.searchParams.get("user_id")?.replace(/^eq\./, "");
    const wantActive = url.searchParams.get("is_active")?.replace(/^eq\./, "");
    const targets = isManager
      ? Object.values(USERS).filter(
          (u) =>
            u.profile &&
            (!wantUser || u.id === wantUser) &&
            (wantActive === undefined || String(u.profile.is_active) === wantActive),
        )
      : [];
    for (const target of targets) {
      const leaving =
        target.profile.role === "manager" &&
        target.profile.is_active &&
        ((patch.role && patch.role !== "manager") || patch.is_active === false);
      const another = Object.values(USERS).some(
        (u) => u !== target && u.profile?.role === "manager" && u.profile.is_active,
      );
      if (leaving && !another)
        return send(res, 400, {
          code: "23514",
          message: "At least one active manager must remain",
        });
    }
    for (const target of targets) Object.assign(target.profile, patch);
    const shaped = targets.map((u) => ({ user_id: u.id, ...u.profile, created_at: createdAt(u) }));
    if ((req.headers.prefer ?? "").includes("return=representation")) {
      if ((req.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
        if (shaped.length !== 1)
          return send(res, 406, {
            code: "PGRST116",
            details: `The result contains ${shaped.length} rows`,
            message: "JSON object requested, multiple (or no) rows returned",
          });
        return send(res, 200, shaped[0]);
      }
      return send(res, 200, shaped);
    }
    res.writeHead(204);
    return res.end();
  }

  const adminTable = /^\/rest\/v1\/(\w+)$/.exec(path)?.[1];
  if (adminTable && Object.hasOwn(ADMIN_TABLES, adminTable)) {
    return handleAdminTable(req, res, url, adminTable);
  }

  if (path === "/__stub/state") {
    // Read-only view for assertions: what the "database" holds (test double only).
    const table = String(url.searchParams.get("table") ?? "");
    return Object.hasOwn(DATA, table)
      ? send(res, 200, DATA[table])
      : send(res, 404, { error: "unknown table" });
  }

  if (path === "/rest/v1/staff_profiles" && req.method === "GET") {
    const payload = verifyJwt(bearer(req));
    // Phase 1: `anon` has no privileges on staff_profiles.
    if (!payload)
      return send(res, 401, {
        code: "42501",
        message: "permission denied for table staff_profiles",
      });
    bump(`profile:${emailOf(payload)}`);

    const caller = USERS[emailOf(payload)];
    const callerIsManager = caller.profile?.role === "manager" && caller.profile.is_active;
    // RLS: own row (even when inactive), or every row for an active manager.
    const rows = Object.values(USERS)
      .filter((u) => u.profile && (u.id === payload.sub || callerIsManager))
      .map((u) => ({ user_id: u.id, ...u.profile, created_at: createdAt(u) }));

    const wanted = url.searchParams.get("user_id");
    const filtered = wanted?.startsWith("eq.")
      ? rows.filter((r) => r.user_id === wanted.slice(3))
      : rows;

    if ((req.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
      if (filtered.length !== 1)
        return send(res, 406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
        });
      return send(res, 200, filtered[0]);
    }
    return send(res, 200, filtered);
  }

  return send(res, 404, { error: "not implemented by the fake" });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake Supabase (TEST DOUBLE) listening on http://127.0.0.1:${PORT}\n`);
});
