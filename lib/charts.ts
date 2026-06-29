import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";

// A single uploaded chord chart in the setlist. `content` is the raw chart
// text, stored and rendered verbatim — chord-over-lyric alignment depends on
// the original whitespace, so nothing reflows or trims it. Transposition and
// other transforms are deliberately deferred; v1 just stores + displays.
export type Chart = {
  id: string;
  title: string;
  artist: string | null;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ChartRow = {
  id: string;
  title: string;
  artist: string | null;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function rowToChart(row: ChartRow): Chart {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    content: row.content,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCharts(): Chart[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM charts ORDER BY sort_order ASC, created_at ASC`,
    )
    .all() as ChartRow[];
  return rows.map(rowToChart);
}

export function getChart(id: string): Chart | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM charts WHERE id = ?`).get(id) as
    | ChartRow
    | undefined;
  return row ? rowToChart(row) : null;
}

export type ChartInput = {
  title: string;
  artist?: string | null;
  content: string;
};

export function createChart(input: ChartInput): Chart {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  // New charts land at the end of the setlist.
  const maxRow = db
    .prepare(`SELECT MAX(sort_order) as m FROM charts`)
    .get() as { m: number | null };
  const sortOrder = (maxRow.m ?? -1) + 1;
  db.prepare(
    `INSERT INTO charts (id, title, artist, content, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title.trim(),
    input.artist?.trim() || null,
    input.content,
    sortOrder,
    now,
    now,
  );
  return getChart(id)!;
}

export function updateChart(id: string, input: ChartInput): Chart | null {
  const db = getDb();
  const existing = getChart(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE charts SET title = ?, artist = ?, content = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.title.trim(),
    input.artist?.trim() || null,
    input.content,
    new Date().toISOString(),
    id,
  );
  return getChart(id);
}

export function deleteChart(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM charts WHERE id = ?`).run(id);
}

// Rewrites sort_order to match the given id order. Ids not present are left
// untouched (shouldn't happen — the client always sends the full list).
export function reorderCharts(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare(`UPDATE charts SET sort_order = ? WHERE id = ?`);
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((id, i) => stmt.run(i, id));
  });
  tx(ids);
}
