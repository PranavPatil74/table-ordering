/**
 * Server-side validation for menu administration. Pure: no network, no framework.
 *
 * Every Server Action parses its form with these schemas BEFORE touching the database, so the
 * browser's own checks (required, min, disabled buttons) are only a convenience. The limits mirror
 * the database constraints in supabase/migrations (the database is the last line of defence).
 *
 * Money: prices are typed as rupees ("249", "249.50"), converted to integer paise by string
 * arithmetic (src/lib/money.ts) and range-checked. No floating-point money anywhere.
 */
import { z } from "zod";

import { parseRupeesToPaise } from "@/lib/money";

export const DIETARY_TAGS = [
  "veg",
  "vegan",
  "egg",
  "non-veg",
  "spicy",
  "contains-dairy",
  "contains-gluten",
  "contains-nuts",
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

export const DIETARY_TAG_LABELS: Record<DietaryTag, string> = {
  veg: "Vegetarian",
  vegan: "Vegan",
  egg: "Contains egg",
  "non-veg": "Non-vegetarian",
  spicy: "Spicy",
  "contains-dairy": "Contains dairy",
  "contains-gluten": "Contains gluten",
  "contains-nuts": "Contains nuts",
};

/** Database limits (menu_items_price_paise_range, modifier_options_price_delta_range, ...). */
export const LIMITS = {
  name: 80,
  text: 500,
  itemPricePaise: 10_000_000,
  optionPricePaise: 1_000_000,
  maxSelectCap: 20,
} as const;

/** First message per field, keyed by field name. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string> };

export function parse<S extends z.ZodType>(schema: S, input: unknown): Parsed<z.output<S>> {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, errors: fieldErrors(result.error) };
}

/** Collapses runs of whitespace and trims, so "  Club   Sandwich " is "Club Sandwich". */
const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();

const nameField = (label: string) =>
  z
    .string(`${label} is required.`)
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(LIMITS.name, `${label} can be at most ${LIMITS.name} characters.`),
    );

/** Optional free text: blank becomes null; length-limited. */
const optionalText = (label: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(LIMITS.text, `${label} can be at most ${LIMITS.text} characters.`))
    .transform((value) => (value === "" ? null : value));

/** Rupees typed by a person -> integer paise, within [0, maxPaise]. */
function priceField(label: string, maxPaise: number) {
  return z.string(`${label} is required.`).transform((raw, ctx) => {
    const text = raw.trim().replace(/^₹\s*/, "");
    if (text === "") {
      ctx.addIssue({ code: "custom", message: `${label} is required.` });
      return z.NEVER;
    }
    let paise: number;
    try {
      paise = parseRupeesToPaise(text);
    } catch {
      ctx.addIssue({ code: "custom", message: `${label}: enter an amount like 249 or 249.50.` });
      return z.NEVER;
    }
    if (paise > maxPaise) {
      ctx.addIssue({
        code: "custom",
        message: `${label} can be at most ₹${(maxPaise / 100).toLocaleString("en-IN")}.`,
      });
      return z.NEVER;
    }
    return paise;
  });
}

const intField = (label: string, min: number, max: number) =>
  z
    .string(`${label} is required.`)
    .trim()
    .regex(/^\d{1,3}$/, `${label} must be a whole number from ${min} to ${max}.`)
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `${label} must be at least ${min}.`)
        .max(max, `${label} can be at most ${max}.`),
    );

const uuid = (label: string) => z.uuid(`${label} is not valid.`);

// ------------------------------------------------------------------------------------------

export const categorySchema = z.object({
  name: nameField("Name"),
  description: optionalText("Description"),
});
export type CategoryInput = z.output<typeof categorySchema>;

export const itemSchema = z.object({
  name: nameField("Name"),
  categoryId: uuid("Category"),
  description: optionalText("Description"),
  ingredients: optionalText("Ingredients"),
  dietaryTags: z
    .array(z.enum(DIETARY_TAGS, "Choose only the listed dietary tags."))
    .transform((tags) => [...new Set(tags)]),
  pricePaise: priceField("Price", LIMITS.itemPricePaise),
  isActive: z.boolean(),
  isAvailable: z.boolean(),
});
export type ItemInput = z.output<typeof itemSchema>;

export const groupSchema = z
  .object({
    name: nameField("Name"),
    minSelect: intField("Minimum choices", 0, LIMITS.maxSelectCap),
    maxSelect: intField("Maximum choices", 1, LIMITS.maxSelectCap),
    isActive: z.boolean(),
  })
  .refine((group) => group.maxSelect >= group.minSelect, {
    path: ["maxSelect"],
    message: "Maximum choices can't be lower than the minimum.",
  });
export type GroupInput = z.output<typeof groupSchema>;

export const optionSchema = z.object({
  name: nameField("Name"),
  priceDeltaPaise: priceField("Extra price", LIMITS.optionPricePaise),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  isAvailable: z.boolean(),
});
export type OptionInput = z.output<typeof optionSchema>;

export const idSchema = uuid("Id");

/** A URL-safe key that survives renames (matches the database's slug format). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "item" : slug;
}

export const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ------------------------------------------------------------------------------------------
// Modifier rules that span several rows (the database cannot express these)
// ------------------------------------------------------------------------------------------

export interface GroupRuleInput {
  minSelect: number;
  maxSelect: number;
  /** Options that customers can currently see (is_active). */
  activeOptions: number;
  /** Active options flagged as the pre-selected choice. */
  defaultOptions: number;
}

/**
 * A required group must be satisfiable, and defaults must fit the maximum, or customers would face
 * a menu they cannot complete. Returns plain-language problems (empty = fine).
 */
export function checkGroupRules(group: GroupRuleInput): string[] {
  const problems: string[] = [];
  if (group.minSelect > group.activeOptions) {
    problems.push(
      `This group needs at least ${group.minSelect} choice${group.minSelect === 1 ? "" : "s"} ` +
        `but would have only ${group.activeOptions} active option${group.activeOptions === 1 ? "" : "s"}.`,
    );
  }
  if (group.defaultOptions > group.maxSelect) {
    problems.push(
      `Only ${group.maxSelect} option${group.maxSelect === 1 ? " can" : "s can"} be pre-selected ` +
        `in this group, but ${group.defaultOptions} are marked as the default.`,
    );
  }
  return problems;
}
