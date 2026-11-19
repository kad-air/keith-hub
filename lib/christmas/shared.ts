// The Christmas list's shared vocabulary — pure, imports nothing, so the
// client page, the API routes and scripts/check-christmas.ts all read the same
// rules. Ported from the original artifact (christmas-list.html); the helper's
// RULES text is that page's, word for word, apart from the platform remarks.

export const STATUSES = ["Idea", "Planned", "Ordered", "Purchased", "Wrapped"] as const;
export type Status = (typeof STATUSES)[number];
export const BOUGHT = new Set<string>(["Purchased", "Wrapped"]);

/** The six things the helper may ask for. Nothing else is ever applied. */
export const HELPER_OPS = [
  "add_gift",
  "update_gift",
  "delete_gift",
  "set_budget",
  "remove_person",
  "set_total_budget",
] as const;

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

/**
 * The helper's op fields, exactly the original's cleanGift: strings trimmed and
 * capped at 400, numbers parsed (null clears), status matched case-blind.
 */
export function cleanGift(o: Record<string, unknown>): Partial<Gift> {
  const out: Record<string, unknown> = {};
  for (const f of ["recipient", "idea", "from", "group", "notes"]) {
    if (typeof o[f] === "string") out[f] = (o[f] as string).trim().slice(0, 400);
  }
  for (const f of ["est", "actual"]) if (f in o) out[f] = o[f] == null ? null : num(o[f]);
  if (typeof o.status === "string") {
    const s = STATUSES.find((x) => key(x) === key(o.status));
    if (s) out.status = s;
  }
  return out as Partial<Gift>;
}

export const RULES = [
  "You are the list helper built into a family's shared Christmas gift list and budget page. Two parents use it together.",
  "You can change CONTENT and BUDGETS only, by returning operations. You cannot change how the page works or looks; if asked for that, say it needs a change to the page itself and return no ops.",
  "Each request includes the full current list as JSON. Answer questions from it. Do the arithmetic carefully.",
  'Reply with ONLY one JSON object: {"reply": string, "ops": array}. reply is short, plain text, friendly, no markdown. ops may be empty.',
  "Allowed ops:",
  '{"op":"add_gift","recipient":string,"idea":string,"from"?:string,"group"?:string,"est"?:number,"actual"?:number,"status"?:"Idea"|"Planned"|"Ordered"|"Purchased"|"Wrapped","notes"?:string}',
  '{"op":"update_gift","id":string, ...any of recipient, idea, from, group, est, actual, status, notes} (use null to clear a number)',
  '{"op":"delete_gift","id":string}',
  '{"op":"set_budget","person":string,"budget":number|null,"role"?:string}  (creates the person if new)',
  '{"op":"remove_person","person":string}  (removes their budget line; their gifts stay)',
  '{"op":"set_total_budget","amount":number}',
  "Use exact gift ids from the JSON. Reuse existing recipient names exactly. Amounts are US dollars as plain numbers. Only delete when clearly asked. If a request is ambiguous, ask a short question in reply and return no ops.",
].join("\n");

/** The list as the helper sees it — the original's stateJSON, same shape. */
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

/**
 * Pull the {reply, ops} object out of the model's text. The model is told to
 * reply with JSON only; this also tolerates a ```json fence or a stray line
 * around it. Returns null when there is no usable object. Ops are filtered to
 * the six allowed names and capped at 40 — the client validates each one's
 * fields again before applying it, exactly as the original did.
 */
export function parseHelperReply(text: string): { reply: string; ops: Record<string, unknown>[] } | null {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1];
  let v = tryParse(t);
  if (v === undefined) {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) v = tryParse(t.slice(a, b + 1));
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { reply?: unknown; ops?: unknown };
  const reply = typeof o.reply === "string" && o.reply.trim() ? o.reply.trim().slice(0, 4000) : "Done.";
  const ops = (Array.isArray(o.ops) ? o.ops : [])
    .filter(
      (x): x is Record<string, unknown> =>
        !!x && typeof x === "object" && !Array.isArray(x) &&
        (HELPER_OPS as readonly string[]).includes(String((x as { op?: unknown }).op)),
    )
    .slice(0, 40);
  return { reply, ops };
}
