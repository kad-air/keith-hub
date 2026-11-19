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
  const people = s.people.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const gifts = s.gifts.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return JSON.stringify({
    totalBudget: s.totalBudget,
    people: people.map((p) => ({ name: p.name, role: p.role || "", budget: num(p.budget) })),
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
