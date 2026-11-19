import { getDb } from "@/lib/db";
import {
  ID_RE,
  STATUSES,
  cleanMoney,
  num,
  type Gift,
  type ListState,
  type Person,
} from "@/lib/christmas/shared";

// The Christmas list's storage. Every write runs in one transaction that also
// bumps `christmas_rev`, which is what the page polls for ("has anything
// changed since rev N?") so the other parent's edits appear without a reload.
// Every value is validated here, whatever the client did first: strings are
// trimmed and capped, money is a finite cents value or null, status is one of
// the five, ids match ID_RE.

const KV_REV = "christmas_rev";
const KV_TOTAL = "christmas_total";
const KV_SEEDED = "christmas_seeded";

export class ChristmasInputError extends Error {}

type PersonRow = { id: string; name: string; role: string; budget: number | null; sort_order: number };
type GiftRow = {
  id: string;
  recipient: string;
  group_name: string;
  idea: string;
  from_name: string;
  est: number | null;
  actual: number | null;
  status: string;
  notes: string;
  created_at: number;
};

function kvGet(k: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(k) as { value: string } | undefined;
  return row ? row.value : null;
}
function kvSet(k: string, v: string) {
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
}
function kvDel(k: string) {
  getDb().prepare("DELETE FROM kv WHERE key = ?").run(k);
}

function currentRev(): number {
  return Number(kvGet(KV_REV) ?? 0) || 0;
}

/** Run a write and bump the revision in the same transaction. */
function writeTx(fn: () => void): number {
  const db = getDb();
  let rev = 0;
  db.transaction(() => {
    fn();
    rev = currentRev() + 1;
    kvSet(KV_REV, String(rev));
  })();
  return rev;
}

// --- first run -----------------------------------------------------------------

const SEED_PEOPLE: [string, string][] = [
  ["Keith", "Dad"],
  ["Kim", "Mom"],
  ["Addie", "Age 14"],
  ["Lydia", "Age 11"],
  ["Scarlett", "Age 9"],
  ["Hudson", "Age 4"],
];

/**
 * Seeds the list once, ever. The flag (not an empty table) decides, so a list
 * someone has cleared out by hand is never re-filled behind their back.
 */
export function ensureSeeded() {
  if (kvGet(KV_SEEDED)) return;
  const db = getDb();
  db.transaction(() => {
    if (kvGet(KV_SEEDED)) return;
    const insP = db.prepare("INSERT OR IGNORE INTO xmas_people (id, name, role, budget, sort_order) VALUES (?, ?, ?, ?, ?)");
    SEED_PEOPLE.forEach(([name, role], i) => insP.run(name.toLowerCase(), name, role, 370, i + 1));
    const insG = db.prepare(
      "INSERT OR IGNORE INTO xmas_gifts (id, recipient, group_name, idea, from_name, est, actual, status, notes, created_at) VALUES (?, 'Family', '', ?, 'Parents', ?, NULL, 'Idea', '', ?)",
    );
    const now = Date.now();
    insG.run("seed-get-out-pass", "Get Out Pass", 720, now);
    insG.run("seed-game-table", "Game table", 200, now + 1);
    kvSet(KV_TOTAL, "2520");
    kvSet(KV_SEEDED, new Date().toISOString());
    kvSet(KV_REV, String(currentRev() + 1));
  })();
}

// --- reads ---------------------------------------------------------------------

export function getRev(): number {
  ensureSeeded();
  return currentRev();
}

export function getListState(): ListState {
  ensureSeeded();
  const db = getDb();
  const people = (db.prepare("SELECT * FROM xmas_people ORDER BY sort_order, name").all() as PersonRow[]).map(
    (r): Person => ({ id: r.id, name: r.name, role: r.role, budget: r.budget, order: r.sort_order }),
  );
  const gifts = (db.prepare("SELECT * FROM xmas_gifts ORDER BY created_at").all() as GiftRow[]).map(
    (r): Gift => ({
      id: r.id,
      recipient: r.recipient,
      group: r.group_name,
      idea: r.idea,
      from: r.from_name,
      est: r.est,
      actual: r.actual,
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at,
    }),
  );
  const t = kvGet(KV_TOTAL);
  return { rev: currentRev(), totalBudget: t == null ? null : num(t), people, gifts };
}

// --- validation ------------------------------------------------------------------

export function checkId(id: string): string {
  if (!ID_RE.test(id)) throw new ChristmasInputError("Bad id.");
  return id;
}

function str(v: unknown, max: number, field: string): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new ChristmasInputError(`${field} must be text.`);
  return v.trim().slice(0, max);
}

function money(v: unknown, field: string): number | null {
  if (v == null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") throw new ChristmasInputError(`${field} must be a number.`);
  const n = cleanMoney(v);
  if (n == null) throw new ChristmasInputError(`${field} must be a number.`);
  return n;
}

function status(v: unknown): string {
  const s = STATUSES.find((x) => x === v);
  if (!s) throw new ChristmasInputError(`status must be one of ${STATUSES.join(", ")}.`);
  return s;
}

const GIFT_FIELDS: Record<string, (v: unknown) => [string, unknown]> = {
  recipient: (v) => ["recipient", str(v, 120, "recipient")],
  group: (v) => ["group_name", str(v, 120, "group")],
  idea: (v) => ["idea", str(v, 400, "idea")],
  from: (v) => ["from_name", str(v, 120, "from")],
  notes: (v) => ["notes", str(v, 1000, "notes")],
  est: (v) => ["est", money(v, "est")],
  actual: (v) => ["actual", money(v, "actual")],
  status: (v) => ["status", status(v)],
};

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChristmasInputError("Expected an object.");
  return body as Record<string, unknown>;
}

