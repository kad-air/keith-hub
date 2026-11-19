// The Christmas list's shared vocabulary — pure, imports nothing, so the
// client pages, the API routes and scripts/check-christmas.ts all read the
// same rules.

export const STATUSES = ["Idea", "Planned", "Ordered", "Purchased", "Wrapped"] as const;
export type Status = (typeof STATUSES)[number];
export const BOUGHT = new Set<string>(["Purchased", "Wrapped"]);

export type Person = { id: string; name: string; role: string; budget: number | null; order: number };
export type Gift = {
  id: string;
  recipient: string;
  group: string;
  idea: string;
  from: string;
  est: number | null;
  actual: number | null;
  status: string;
  notes: string;
  createdAt: number;
};
export type ListState = { rev: number; totalBudget: number | null; people: Person[]; gifts: Gift[] };

export const key = (s: unknown) => String(s ?? "").trim().toLowerCase();
export const slug = (s: unknown) =>
  key(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "p" + Date.now();

export function num(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

export function money(n: number | null | undefined): string {
  if (n == null) return "";
  const whole = Math.abs(n % 1) < 0.005;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/** Ids are client-made (a UUID for a gift, a name slug for a person). */
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** A money amount as the server will store it: finite, cents, sane size. */
export function cleanMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = num(v);
  if (n == null || Math.abs(n) > 10_000_000) return null;
  return Math.round(n * 100) / 100;
}

/** The list as the helper sees it, sent with every question. */
export function stateForHelper(s: Pick<ListState, "totalBudget" | "people" | "gifts">): string {
  const people = budgetPeople(s.people).sort((a, b) => (a.order || 0) - (b.order || 0));
  const gifts = s.gifts.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const totals = personTotals(people, gifts);
  const fam = familySplit(gifts);
  const r = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
  return JSON.stringify({
    totalBudget: s.totalBudget,
    family_split: {
      note: `Gifts for "${FAMILY}" are shared by the six core members; each carries an equal sixth of their cost.`,
      est: r(fam.est),
      spent: r(fam.spent),
      each_est: r(fam.eachEst),
      each_spent: r(fam.eachSpent),
    },
    people: people.map((p) => {
      const t = totals.get(p.id)!;
      return {
        name: p.name,
        role: p.role || "",
        core: isCore(p.id),
        budget: num(p.budget),
        own_spent: r(t.ownSpent),
        family_share_spent: r(t.familySpent),
        spent: r(t.spent),
        est: r(t.est),
        left: r(t.left),
      };
    }),
    gifts: gifts.map((g) => ({
      id: g.id,
      recipient: g.recipient || "",
      idea: g.idea || "",
      from: g.from || "",
      group: g.group || "",
      est: num(g.est),
      actual: num(g.actual),
      status: g.status || "Idea",
      notes: g.notes || "",
    })),
  });
}

// --- the family and its shared gifts -------------------------------------------------------

/**
 * The six of us. Seeded on first run, restored if ever missing, and never
 * removable (store.ts refuses). Ids are fixed so the split below never
 * depends on a name.
 */
export const CORE_PEOPLE = [
  { id: "keith", name: "Keith", role: "Dad" },
  { id: "kim", name: "Kim", role: "Mom" },
  { id: "addie", name: "Addie", role: "Age 14" },
  { id: "lydia", name: "Lydia", role: "Age 11" },
  { id: "scarlett", name: "Scarlett", role: "Age 9" },
  { id: "hudson", name: "Hudson", role: "Age 4" },
] as const;
export const CORE_IDS: ReadonlySet<string> = new Set(CORE_PEOPLE.map((p) => p.id));
export const isCore = (id: string) => CORE_IDS.has(id);

/** Gifts for "Family" are for all six of us, so their cost is split six ways. */
export const FAMILY = "Family";
export const isFamily = (name: unknown) => key(name) === key(FAMILY);

/**
 * The people who have budget lines. A "Family" budget line can't be made any
 * more, but one typed in before the split existed may still be in the
 * database: it is kept there untouched and simply left out, so its budget
 * isn't counted twice on top of the six who now carry Family's cost.
 */
export const budgetPeople = (people: Person[]) => people.filter((p) => !isFamily(p.name));

export type Totals = {
  /** The person's own gifts. */
  ownEst: number;
  ownSpent: number;
  /** Their equal share of the Family gifts (core members only; 0 for anyone else). */
  familyEst: number;
  familySpent: number;
  /** Own + share: what counts against their budget. */
  est: number;
  spent: number;
  budget: number | null;
  left: number | null;
};

/** The Family gifts' totals and each core member's share of them. */
export function familySplit(gifts: Gift[]) {
  let est = 0, spent = 0;
  for (const g of gifts) {
    if (!isFamily(g.recipient)) continue;
    est += num(g.est) || 0;
    spent += num(g.actual) || 0;
  }
  const n = CORE_PEOPLE.length;
  return { est, spent, members: n, eachEst: est / n, eachSpent: spent / n };
}

/**
 * Every person's numbers, the one place they are worked out (the page and the
 * helper both read these). A core member carries a sixth of the Family gifts;
 * anyone added by hand carries only their own.
 */
export function personTotals(people: Person[], gifts: Gift[]): Map<string, Totals> {
  const fam = familySplit(gifts);
  const out = new Map<string, Totals>();
  for (const p of people) {
    let ownEst = 0, ownSpent = 0;
    for (const g of gifts) {
      if (key(g.recipient) !== key(p.name)) continue;
      ownEst += num(g.est) || 0;
      ownSpent += num(g.actual) || 0;
    }
    const core = isCore(p.id);
    const familyEst = core ? fam.eachEst : 0;
    const familySpent = core ? fam.eachSpent : 0;
    const budget = num(p.budget);
    const spent = ownSpent + familySpent;
    out.set(p.id, {
      ownEst,
      ownSpent,
      familyEst,
      familySpent,
      est: ownEst + familyEst,
      spent,
      budget,
      left: budget == null ? null : budget - spent,
    });
  }
  return out;
}
