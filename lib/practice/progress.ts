import { getDb } from "@/lib/db";

// practice_progress has one row per completed day or learned lick. The
// composite item_id is "day:NN" or "lick:<slug>". No sessions table in v1;
// streak + totals derive from this.

export function markDone(itemId: string, now = new Date()): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO practice_progress (item_id, done_at)
     VALUES (?, ?)
     ON CONFLICT(item_id) DO UPDATE SET done_at = excluded.done_at`,
  ).run(itemId, now.toISOString());
}

export function unmarkDone(itemId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM practice_progress WHERE item_id = ?`).run(itemId);
}

export function isDone(itemId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM practice_progress WHERE item_id = ?`)
    .get(itemId);
  return Boolean(row);
}

export function getLearnedLickIds(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT item_id FROM practice_progress WHERE item_id LIKE 'lick:%'`,
    )
    .all() as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id.slice("lick:".length)));
}

export function getDoneDayIds(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT item_id FROM practice_progress WHERE item_id LIKE 'day:%'`,
    )
    .all() as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id.slice("day:".length)));
}

// Current streak: count of consecutive days (ending today) that have at least
// one day:* done row. Zero if today isn't done yet.
export function getStreak(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT date(done_at, 'localtime') as d
       FROM practice_progress
       WHERE item_id LIKE 'day:%'
       ORDER BY d DESC`,
    )
    .all() as { d: string }[];
  const days = rows.map((r) => r.d);
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < days.length; i++) {
    const expected = new Date(today);
    expected.setDate(today.getDate() - i);
    if (days[i] === expected.toISOString().slice(0, 10)) streak++;
    else break;
  }
  return streak;
}