// --- gifts -------------------------------------------------------------------------

/** Create or wholly replace a gift (the original's ref.set). */
export function setGift(id: string, body: unknown): number {
  checkId(id);
  const o = asObject(body);
  const cols: Record<string, unknown> = {
    recipient: "", group_name: "", idea: "", from_name: "", notes: "", est: null, actual: null, status: "Idea",
  };
  for (const [k, fn] of Object.entries(GIFT_FIELDS)) {
    if (k in o && !(k === "status" && o[k] == null)) {
      const [c, v] = fn(o[k]);
      cols[c] = v;
    }
  }
  const created = Number.isSafeInteger(o.createdAt) && (o.createdAt as number) > 0 ? (o.createdAt as number) : Date.now();
  return writeTx(() => {
    getDb()
      .prepare(
        `INSERT INTO xmas_gifts (id, recipient, group_name, idea, from_name, est, actual, status, notes, created_at)
         VALUES (@id, @recipient, @group_name, @idea, @from_name, @est, @actual, @status, @notes, @created_at)
         ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient, group_name=excluded.group_name, idea=excluded.idea,
           from_name=excluded.from_name, est=excluded.est, actual=excluded.actual, status=excluded.status,
           notes=excluded.notes, created_at=excluded.created_at`,
      )
      .run({ id, ...cols, created_at: created });
  });
}

/** Change some fields of an existing gift (the original's ref.update). */
export function updateGift(id: string, body: unknown): number | null {
  checkId(id);
  const o = asObject(body);
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id };
  for (const [k, fn] of Object.entries(GIFT_FIELDS)) {
    if (!(k in o)) continue;
    const [c, v] = fn(o[k]);
    sets.push(`${c} = @${c}`);
    vals[c] = v;
  }
  if (!sets.length) throw new ChristmasInputError("Nothing to change.");
  const exists = getDb().prepare("SELECT 1 FROM xmas_gifts WHERE id = ?").get(id);
  if (!exists) return null;
  return writeTx(() => {
    getDb().prepare(`UPDATE xmas_gifts SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  });
}

export function deleteGift(id: string): number {
  checkId(id);
  return writeTx(() => {
    getDb().prepare("DELETE FROM xmas_gifts WHERE id = ?").run(id);
  });
}

// --- people ------------------------------------------------------------------------

function personCols(o: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  if (!partial || "name" in o) {
    const name = str(o.name, 60, "name");
    if (!name) throw new ChristmasInputError("A person needs a name.");
    cols.name = name;
  }
  if (!partial || "role" in o) cols.role = str(o.role, 60, "role");
  if (!partial || "budget" in o) cols.budget = money(o.budget, "budget");
  if (!partial || "order" in o) {
    const n = num(o.order);
    cols.sort_order = n == null ? 0 : n;
  }
  return cols;
}

export function setPerson(id: string, body: unknown): number {
  checkId(id);
  const cols = personCols(asObject(body), false);
  return writeTx(() => {
    getDb()
      .prepare(
        `INSERT INTO xmas_people (id, name, role, budget, sort_order) VALUES (@id, @name, @role, @budget, @sort_order)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, budget=excluded.budget, sort_order=excluded.sort_order`,
      )
      .run({ id, ...cols });
  });
}

export function updatePerson(id: string, body: unknown): number | null {
  checkId(id);
  const cols = personCols(asObject(body), true);
  const keys = Object.keys(cols);
  if (!keys.length) throw new ChristmasInputError("Nothing to change.");
  if (!getDb().prepare("SELECT 1 FROM xmas_people WHERE id = ?").get(id)) return null;
  return writeTx(() => {
    getDb().prepare(`UPDATE xmas_people SET ${keys.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ id, ...cols });
  });
}

export function deletePerson(id: string): number {
  checkId(id);
  return writeTx(() => {
    getDb().prepare("DELETE FROM xmas_people WHERE id = ?").run(id);
  });
}

// --- the total -----------------------------------------------------------------------

export function setTotalBudget(body: unknown): number {
  const o = asObject(body);
  const n = money(o.totalBudget, "totalBudget");
  return writeTx(() => {
    if (n == null) kvDel(KV_TOTAL);
    else kvSet(KV_TOTAL, String(n));
  });
}

export function clearTotalBudget(): number {
  return writeTx(() => kvDel(KV_TOTAL));
}

// --- the helper's daily allowance ----------------------------------------------------

/**
 * A durable cap on helper calls per (UTC) day, across everyone, kept in kv so
 * a restart doesn't reset it. Returns false once the day's allowance is spent.
 */
export function takeHelperAllowance(dailyCap: number, now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  const k = `christmas_helper_day:${day}`;
  const db = getDb();
  let ok = false;
  db.transaction(() => {
    const used = Number(kvGet(k) ?? 0) || 0;
    if (used >= dailyCap) return;
    kvSet(k, String(used + 1));
    ok = true;
  })();
  db.prepare("DELETE FROM kv WHERE key LIKE 'christmas_helper_day:%' AND key < ?").run(k);
  return ok;
}
