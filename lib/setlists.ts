import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { type Chart } from "@/lib/charts";

// A named, ordered collection of charts drawn from the library. Setlists
// reference library charts many-to-many (via the setlist_charts join), so the
// same chart can live in multiple setlists and editing a chart updates it
// everywhere. `offline` is the per-setlist opt-in for offline cache warming —
// only setlists with this flag set have their chart pages proactively warmed
// into the service worker cache (see app/charts/ChartsClient + app/sw.ts).
export type Setlist = {
  id: string;
  name: string;
  offline: boolean;
  createdAt: string;
  updatedAt: string;
  chartCount: number;
};

type SetlistRow = {
  id: string;
  name: string;
  offline: number;
  created_at: string;
  updated_at: string;
  chart_count: number;
};

function rowToSetlist(row: SetlistRow): Setlist {
  return {
    id: row.id,
    name: row.name,
    offline: row.offline === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chartCount: row.chart_count,
  };
}

// Shared SELECT that joins the per-setlist chart count so list/detail/mutate
// responses all carry it without a second round-trip.
const SETLIST_SELECT = `
  SELECT s.*, (
    SELECT COUNT(*) FROM setlist_charts sc WHERE sc.setlist_id = s.id
  ) AS chart_count
  FROM setlists s`;

export function listSetlists(): Setlist[] {
  const db = getDb();
  const rows = db
    .prepare(`${SETLIST_SELECT} ORDER BY s.created_at ASC`)
    .all() as SetlistRow[];
  return rows.map(rowToSetlist);
}

export function getSetlistMeta(id: string): Setlist | null {
  const db = getDb();
  const row = db.prepare(`${SETLIST_SELECT} WHERE s.id = ?`).get(id) as
    | SetlistRow
    | undefined;
  return row ? rowToSetlist(row) : null;
}

// A setlist plus its charts in performance order. The charts come from the
// library (`charts` table) joined through `setlist_charts`, so they carry the
// full Chart shape — the viewer and reorder UI need `content`, `updatedAt`, etc.
export function getSetlist(
  id: string,
): { setlist: Setlist; charts: Chart[] } | null {
  const db = getDb();
  const setlist = getSetlistMeta(id);
  if (!setlist) return null;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.artist, c.content, c.sort_order, c.created_at, c.updated_at
       FROM setlist_charts sc
       JOIN charts c ON c.id = sc.chart_id
       WHERE sc.setlist_id = ?
       ORDER BY sc.sort_order ASC`,
    )
    .all(id) as {
    id: string;
    title: string;
    artist: string | null;
    content: string;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }[];
  const charts: Chart[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    content: r.content,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  return { setlist, charts };
}

export function createSetlist(name: string): Setlist {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO setlists (id, name, offline, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(id, name.trim(), now, now);
  return getSetlistMeta(id)!;
}

export function renameSetlist(id: string, name: string): Setlist | null {
  const db = getDb();
  if (!getSetlistMeta(id)) return null;
  db.prepare(`UPDATE setlists SET name = ?, updated_at = ? WHERE id = ?`).run(
    name.trim(),
    new Date().toISOString(),
    id,
  );
  return getSetlistMeta(id);
}

export function setSetlistOffline(id: string, offline: boolean): Setlist | null {
  const db = getDb();
  if (!getSetlistMeta(id)) return null;
  db.prepare(
    `UPDATE setlists SET offline = ?, updated_at = ? WHERE id = ?`,
  ).run(offline ? 1 : 0, new Date().toISOString(), id);
  return getSetlistMeta(id);
}

export function deleteSetlist(id: string): void {
  const db = getDb();
  // setlist_charts rows cascade away via the FK.
  db.prepare(`DELETE FROM setlists WHERE id = ?`).run(id);
}

// Append a library chart to the end of a setlist. No-op if the chart is
// already a member (the composite PK + INSERT OR IGNORE). Returns false when
// the setlist or chart doesn't exist so the API can 404.
export function addChartToSetlist(setlistId: string, chartId: string): boolean {
  const db = getDb();
  if (!getSetlistMeta(setlistId)) return false;
  const chart = db.prepare(`SELECT 1 FROM charts WHERE id = ?`).get(chartId);
  if (!chart) return false;
  const maxRow = db
    .prepare(
      `SELECT MAX(sort_order) AS m FROM setlist_charts WHERE setlist_id = ?`,
    )
    .get(setlistId) as { m: number | null };
  const sortOrder = (maxRow.m ?? -1) + 1;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO setlist_charts (setlist_id, chart_id, sort_order)
       VALUES (?, ?, ?)`,
    )
    .run(setlistId, chartId, sortOrder);
  // Only bump updated_at on a real insert — a no-op re-add (chart already a
  // member; INSERT OR IGNORE reports changes=0) shouldn't touch the setlist.
  if (info.changes > 0) touch(setlistId);
  return true;
}

export function removeChartFromSetlist(
  setlistId: string,
  chartId: string,
): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM setlist_charts WHERE setlist_id = ? AND chart_id = ?`,
  ).run(setlistId, chartId);
  touch(setlistId);
}

// Rewrite a setlist's chart order to match the given id order. Mirrors
// reorderCharts in lib/charts.ts — ids not present are left untouched (the
// client always sends the full membership list).
export function reorderSetlist(setlistId: string, chartIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE setlist_charts SET sort_order = ? WHERE setlist_id = ? AND chart_id = ?`,
  );
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((chartId, i) => stmt.run(i, setlistId, chartId));
  });
  tx(chartIds);
  touch(setlistId);
}

// Offline-flagged setlists with their member charts (id + updatedAt), used to
// drive service-worker cache warming on the Charts library page. Only these
// setlists' charts are proactively cached for offline play. Including
// updatedAt lets the client key its warm guard on content, so editing a member
// chart re-warms the cache (otherwise the stale page would be served at a gig).
export function getOfflineSetlists(): {
  id: string;
  charts: { id: string; updatedAt: string }[];
}[] {
  const db = getDb();
  const setlists = db
    .prepare(`SELECT id FROM setlists WHERE offline = 1 ORDER BY created_at ASC`)
    .all() as { id: string }[];
  const chartsStmt = db.prepare(
    `SELECT c.id, c.updated_at
     FROM setlist_charts sc
     JOIN charts c ON c.id = sc.chart_id
     WHERE sc.setlist_id = ?
     ORDER BY sc.sort_order ASC`,
  );
  return setlists.map((s) => ({
    id: s.id,
    charts: (chartsStmt.all(s.id) as { id: string; updated_at: string }[]).map(
      (r) => ({ id: r.id, updatedAt: r.updated_at }),
    ),
  }));
}

// Bump updated_at on membership/order changes. (The offline-warm key folds
// each member chart's id+updatedAt, not the setlist's updatedAt, so re-warming
// is driven by chart content rather than this timestamp — this is just an
// honest "last modified" for the setlist.)
function touch(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE setlists SET updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}
