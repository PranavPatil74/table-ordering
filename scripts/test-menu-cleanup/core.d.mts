export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}
export interface ItemRow {
  id: string;
  categoryId: string;
  slug: string;
  name: string;
  pricePaise: number;
  isActive: boolean;
  isAvailable: boolean;
}
export interface TableRow {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: string;
}
export interface GroupRow {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}
export type AttemptRefs = Record<string, { pending: number; other: number }>;

export interface PlanInput {
  categories: CategoryRow[];
  items: ItemRow[];
  tables: TableRow[];
  groups: GroupRow[];
  orderRefs: Record<string, number>;
  attemptRefs: AttemptRefs;
  /** Orders per table id (history), and payment attempts per table id split into unpaid/other. */
  tableOrderRefs?: Record<string, number>;
  tableAttemptRefs?: AttemptRefs;
  deleteUnreferenced?: boolean;
}

export type ItemAction = "archive" | "already-archived" | "delete";
export interface PlannedItem {
  id: string;
  slug: string;
  name: string;
  pricePaise: number;
  isActive: boolean;
  isAvailable: boolean;
  orderRefs: number;
  pendingAttempts: number;
  otherAttempts: number;
  action: ItemAction;
}
export interface Candidate {
  category: CategoryRow;
  tag: string;
  evidence: string[];
  items: PlannedItem[];
  categoryAction: ItemAction;
}
export type TableAction = "deactivate" | "already-inactive" | "skip-unpaid-checkout";
export interface TableCandidate {
  table: TableRow;
  tag: string;
  evidence: string[];
  relatedCategory: boolean;
  relatedGroup: boolean;
  orderRefs: number;
  pendingAttempts: number;
  otherAttempts: number;
  action: TableAction;
}
export interface SkippedTable {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  orderRefs: number;
  reason: string;
}
export interface Plan {
  deleteUnreferenced: boolean;
  candidates: Candidate[];
  skipped: { id: string; slug: string; name: string; reason: string }[];
  tableCandidates: TableCandidate[];
  skippedTables: SkippedTable[];
  token: string;
  totals: {
    categories: number;
    items: number;
    itemsWithOrderHistory: number;
    itemsInUnpaidCheckout: number;
    itemsToArchive: number;
    itemsToDelete: number;
    categoriesToArchive: number;
    categoriesToDelete: number;
    tables: number;
    tablesWithOrderHistory: number;
    tablesToDeactivate: number;
    tablesSkippedUnpaidCheckout: number;
  };
}

/** What a backend (PostgREST, PostgreSQL, an in-memory fake) must provide. Reads never write. */
export interface CleanupPort {
  listCategories(): Promise<CategoryRow[]>;
  listItems(categoryIds: string[]): Promise<ItemRow[]>;
  listTables(): Promise<TableRow[]>;
  listGroups(): Promise<GroupRow[]>;
  orderItemRefs(itemIds: string[]): Promise<Record<string, number>>;
  attemptRefs(itemIds: string[]): Promise<AttemptRefs>;
  tableOrderRefs(tableIds: string[]): Promise<Record<string, number>>;
  tableAttemptRefs(tableIds: string[]): Promise<AttemptRefs>;
  historyCounts(): Promise<Record<string, number>>;
  setItemActive(id: string, active: boolean): Promise<void>;
  setCategoryActive(id: string, active: boolean): Promise<void>;
  setTableActive(id: string, active: boolean): Promise<void>;
  deleteItem(id: string): Promise<void>;
  deleteCategory(id: string): Promise<void>;
}

export interface CliOptions {
  apply: boolean;
  confirm: string;
  deleteUnreferenced: boolean;
  json: boolean;
  help: boolean;
}

export interface ApplyResult {
  plan: Plan;
  results: { what: string; id: string; ok: boolean; error?: string }[];
  before: Record<string, number>;
  after: Record<string, number>;
  historyUnchanged: boolean;
  remaining: Plan;
}

export const TAG_PATTERN: RegExp;
export function fixtureItems(tag: string): { slug: string; name: string; pricePaise: number }[];
export function isLoopbackUrl(url: string): boolean;
export function hostOf(url: string): string;
export function parseArgs(argv: string[]): CliOptions;
export function buildPlan(data: PlanInput): Plan;
export function collectPlan(
  port: CleanupPort,
  options?: { deleteUnreferenced?: boolean },
): Promise<Plan>;
export function applyPlan(
  port: CleanupPort,
  options: { confirm: string; deleteUnreferenced?: boolean },
): Promise<ApplyResult>;
export function formatPlan(plan: Plan, where: string): string;
